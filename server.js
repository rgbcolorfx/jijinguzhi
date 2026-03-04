const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const WEB_DIR = path.join(__dirname, 'web');
const CALIBRATION_FILE = path.join(__dirname, 'cache', 'fund-calibration.json');
let calibrationStore = null;

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  let res;
  try {
    res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Fund Estimator Demo)'
      },
      signal: controller.signal
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error('上游数据源超时');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) {
    throw new Error(`请求失败: ${res.status} ${res.statusText}`);
  }
  return res.text();
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

async function loadCalibrationStore() {
  if (calibrationStore) return calibrationStore;
  try {
    const raw = await fs.promises.readFile(CALIBRATION_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    calibrationStore = parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    calibrationStore = {};
  }
  return calibrationStore;
}

async function persistCalibrationStore() {
  if (!calibrationStore) return;
  await fs.promises.mkdir(path.dirname(CALIBRATION_FILE), { recursive: true });
  await fs.promises.writeFile(CALIBRATION_FILE, JSON.stringify(calibrationStore, null, 2), 'utf-8');
}

function getCalibrationEntry(store, fundCode) {
  const entry = store[fundCode];
  if (!entry || typeof entry !== 'object') {
    return { bias: 0, samples: 0, mae: 0, lastUpdated: '' };
  }
  return {
    bias: Number.isFinite(Number(entry.bias)) ? Number(entry.bias) : 0,
    samples: Number.isFinite(Number(entry.samples)) ? Number(entry.samples) : 0,
    mae: Number.isFinite(Number(entry.mae)) ? Number(entry.mae) : 0,
    lastUpdated: typeof entry.lastUpdated === 'string' ? entry.lastUpdated : ''
  };
}

function blendEstimatedRate(modelRate, fundgzRate, coveredWeight, entry) {
  if (!Number.isFinite(modelRate) && Number.isFinite(fundgzRate)) return { rate: fundgzRate, modelWeight: 0 };
  if (Number.isFinite(modelRate) && !Number.isFinite(fundgzRate)) return { rate: modelRate, modelWeight: 1 };
  if (!Number.isFinite(modelRate) && !Number.isFinite(fundgzRate)) return { rate: 0, modelWeight: 0 };

  const coverage = clamp((coveredWeight || 0) / 100, 0, 1);
  const baseModelWeight = 0.25 + 0.75 * coverage;
  const hasEnoughSamples = (entry.samples || 0) >= 5;
  const bias = hasEnoughSamples ? entry.bias : 0;
  const adjustedModelRate = modelRate + bias;
  const blendedRate = adjustedModelRate * baseModelWeight + fundgzRate * (1 - baseModelWeight);

  return {
    rate: blendedRate,
    modelWeight: baseModelWeight
  };
}

function updateCalibrationEntry(entry, diff, coveredWeight) {
  if (!Number.isFinite(diff)) return entry;
  const coverage = clamp((coveredWeight || 0) / 100, 0, 1);
  const lr = 0.08 + 0.24 * coverage;
  const nextBias = entry.bias * (1 - lr) + diff * lr;
  const nextSamples = entry.samples + 1;
  const maeLr = 0.1;
  const nextMae = entry.mae * (1 - maeLr) + Math.abs(diff) * maeLr;

  return {
    bias: nextBias,
    samples: nextSamples,
    mae: nextMae,
    lastUpdated: new Date().toISOString()
  };
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

  // Eastmoney returns different integer scales by market:
  // A-share usually 2 decimals, HK often 3 decimals.
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

  if (!Number.isFinite(price) || !Number.isFinite(prevClose) || prevClose <= 0) {
    return null;
  }

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
      // ignore and fallback to tencent below
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
      if (quote) {
        result[`${quote.market}:${quote.stockCode}`] = quote;
      }
    }
  }

  return result;
}

async function estimateFund(code) {
  if (!/^\d{6}$/.test(code)) {
    throw new Error('基金代码应为 6 位数字');
  }

  const gzUrl = `https://fundgz.1234567.com.cn/js/${code}.js`;
  const holdingsUrl = `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${code}&topline=30&year=&month=`;

  const [gzRaw, holdingsRaw] = await Promise.all([
    fetchText(gzUrl),
    fetchText(holdingsUrl)
  ]);

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
  const modelEstimatedRate = weightedReturn * 100;
  const modelEstimatedNav = previousNav * (1 + weightedReturn);
  const fundgzRate = Number(gz.gszzl);
  const fundgzNav = Number(gz.gsz);

  let entry = { bias: 0, samples: 0, mae: 0, lastUpdated: '' };
  let blendedRate = modelEstimatedRate;
  let modelWeight = 1;
  try {
    const store = await loadCalibrationStore();
    entry = getCalibrationEntry(store, code);
    const blended = blendEstimatedRate(modelEstimatedRate, fundgzRate, coveredWeight, entry);
    blendedRate = blended.rate;
    modelWeight = blended.modelWeight;

    const diff = fundgzRate - modelEstimatedRate;
    store[code] = updateCalibrationEntry(entry, diff, coveredWeight);
    calibrationStore = store;
    await persistCalibrationStore();
    entry = store[code];
  } catch (_) {
    // Calibration persistence failure should not break quote endpoint.
  }

  const estimatedRate = blendedRate;
  const estimatedNav = Number.isFinite(previousNav)
    ? previousNav * (1 + estimatedRate / 100)
    : modelEstimatedNav;

  return {
    code,
    name: gz.name || code,
    navDate: gz.jzrq,
    previousNav,
    estimatedNav,
    estimatedRate,
    coveredWeight,
    method: 'holdings_realtime_calibrated',
    modelEstimatedRate,
    modelEstimatedNav,
    fundgzRate: Number.isFinite(fundgzRate) ? fundgzRate : null,
    fundgzNav: Number.isFinite(fundgzNav) ? fundgzNav : null,
    calibration: {
      bias: Number(entry.bias || 0),
      samples: Number(entry.samples || 0),
      mae: Number(entry.mae || 0),
      modelWeight: Number(modelWeight || 0)
    },
    holdings: enriched
  };
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(payload));
}

function serveStatic(req, res, pathname) {
  const filePath = pathname === '/'
    ? path.join(WEB_DIR, 'index.html')
    : path.join(WEB_DIR, pathname.replace(/^\//, ''));

  if (!filePath.startsWith(WEB_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const typeMap = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8'
    };

    res.writeHead(200, {
      'Content-Type': typeMap[ext] || 'application/octet-stream'
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    sendJson(res, 400, { error: '无效请求' });
    return;
  }

  const parsed = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  if (parsed.pathname === '/api/estimate' && req.method === 'GET') {
    const code = (parsed.searchParams.get('code') || '').trim();
    try {
      const data = await estimateFund(code);
      sendJson(res, 200, { ok: true, data });
    } catch (err) {
      sendJson(res, 400, {
        ok: false,
        error: err instanceof Error ? err.message : '未知错误'
      });
    }
    return;
  }

  serveStatic(req, res, parsed.pathname);
});

server.listen(PORT, () => {
  console.log(`Fund estimator running at http://localhost:${PORT}`);
});
