const fundCodeInput = document.getElementById('fundCode');
const queryBtn = document.getElementById('queryBtn');
const resultEl = document.getElementById('result');
const errorEl = document.getElementById('error');
const recentListEl = document.getElementById('recentList');
const clearRecentBtn = document.getElementById('clearRecentBtn');
const favoritePreviewListEl = document.getElementById('favoritePreviewList');
const refreshFavoritesBtn = document.getElementById('refreshFavoritesBtn');

const RECENT_KEY = 'recent_fund_codes';
const RECENT_LIMIT = 8;
const FAVORITE_KEY = 'favorite_funds';
const FAVORITE_LIMIT = 8;

function formatNum(value, digits = 4) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '--';
  return Number(value).toFixed(digits);
}

function formatPct(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '--';
  const num = Number(value);
  const sign = num > 0 ? '+' : '';
  return `${sign}${num.toFixed(digits)}%`;
}

function clsByNum(value) {
  if (Number(value) > 0) return 'up';
  if (Number(value) < 0) return 'down';
  return '';
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.classList.remove('hidden');
}

function hideError() {
  errorEl.classList.add('hidden');
}

function renderResult(data) {
  const rateClass = clsByNum(data.estimatedRate);
  const favoriteText = isFavorite(data.code) ? '取消收藏' : '收藏基金';
  const rows = data.holdings.slice(0, 12).map((h) => `
    <tr>
      <td>${h.market === 'hk' ? `HK${h.code}` : h.code}</td>
      <td>${h.name}</td>
      <td>${formatNum(h.weight, 2)}%</td>
      <td>${h.price ? formatNum(h.price, 2) : '--'}</td>
      <td class="${clsByNum(h.changeRate)}">${formatPct(h.changeRate)}</td>
      <td>${formatNum((h.contribution || 0) * 100, 3)}%</td>
    </tr>
  `).join('');

  resultEl.innerHTML = `
    <div class="headline">
      <span class="name">${data.name}</span>
      <span class="code">(${data.code})</span>
    </div>
    <div class="result-actions">
      <button id="toggleFavoriteBtn" type="button" class="btn-small btn-soft">${favoriteText}</button>
    </div>

    <div class="metrics">
      <div class="metric">
        <div class="label">上一净值 (${data.navDate || '--'})</div>
        <div class="value">${formatNum(data.previousNav)}</div>
      </div>
      <div class="metric">
        <div class="label">估算净值</div>
        <div class="value ${rateClass}">${formatNum(data.estimatedNav)}</div>
      </div>
      <div class="metric">
        <div class="label">估算涨跌幅</div>
        <div class="value ${rateClass}">${formatPct(data.estimatedRate)}</div>
      </div>
      <div class="metric">
        <div class="label">持仓覆盖权重</div>
        <div class="value">${formatNum(data.coveredWeight || 0, 2)}%</div>
      </div>
    </div>

    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>股票代码</th>
            <th>股票名称</th>
            <th>持仓占比</th>
            <th>现价</th>
            <th>涨跌幅</th>
            <th>贡献度</th>
          </tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="6">暂无可用持仓数据</td></tr>'}</tbody>
      </table>
    </div>
  `;

  resultEl.classList.remove('hidden');
  const toggleBtn = document.getElementById('toggleFavoriteBtn');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      toggleFavorite({ code: data.code, name: data.name });
      renderResult(data);
    });
  }
}

function getFavorites() {
  try {
    const list = JSON.parse(localStorage.getItem(FAVORITE_KEY) || '[]');
    if (!Array.isArray(list)) return [];
    return list
      .filter((x) => x && /^\d{6}$/.test(String(x.code || '')))
      .slice(0, FAVORITE_LIMIT)
      .map((x) => ({ code: String(x.code), name: String(x.name || '') }));
  } catch (_) {
    return [];
  }
}

function saveFavorites(list) {
  localStorage.setItem(FAVORITE_KEY, JSON.stringify(list.slice(0, FAVORITE_LIMIT)));
}

function isFavorite(code) {
  return getFavorites().some((x) => x.code === code);
}

function toggleFavorite(item) {
  const list = getFavorites();
  const index = list.findIndex((x) => x.code === item.code);
  if (index >= 0) {
    list.splice(index, 1);
  } else {
    list.unshift({ code: item.code, name: item.name || item.code });
  }
  saveFavorites(list);
  loadFavoritePreviews();
}

