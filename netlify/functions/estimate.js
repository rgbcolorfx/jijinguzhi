function json(statusCode, payload) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify(payload)
  };
}

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Fund Estimator Netlify Function)' },
      signal: controller.signal
    });
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('上游数据源超时');
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new Error(`请求失败: ${res.status} ${res.statusText}`);
  }
  return res.text();
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
}

function parseFundGz(raw) {
  const match = raw.match(/jsonpgz\((\{.*\})\);?/s);
  if (!match) throw new Error('无法解析基金估值接口响应');
  return JSON.parse(match[1]);
}

function parseHoldings(raw) {
  const match = raw.match(/var\s+apidata\s*=\s*(\{[\s\S]*\});?/);
  if (!match) throw new Error('无法解析持仓接口响应');

  const objectLiteral = match[1];
  let data;
  try {
    data = JSON.parse(objectLiteral);
  } catch (_) {
    try {
      data = Function(`"use strict"; return (${objectLiteral});`)();
    } catch (err) {
      throw new Error(`持仓数据格式异常: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
  }

  const content = data.content || '';
  const tableMatch = content.match(/<table[\s\S]*?<\/table>/i);
  if (!tableMatch) return [];

  const rowMatches = tableMatch[0].match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const holdings = [];

  for (const row of rowMatches.slice(1)) {
    const tdMatches = row.match(/<td[\s\S]*?<\/td>/gi) || [];
    if (tdMatches.length < 4) continue;

    const cells = tdMatches.map(stripHtml);
    const codeCell = cells.find((cell) => /\d{5,6}/.test(cell)) || '';
    const codeDigits = (codeCell.match(/\d{5,6}/) || [''])[0];
    const code = codeDigits.length === 5 ? codeDigits.padStart(5, '0') : codeDigits;
    const upperCodeCell = codeCell.toUpperCase();
    const market = code.length === 5 || upperCodeCell.includes('HK') || upperCodeCell.includes('HKG')
      ? 'hk'
      : 'cn';
    const name = cells[2] || '';
    const weightCell = cells.find((cell) => cell.includes('%')) || '';
    const weight = Number(weightCell.replace('%', '').replace(/,/g, '').trim());

    const validCode = market === 'hk' ? /^\d{5}$/.test(code) : /^\d{6}$/.test(code);
    if (!validCode || Number.isNaN(weight)) continue;
    holdings.push({ code, market, name, weight });
  }

  return holdings;
}

function quoteKey(item) {
  return `${item.market}:${item.code}`;
}

function toExchangeCode(item) {
  if (item.market === 'hk') return `hk${item.code}`;
  if (/^(6|9)/.test(item.code)) return `sh${item.code}`;
  return `sz${item.code}`;
}

function toEastmoneySecid(item) {
  if (item.market === 'hk') return `116.${item.code}`;
  if (/^(6|9)/.test(item.code)) return `1.${item.code}`;
  return `0.${item.code}`;
}

async function fetchEastmoneyQuote(item) {
  const secid = toEastmoneySecid(item);
  const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f57,f58,f43,f60`;
  const raw = await fetchText(url);
  const payload = JSON.parse(raw);
  const data = payload && payload.data;
  if (!data) return null;

  const scale = item.market === 'hk' ? 1000 : 100;
  const price = Number(data.f43) / scale;
  const prevClose = Number(data.f60) / scale;
  if (!Number.isFinite(price) || !Number.isFinite(prevClose) || prevClose <= 0) return null;

  return {
    stockCode: item.code,
    market: item.market,
    symbol: secid,
    name: data.f58 || item.code,
    price,
    prevClose,
    changeRate: ((price / prevClose) - 1) * 100
  };
}

function parseTencentQuoteLine(line) {
  const codeMatch = line.match(/v_(sh|sz|hk)(\d{5,6})=/);
  const dataMatch = line.match(/="([\s\S]*?)";?/);
  if (!codeMatch || !dataMatch) return null;

  const symbol = `${codeMatch[1]}${codeMatch[2]}`;
  const fields = dataMatch[1].split('~');

  if (fields.length < 6) return null;

  const name = fields[1] || symbol;
  const price = Number(fields[3]);
  const prevClose = Number(fields[4]);
  if (!Number.isFinite(price) || !Number.isFinite(prevClose) || prevClose <= 0) return null;

  return {
    symbol,
    stockCode: codeMatch[2],
    market: codeMatch[1] === 'hk' ? 'hk' : 'cn',
    name,
    price,
    prevClose,
    changeRate: ((price / prevClose) - 1) * 100
  };
}

async function fetchQuotes(holdings) {
  if (!holdings.length) return {};

  const result = {};
  const uniqueItems = [];
  const seen = new Set();
  for (const item of holdings) {
    const key = quoteKey(item);
    if (!seen.has(key)) {
      seen.add(key);
      uniqueItems.push(item);
    }
  }

  await Promise.all(uniqueItems.map(async (item) => {
    try {
      const quote = await fetchEastmoneyQuote(item);
      if (quote) result[quoteKey(item)] = quote;
    } catch (_) {
      // ignore and fallback below
    }
  }));

  const missingItems = uniqueItems.filter((item) => !result[quoteKey(item)]);
  if (!missingItems.length) return result;

  const symbols = missingItems.map(toExchangeCode);
  const chunkSize = 60;
  for (let i = 0; i < symbols.length; i += chunkSize) {
    const chunk = symbols.slice(i, i + chunkSize);
    const url = `https://qt.gtimg.cn/q=${chunk.join(',')}`;
    const raw = await fetchText(url);
    const lines = raw.split(/\r?\n|;/).filter(Boolean);
    for (const line of lines) {
      const quote = parseTencentQuoteLine(line);
      if (quote) result[`${quote.market}:${quote.stockCode}`] = quote;
    }
  }

  return result;
}

async function estimateFund(code) {
  if (!/^\d{6}$/.test(code)) throw new Error('基金代码应为 6 位数字');

  const gzUrl = `https://fundgz.1234567.com.cn/js/${code}.js`;
  const holdingsUrl = `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${code}&topline=30&year=&month=`;

  const [gzRaw, holdingsRaw] = await Promise.all([fetchText(gzUrl), fetchText(holdingsUrl)]);
  const gz = parseFundGz(gzRaw);
  const holdings = parseHoldings(holdingsRaw);

  if (!holdings.length) {
    return {
      code,
      name: gz.name || code,
      navDate: gz.jzrq,
      previousNav: Number(gz.dwjz),
      estimatedNav: Number(gz.gsz),
      estimatedRate: Number(gz.gszzl),
      method: 'fallback_fundgz',
      holdings: []
    };
  }

  const quotes = await fetchQuotes(holdings);

  const enriched = holdings
    .map((h) => {
      const q = quotes[quoteKey(h)];
      if (!q) {
        return {
          ...h,
          price: null,
          prevClose: null,
          changeRate: null,
          contribution: 0,
          hasQuote: false
        };
      }
      const contribution = (h.weight / 100) * (q.changeRate / 100);
      return {
        ...h,
        price: q.price,
        prevClose: q.prevClose,
        changeRate: q.changeRate,
        contribution,
        hasQuote: true
      };
    })
    .sort((a, b) => b.weight - a.weight);

  const coveredWeight = enriched
    .filter((h) => h.hasQuote)
    .reduce((sum, h) => sum + h.weight, 0);

  const weightedReturn = enriched.reduce((sum, h) => sum + h.contribution, 0);
  const previousNav = Number(gz.dwjz);

  return {
    code,
    name: gz.name || code,
    navDate: gz.jzrq,
    previousNav,
    estimatedNav: previousNav * (1 + weightedReturn),
    estimatedRate: weightedReturn * 100,
    coveredWeight,
    method: 'holdings_realtime_estimation',
    holdings: enriched
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return {
        statusCode: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        },
        body: ''
      };
    }

    if (event.httpMethod !== 'GET') {
      return json(405, { ok: false, error: 'Method Not Allowed' });
    }

    const code = String((event.queryStringParameters && event.queryStringParameters.code) || '').trim();
    const data = await estimateFund(code);
    return json(200, { ok: true, data });
  } catch (err) {
    return json(400, {
      ok: false,
      error: err instanceof Error ? err.message : '未知错误'
    });
  }
};