function renderFavoritePreviewCards(cards) {
  if (!favoritePreviewListEl) return;
  if (!cards.length) {
    favoritePreviewListEl.innerHTML = '<span class="tips">暂无收藏基金</span>';
    return;
  }

  favoritePreviewListEl.innerHTML = cards.map((item) => `
    <div class="favorite-item" data-code="${item.code}">
      <div class="n">${item.name || '--'}</div>
      <div class="c">${item.code}</div>
      <div class="r ${clsByNum(item.estimatedRate)}">${formatPct(item.estimatedRate, 2)}</div>
    </div>
  `).join('');

  favoritePreviewListEl.querySelectorAll('.favorite-item[data-code]').forEach((el) => {
    el.addEventListener('click', () => {
      fundCodeInput.value = el.dataset.code || '';
      queryFund();
    });
  });
}

async function loadFavoritePreviews() {
  const favorites = getFavorites();
  if (!favorites.length) {
    renderFavoritePreviewCards([]);
    return;
  }

  if (favoritePreviewListEl) {
    favoritePreviewListEl.innerHTML = '<span class="tips">加载中...</span>';
  }

  const cards = await Promise.all(favorites.map(async (item) => {
    try {
      const res = await fetch(`/api/estimate?code=${encodeURIComponent(item.code)}`);
      const payload = await res.json();
      if (!res.ok || !payload.ok || !payload.data) {
        return { ...item, estimatedRate: null };
      }
      return {
        code: item.code,
        name: payload.data.name || item.name || item.code,
        estimatedRate: payload.data.estimatedRate
      };
    } catch (_) {
      return { ...item, estimatedRate: null };
    }
  }));

  renderFavoritePreviewCards(cards);
}

function getRecentCodes() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    if (!Array.isArray(list)) return [];
    return list.filter((x) => /^\d{6}$/.test(x)).slice(0, RECENT_LIMIT);
  } catch (_) {
    return [];
  }
}

function saveRecentCodes(list) {
  localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_LIMIT)));
}

function renderRecentCodes() {
  if (!recentListEl) return;
  const list = getRecentCodes();
  if (!list.length) {
    recentListEl.innerHTML = '<span class="tips">暂无</span>';
    return;
  }

  recentListEl.innerHTML = list
    .map((code) => `<button class="recent-item" type="button" data-code="${code}">${code}</button>`)
    .join('');

  recentListEl.querySelectorAll('[data-code]').forEach((el) => {
    el.addEventListener('click', () => {
      fundCodeInput.value = el.dataset.code || '';
      queryFund();
    });
  });
}

function pushRecentCode(code) {
  const list = getRecentCodes().filter((x) => x !== code);
  list.unshift(code);
  saveRecentCodes(list);
  renderRecentCodes();
}

async function queryFund() {
  const code = fundCodeInput.value.trim();
  if (!/^\d{6}$/.test(code)) {
    showError('请输入 6 位数字基金代码');
    return;
  }

  hideError();
  resultEl.classList.add('hidden');
  queryBtn.disabled = true;
  queryBtn.textContent = '查询中...';

  try {
    const res = await fetch(`/api/estimate?code=${encodeURIComponent(code)}`);
    const payload = await res.json();

    if (!res.ok || !payload.ok) {
      throw new Error(payload.error || '查询失败');
    }

    renderResult(payload.data);
    pushRecentCode(code);
    if (isFavorite(code)) {
      loadFavoritePreviews();
    }
  } catch (err) {
    showError(err instanceof Error ? err.message : '请求失败');
  } finally {
    queryBtn.disabled = false;
    queryBtn.textContent = '查询估值';
  }
}

queryBtn.addEventListener('click', queryFund);
fundCodeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') queryFund();
});

if (clearRecentBtn) {
  clearRecentBtn.addEventListener('click', () => {
    localStorage.removeItem(RECENT_KEY);
    renderRecentCodes();
  });
}

if (refreshFavoritesBtn) {
  refreshFavoritesBtn.addEventListener('click', loadFavoritePreviews);
}

renderRecentCodes();
loadFavoritePreviews();
