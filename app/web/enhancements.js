(function () {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const PAGE_SIZE = 25;
  const enhanced = { limit: 100, page: { trades: 1, people: 1, icebergs: 1 }, trades: [], people: [], icebergs: [], saved: [], secondaryAddresses: [], savedCursor: 0, marketInfo: null, loading: false, detailsLoading: false };
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const friendlyHyperliquidError = () => 'Источник Hyperliquid временно недоступен. Последние локальные данные сохранены; повторите обновление через несколько секунд.';
  const csvCell = (value) => `"${String(value == null ? '' : value).replace(/"/g, '""')}"`;
  const selectedCoin = () => ($('#hlOverviewCoin')?.value || '').trim().toUpperCase();
  const selectedMarketMinUsd = () => {
    const raw = ($('#hlOverviewMinUsd')?.value || '').trim();
    if (!raw) return 0;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : 0;
  };
  const selectedLimit = () => {
    const mode = $('#hlOverviewLimit')?.value || '100';
    if (mode !== 'custom') return Number(mode);
    const custom = Math.min(500, Math.max(1, Number($('#hlOverviewCustomLimit')?.value || 100)));
    return Number.isFinite(custom) ? custom : 100;
  };
  const useSaved = () => $('#hlUseSavedAddresses')?.checked ? '1' : '0';
  const savedText = () => $('#hlSavedAddresses')?.value || '';
  const addressParam = () => enhanced.saved.join(',');
  const savedAddress = (address) => enhanced.saved.includes(String(address || '').toLowerCase());
  const pages = (rows) => Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const numberValue = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const lastActivityTime = (row) => {
    const nested = [...(Array.isArray(row?.operations) ? row.operations : []), ...(Array.isArray(row?.recent_fills) ? row.recent_fills : [])];
    return Math.max(numberValue(row?.last_time), numberValue(row?.last_fill_time), numberValue(row?.last_market_time), numberValue(row?.last_trade_time), numberValue(row?.time), ...nested.map((item) => numberValue(item?.time)));
  };
  const moscowDate = (time) => {
    if (!numberValue(time)) return '';
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(numberValue(time)));
    return `${parts.find((part) => part.type === 'year')?.value}-${parts.find((part) => part.type === 'month')?.value}-${parts.find((part) => part.type === 'day')?.value}`;
  };
  const dayStatusKind = (row) => {
    const positions = Array.isArray(row?.positions) ? row.positions : (Array.isArray(row?.open_positions) ? row.open_positions : []);
    const latest = lastActivityTime(row);
    if (moscowDate(latest) === moscowDate(Date.now())) {
      const age = Math.max(0, Date.now() - latest);
      if (age <= 5 * 60 * 1000) return 'live';
      if (age <= 60 * 60 * 1000) return 'hour';
      if (age <= 12 * 60 * 60 * 1000) return 'twelveHours';
      return 'todayEarlier';
    }
    return positions.length ? 'endOfDayOpen' : 'inactive';
  };
  const dayStatus = (row) => {
    const kind = dayStatusKind(row);
    if (kind === 'live') return '<span class="badge short">Сейчас · до 5 мин</span>';
    if (kind === 'hour') return '<span class="badge short">Сегодня · до 1ч</span>';
    if (kind === 'twelveHours') return '<span class="badge short">Сегодня · до 12ч</span>';
    if (kind === 'todayEarlier') return '<span class="badge short">Сегодня · ранее</span>';
    if (kind === 'endOfDayOpen') return '<span class="badge yellow">Открытые позиции на конец дня</span>';
    return '<span class="badge">Нет транзакций сегодня</span>';
  };
  const activitySummary = (rows) => {
    const counts = rows.reduce((all, row) => { const kind = dayStatusKind(row); all[kind] = (all[kind] || 0) + 1; return all; }, {});
    return `<div class="toolbar activity-summary"><span class="badge short">Сейчас: ${counts.live || 0}</span><span class="badge short">1ч: ${counts.hour || 0}</span><span class="badge short">12ч: ${counts.twelveHours || 0}</span><span class="badge short">Сегодня ранее: ${counts.todayEarlier || 0}</span><span class="badge yellow">Позиции на конец дня: ${counts.endOfDayOpen || 0}</span></div>`;
  };
  const sortByDayStatus = (rows, ...selectors) => {
    sortDescending(rows, ...selectors);
    const rank = { live: 0, hour: 1, twelveHours: 2, todayEarlier: 3, endOfDayOpen: 4, inactive: 5 };
    return rows.sort((left, right) => rank[dayStatusKind(left)] - rank[dayStatusKind(right)]);
  };
  function appendDayStatusColumn(root, rows) {
    const table = root?.querySelector('table');
    const header = table?.tHead?.rows?.[0];
    if (!header) return;
    root.querySelector('.activity-summary')?.remove();
    table.insertAdjacentHTML('beforebegin', activitySummary(rows));
    if (header.cells[header.cells.length - 1]?.textContent.trim() === 'Подраздел') return;
    const mainRows = Array.from(table.tBodies?.[0]?.rows || []).filter((row) => !row.classList.contains('trade-detail'));
    if (mainRows.length !== rows.length) return;
    header.insertAdjacentHTML('beforeend', '<th>Подраздел</th>');
    mainRows.forEach((element, index) => {
      element.insertAdjacentHTML('beforeend', `<td>${dayStatus(rows[index])}</td>`);
      const detail = element.nextElementSibling;
      if (detail?.classList.contains('trade-detail')) detail.cells[0].colSpan = header.cells.length;
    });
  }
  const sortDescending = (rows, ...selectors) => rows.sort((a, b) => {
    for (const selector of selectors) {
      const aValue = numberValue(typeof selector === 'function' ? selector(a) : a?.[selector]);
      const bValue = numberValue(typeof selector === 'function' ? selector(b) : b?.[selector]);
      if (aValue !== bValue) return bValue - aValue;
    }
    return String(a?.address || '').localeCompare(String(b?.address || ''));
  });
  const slicePage = (rows, key) => {
    const total = pages(rows); enhanced.page[key] = Math.min(total, Math.max(1, enhanced.page[key] || 1));
    const start = (enhanced.page[key] - 1) * PAGE_SIZE;
    return { rows: rows.slice(start, start + PAGE_SIZE), total, start };
  };
  const pager = (key, total) => total <= 1 ? '' : `<div class="toolbar" data-pager="${key}"><button class="pair" data-page-action="prev" data-page-key="${key}">Назад</button><span class="muted">Страница ${enhanced.page[key]} из ${total}</span><button class="pair" data-page-action="next" data-page-key="${key}">Вперёд</button></div>`;
  function bindPagers(root) {
    root.querySelectorAll('[data-page-action]').forEach((button) => button.onclick = () => {
      const key = button.dataset.pageKey; const total = pages(enhanced[key]);
      enhanced.page[key] += button.dataset.pageAction === 'next' ? 1 : -1;
      enhanced.page[key] = Math.min(total, Math.max(1, enhanced.page[key]));
      if (key === 'trades') renderTrades();
      if (key === 'people') renderPeople();
      if (key === 'icebergs') renderIcebergs();
    });
  }
  function downloadCsv(name, rows, columns) {
    const body = [columns.map((column) => csvCell(column.label)).join(',')].concat(rows.map((row) => columns.map((column) => csvCell(typeof column.value === 'function' ? column.value(row) : row[column.value])).join(','))).join('\n');
    const blob = new Blob([new Uint8Array([0xef, 0xbb, 0xbf]), body], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${name}.csv`; link.click(); URL.revokeObjectURL(link.href);
  }
  function addExportButton(parent, id, label, action) {
    if ($(id)) return $(id);
    const button = document.createElement('button'); button.id = id.slice(1); button.className = 'pair'; button.textContent = label; button.onclick = action; parent.appendChild(button);
    return button;
  }
  async function loadSaved() {
    try {
      const response = await fetch('/api/hyperliquid/saved-addresses'); const data = await response.json(); enhanced.saved = data.addresses || [];
      if ($('#hlSavedAddresses') && !$('#hlSavedAddresses').value) $('#hlSavedAddresses').value = enhanced.saved.join(', ');
      if ($('#hlSavedStatus')) $('#hlSavedStatus').textContent = `Сохранено адресов: ${enhanced.saved.length}`;
    } catch (error) { if ($('#hlSavedStatus')) $('#hlSavedStatus').textContent = 'Не удалось прочитать локальные адреса'; }
  }
  async function saveAddresses() {
    const addresses = savedText().replace(/;/g, ',').split(',').map((value) => value.trim()).filter(Boolean);
    try {
      const response = await fetch('/api/hyperliquid/saved-addresses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ addresses }) });
      const data = await response.json(); if (!response.ok) throw Error(data.error || `HTTP ${response.status}`);
      enhanced.saved = data.addresses || []; $('#hlSavedAddresses').value = enhanced.saved.join(', '); $('#hlSavedStatus').textContent = `Сохранено адресов: ${enhanced.saved.length}`;
    } catch (error) { $('#hlSavedStatus').textContent = `Ошибка сохранения: ${error.message}`; }
  }
  function setSaveButtonState(button, saved) {
    button.textContent = saved ? 'Сохранено' : 'Сохранить';
    button.title = saved ? 'Адрес сохранён' : 'Сохранить адрес';
    button.setAttribute('aria-label', button.title);
    button.disabled = saved;
    button.classList.toggle('saved', saved);
  }
  function syncSaveButtons(address) {
    const normalized = String(address || '').toLowerCase();
    document.querySelectorAll('.save-detected-address').forEach((button) => {
      if (button.dataset.address === normalized) setSaveButtonState(button, true);
    });
  }
  function bindAddressSaveButtons(root) {
    root?.querySelectorAll('.save-detected-address').forEach((button) => {
      setSaveButtonState(button, savedAddress(button.dataset.address));
      button.onclick = () => saveDetectedAddress(button.dataset.address, button);
    });
  }
  function chooseSecondaryAddresses(limit = 8) {
    if (useSaved() !== '1') return enhanced.people.slice(0, limit).map((item) => item.address);
    const savedSet = new Set(enhanced.saved);
    const savedRows = enhanced.saved.filter((address) => enhanced.people.some((item) => item.address === address));
    const savedSlots = Math.min(4, limit, savedRows.length);
    const start = savedRows.length ? enhanced.savedCursor % savedRows.length : 0;
    const savedBatch = Array.from({ length: savedSlots }, (_, index) => savedRows[(start + index) % savedRows.length]);
    if (savedRows.length) enhanced.savedCursor = (start + savedSlots) % savedRows.length;
    const liveBatch = enhanced.people.filter((item) => !savedSet.has(item.address)).slice(0, limit - savedBatch.length).map((item) => item.address);
    return savedBatch.concat(liveBatch);
  }
  async function saveDetectedAddress(address, button) {
    const normalized = String(address || '').trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(normalized)) return;
    const next = Array.from(new Set(enhanced.saved.concat(normalized)));
    button.disabled = true;
    try {
      const response = await fetch('/api/hyperliquid/saved-addresses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ addresses: next }) });
      const data = await response.json(); if (!response.ok) throw Error(data.error || `HTTP ${response.status}`);
      enhanced.saved = data.addresses || next;
      syncSaveButtons(normalized);
      if ($('#hlSavedAddresses')) $('#hlSavedAddresses').value = enhanced.saved.join(', ');
      if ($('#hlSavedStatus')) $('#hlSavedStatus').textContent = `Сохранено адресов: ${enhanced.saved.length}`;
    } catch (error) {
      button.disabled = false; button.textContent = 'Сохранить'; button.title = `Не удалось сохранить: ${error.message}`;
      if ($('#hlSavedStatus')) $('#hlSavedStatus').textContent = `Ошибка сохранения: ${error.message}`;
    }
  }
  function addSaveButtonsToParticipants(detail) {
    if (!detail) return;
    detail.querySelectorAll('.wallet-stat .address').forEach((addressNode) => {
      const address = addressNode.textContent.trim().toLowerCase();
      if (!/^0x[a-f0-9]{40}$/.test(address) || addressNode.parentElement.querySelector('.save-detected-address')) return;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'pair save-detected-address'; button.dataset.address = address; setSaveButtonState(button, savedAddress(address)); button.onclick = () => saveDetectedAddress(address, button);
      addressNode.parentElement.appendChild(button);
    });
  }
  function wrapParticipantDetails() {
    if (typeof window.loadTradeParticipants !== 'function' || window.loadTradeParticipants.__saveWrapped) return;
    const original = window.loadTradeParticipants;
    const wrapped = async function (id, trade) {
      await original(id, trade);
      addSaveButtonsToParticipants(document.getElementById(id));
    };
    wrapped.__saveWrapped = true; window.loadTradeParticipants = wrapped;
  }
  function renderTrades() {
    const box = $('#hlOverviewTrades'); if (!box) return; sortByDayStatus(enhanced.trades, 'usd', 'size', 'time'); const view = slicePage(enhanced.trades, 'trades');
    const info = enhanced.marketInfo; const coverage = info && info.markets_total > 1 ? ` · рынков обновлено: ${info.markets_refreshed}/${info.markets_total}, в кэше: ${info.markets_cached}` : '';
    box.innerHTML = enhanced.trades.length ? `<div class="toolbar"><span class="muted">Показано ${view.start + 1}–${view.start + view.rows.length} из ${enhanced.trades.length}${coverage}</span></div><table><thead><tr><th>Время</th><th>Рыночная сторона</th><th>Монета</th><th>Цена</th><th>Размер</th><th>USD</th><th>Подраздел</th></tr></thead><tbody>${view.rows.map((x, i) => { const id = `enhanced-trade-${view.start + i}`; const payload = encodeURIComponent(JSON.stringify(x)); return `<tr><td>${hlTime(x.time)}</td><td><button class="badge ${x.side === 'BUY' ? 'short' : 'long'}" onclick="loadTradeParticipants('${id}',JSON.parse(decodeURIComponent('${payload}')))" >${x.side === 'BUY' ? 'РЫН. ПОКУПКА' : 'РЫН. ПРОДАЖА'}</button></td><td>${esc(x.coin)}</td><td>${fmt(x.price, 6)}</td><td>${fmt(x.size, 6)}</td><td>$${fmt(x.usd, 0)}</td><td>${dayStatus(x)}</td></tr><tr class="trade-detail" hidden><td colspan="7"><div id="${id}"></div></td></tr>`; }).join('')}</tbody></table>${pager('trades', view.total)}` : '<div class="empty">Рыночных сделок по выбранному фильтру пока нет.</div>';
    bindPagers(box);
  }
  function renderPeople() {
    const box = $('#hlOverviewAddresses'); if (!box) return; sortByDayStatus(enhanced.people, 'totalUsd', 'buyUsd', 'sellUsd'); const view = slicePage(enhanced.people, 'people');
    box.innerHTML = enhanced.people.length ? `<div class="toolbar"><span class="muted">Показано ${view.start + 1}–${view.start + view.rows.length} из ${enhanced.people.length}</span><button id="exportPeopleCsv" class="pair">Excel CSV</button></div><table><thead><tr><th>Адрес участника</th><th>Участий</th><th>Покупки</th><th>Покупки USD</th><th>Продажи</th><th>Продажи USD</th><th>Всего USD</th><th>Аккаунт</th><th>Частота покупок</th><th>Подраздел</th></tr></thead><tbody>${view.rows.map((p, i) => { const id = `enhanced-account-${view.start + i}`; const address = String(p.address || '').toLowerCase(); const saved = savedAddress(address); const f = state.hlFrequency[p.address]; const frequency = f ? `${esc(f.label)}<br><span class="muted">${f.buy_count} покупок · ${f.active_days} дн.</span>` : '<span class="muted">анализ...</span>'; return `<tr><td><div class="address-actions"><button class="address wallet-address" onclick="loadOverviewAccount('${id}','${address}')">${address}</button><button type="button" class="pair save-detected-address${saved ? ' saved' : ''}" data-address="${address}" title="${saved ? 'Адрес сохранён' : 'Сохранить адрес'}" aria-label="${saved ? 'Адрес сохранён' : 'Сохранить адрес'}"${saved ? ' disabled' : ''}>${saved ? '✓' : '⇩'}</button></div></td><td>${p.trades}</td><td>${p.buyTrades}</td><td>$${fmt(p.buyUsd, 0)}</td><td>${p.sellTrades}</td><td>$${fmt(p.sellUsd, 0)}</td><td><strong>$${fmt(p.totalUsd, 0)}</strong></td><td><a class="address" href="https://app.hyperliquid.xyz/explorer/address/${address}" target="_blank" rel="noopener">Открыть</a></td><td class="compact-cell">${frequency}</td><td>${dayStatus(p)}</td></tr><tr class="trade-detail" hidden><td colspan="10"><div id="${id}"></div></td></tr>`; }).join('')}</tbody></table>${pager('people', view.total)}` : '<div class="empty">Нет адресов в выбранном фильтре.</div>';
    bindAddressSaveButtons(box);
    $('#exportPeopleCsv')?.addEventListener('click', () => downloadCsv('hyperliquid_participants', enhanced.people, [{ label: 'address', value: 'address' }, { label: 'trades', value: 'trades' }, { label: 'buy_trades', value: 'buyTrades' }, { label: 'buy_usd', value: 'buyUsd' }, { label: 'sell_trades', value: 'sellTrades' }, { label: 'sell_usd', value: 'sellUsd' }, { label: 'total_usd', value: 'totalUsd' }]));
    bindPagers(box);
  }
  function renderIcebergs() {
    const box = $('#hlIcebergs'); if (!box) return; sortByDayStatus(enhanced.icebergs, 'usd', 'parts', 'band_pct'); const view = slicePage(enhanced.icebergs, 'icebergs');
    box.innerHTML = enhanced.icebergs.length ? `<div class="toolbar"><span class="muted">Показано ${view.start + 1}–${view.start + view.rows.length} из ${enhanced.icebergs.length}</span><button id="exportIcebergsCsv" class="pair">Excel CSV</button></div><table><thead><tr><th>Адрес</th><th>Монета</th><th>Сторона</th><th>Частей</th><th>USD</th><th>Цена</th><th>Разброс</th><th>Период</th><th>Подраздел</th></tr></thead><tbody>${view.rows.map((x, i) => { const id = `enhanced-iceberg-${view.start + i}`; const payload = encodeURIComponent(JSON.stringify(x)); const address = String(x.address || '').toLowerCase(); const saved = savedAddress(address); return `<tr><td><div class="address-actions"><button class="address wallet-address" onclick="loadIcebergAccount('${id}','${address}',JSON.parse(decodeURIComponent('${payload}')),'${x.coin || selectedCoin() || 'ALL'}')">${address}</button><button type="button" class="pair save-detected-address${saved ? ' saved' : ''}" data-address="${address}" title="${saved ? 'Адрес сохранён' : 'Сохранить адрес'}" aria-label="${saved ? 'Адрес сохранён' : 'Сохранить адрес'}"${saved ? ' disabled' : ''}>${saved ? '✓' : '⇩'}</button></div></td><td>${esc(x.coin || 'ALL')}</td><td><span class="badge ${x.side === 'BUY' ? 'short' : 'long'}">${x.side === 'BUY' ? 'ПОКУПКА' : 'ПРОДАЖА'}</span></td><td>${x.parts}</td><td>$${fmt(x.usd, 0)}</td><td>${fmt(x.price_low, 6)} - ${fmt(x.price_high, 6)}</td><td>${Number(x.band_pct || 0).toFixed(3)}%</td><td>${hlTime(x.first_time)} - ${hlTime(x.last_time)}</td><td>${dayStatus(x)}</td></tr><tr class="trade-detail" hidden><td colspan="9"><div id="${id}"></div></td></tr>`; }).join('')}</tbody></table>${pager('icebergs', view.total)}` : '<div class="empty">Сигналы дробного исполнения не найдены.</div>';
    bindAddressSaveButtons(box);
    $('#exportIcebergsCsv')?.addEventListener('click', () => downloadCsv('hyperliquid_icebergs', enhanced.icebergs, [{ label: 'address', value: 'address' }, { label: 'coin', value: 'coin' }, { label: 'side', value: 'side' }, { label: 'parts', value: 'parts' }, { label: 'usd', value: 'usd' }, { label: 'price_low', value: 'price_low' }, { label: 'price_high', value: 'price_high' }, { label: 'band_pct', value: 'band_pct' }]));
    bindPagers(box);
  }
  async function loadEnhancedIcebergs() {
    const box = $('#hlIcebergs');
    if (!box) return;
    const thresholdEnabled = $('#hlIcebergThresholdEnabled')?.checked;
    const minUsd = ($('#hlIcebergMinUsd')?.value || '').trim();
    if (thresholdEnabled && !minUsd) {
      box.innerHTML = '<div class="empty">Для включённого USD-порога укажите минимальную сумму.</div>';
      return;
    }
    box.innerHTML = '<div class="empty">Проверка сигналов дробного исполнения...</div>';
    const response = await fetch('/api/hyperliquid/icebergs?' + new URLSearchParams({
      coin: selectedCoin(),
      addresses: (enhanced.secondaryAddresses.length ? enhanced.secondaryAddresses : chooseSecondaryAddresses()).join(','),
      minUsd: thresholdEnabled ? minUsd : '0',
      useSaved: '0'
    }));
    const data = await response.json();
    if (!response.ok) throw Error(data.error || `HTTP ${response.status}`);
    enhanced.icebergs = sortByDayStatus(data.signals || [], 'usd', 'parts', 'band_pct');
    enhanced.page.icebergs = 1;
    renderIcebergs();
  }
  async function refreshFrequency(coin) {
    const addresses = enhanced.secondaryAddresses.length ? enhanced.secondaryAddresses : chooseSecondaryAddresses();
    if (!addresses.length) return;
    try {
      const response = await fetch('/api/hyperliquid/frequency?' + new URLSearchParams({ coin, addresses: addresses.join(',') })); const data = await response.json();
      if (!response.ok) return;
      (data.rows || []).forEach((item) => state.hlFrequency[item.address] = item);
      renderPeople();
    } catch (_) { /* The live trade table remains available if an optional lookup is delayed. */ }
  }
  async function refreshSecondaryPanels(coin) {
    if (enhanced.detailsLoading) return;
    enhanced.detailsLoading = true;
    try {
      try { await loadEnhancedIcebergs(); } catch (error) { $('#hlIcebergs').innerHTML = '<div class="empty">Сигналы временно недоступны: ' + esc(error.message) + '</div>'; }
      await refreshFrequency(coin);
    } finally { enhanced.detailsLoading = false; }
  }
  async function enhancedLoadHlOverview() {
    if (enhanced.loading) return;
    enhanced.loading = true;
    const coin = selectedCoin(); enhanced.limit = selectedLimit(); enhanced.page = { trades: 1, people: 1, icebergs: 1 };
    const tradesBox = $('#hlOverviewTrades'), peopleBox = $('#hlOverviewAddresses'); tradesBox.innerHTML = '<div class="empty">Загрузка реальных рыночных сделок...</div>'; peopleBox.innerHTML = '<div class="empty">Анализ участников...</div>';
    try {
      const q = new URLSearchParams({ coin, limit: String(enhanced.limit) }); const response = await fetch('/api/hyperliquid/trades?' + q); const data = await response.json(); if (!response.ok) throw Error(data.error || `HTTP ${response.status}`);
      const minUsd = selectedMarketMinUsd();
      enhanced.marketInfo = data.market_info || null; enhanced.trades = (data.trades || []).filter((trade) => Number(trade.usd || 0) >= minUsd); const buys = enhanced.trades.filter((x) => x.side === 'BUY'); const sells = enhanced.trades.filter((x) => x.side === 'SELL'); const sum = (rows) => rows.reduce((total, row) => total + Number(row.usd || 0), 0); const participants = {};
      enhanced.trades.forEach((trade) => (trade.participants || []).forEach((address) => { const p = participants[address] || (participants[address] = { address, trades: 0, buyTrades: 0, sellTrades: 0, buyUsd: 0, sellUsd: 0, totalUsd: 0, last_time: 0 }); p.last_time = Math.max(numberValue(p.last_time), numberValue(trade.time)); p.trades++; p.totalUsd += Number(trade.usd || 0); if (trade.side === 'BUY') { p.buyTrades++; p.buyUsd += Number(trade.usd || 0); } else { p.sellTrades++; p.sellUsd += Number(trade.usd || 0); } }));
      if (useSaved() === '1') { enhanced.saved.forEach((address) => { if (!participants[address]) participants[address] = { address, trades: 0, buyTrades: 0, sellTrades: 0, buyUsd: 0, sellUsd: 0, totalUsd: 0, saved: true }; }); }
      const rows = Object.values(participants);
      sortByDayStatus(rows, 'totalUsd', 'buyUsd', 'sellUsd');
      state.hlOverviewPeople = enhanced.people = rows; enhanced.secondaryAddresses = chooseSecondaryAddresses(); state.hlFrequency = {};
      $('#hlOverviewBuy').textContent = buys.length; $('#hlOverviewSell').textContent = sells.length; $('#hlOverviewBuyUsd').textContent = '$' + fmt(sum(buys), 0); $('#hlOverviewSellUsd').textContent = '$' + fmt(sum(sells), 0); renderTrades(); renderPeople();
      refreshSecondaryPanels(coin);
    } catch (error) { const message = friendlyHyperliquidError(); tradesBox.innerHTML = '<div class="empty">' + message + '</div>'; peopleBox.innerHTML = '<div class="empty">' + message + '</div>'; }
    finally { enhanced.loading = false; }
  }
  async function loadPaperBacktest() {
    let box = $('#hlPaperBacktestBox');
    if (!box) {
      box = document.createElement('div'); box.id = 'hlPaperBacktestBox'; box.className = 'panel'; box.style.marginTop = '16px';
      $('#hlOverview').appendChild(box);
    }
    box.innerHTML = '<div class="empty">Собираю paper-backtest по сохранённым адресам...</div>';
    try {
      const response = await fetch('/api/hyperliquid/paper-backtest'); const data = await response.json();
      if (!response.ok) throw Error(data.error || `HTTP ${response.status}`);
      const leader = data.leader || {}; const today = (data.windows || []).find((item) => item.period === 'Сегодня') || {};
      box.innerHTML = `<h2>Paper-backtest: $1,000 и 1,000 RUB</h2><p class="note">Лидер: <span class="address">${esc(leader.address || '—')}</span> · сегодня: <strong class="${Number(today.net_pnl_usd || 0) >= 0 ? 'green' : 'red'}">${Number(today.return_pct || 0).toFixed(4)}%</strong> · файл: <span class="address">${esc(data.report_path || 'не удалось записать')}</span></p><pre style="white-space:pre-wrap;max-height:520px;overflow:auto;color:var(--text);font:12px ui-monospace,monospace">${esc(data.report || 'Нет данных')}</pre>`;
    } catch (error) { box.innerHTML = '<div class="empty">Paper-backtest недоступен: ' + esc(error.message) + '</div>'; }
  }
  async function load24hAnalysis() {
    let box = $('#hl24hAnalysisBox');
    if (!box) {
      box = document.createElement('div'); box.id = 'hl24hAnalysisBox'; box.className = 'panel'; box.style.marginTop = '16px';
      $('#hlOverview').appendChild(box);
    }
    const minUsd = selectedMarketMinUsd() || 5000;
    box.innerHTML = `<div class="empty">Собираю реальные сделки Hyperliquid за 24 часа, порог $${fmt(minUsd, 0)}, до 500 аккаунтов...</div>`;
    try {
      const response = await fetch('/api/hyperliquid/24h-analysis?' + new URLSearchParams({ coin: selectedCoin(), limit: '500', minUsd: String(minUsd) }));
      const data = await response.json(); if (!response.ok) throw Error(data.error || `HTTP ${response.status}`);
      const summary = data.summary || {}; const accounts = sortByDayStatus(data.accounts || [], 'large_usd', 'net_pnl', 'observed_trades');
      const pct = (value) => `${Number(value || 0).toFixed(2)}%`;
      box.innerHTML = `<h2>Анализ Hyperliquid за 24 часа</h2><p class="note">Монета: <strong>${esc(summary.coin || 'ALL')}</strong> · порог: <strong>$${fmt(summary.min_usd || minUsd, 0)}</strong> · проанализировано адресов: <strong>${summary.accounts_found || 0}</strong> · с объёмом от порога: <strong>${summary.accounts_qualified || 0}</strong> · показано: <strong>${summary.accounts_returned || 0}</strong><br>Файл: <span class="address">${esc(data.report_path || 'не удалось сохранить')}</span></p><div class="metrics"><div class="metric"><span>Покупки</span><strong>$${fmt(summary.buy_usd || 0, 0)} <small>${pct(summary.buy_pct)}</small></strong></div><div class="metric"><span>Продажи</span><strong>$${fmt(summary.sell_usd || 0, 0)} <small>${pct(summary.sell_pct)}</small></strong></div><div class="metric"><span>Дробленные</span><strong>$${fmt(summary.fractional_usd || 0, 0)} <small>${pct(summary.fractional_pct)}</small></strong></div><div class="metric"><span>Другие</span><strong>$${fmt(summary.other_usd || 0, 0)} <small>${pct(summary.other_pct)}</small></strong></div></div><p class="note">Аккаунты: покупки больше ${summary.buy_dominant_accounts || 0} · продажи больше ${summary.sell_dominant_accounts || 0} · баланс ${summary.balance_accounts || 0}. Закрытый и открытый PnL не вычисляются из public market-потока: он не сообщает, какой из двух адресов был покупателем.</p><div class="toolbar"><span class="muted">Рыночных строк за 24ч: ${summary.market_trades_24h || 0} · выше порога: ${summary.market_trades_above_threshold || 0}</span><button id="export24hAnalysisCsv" class="pair">Excel CSV</button></div>${accounts.length ? `<table><thead><tr><th>#</th><th>Адрес</th><th>Преобладание</th><th>Сделок</th><th>Объём от $5k</th><th>BUY %</th><th>SELL %</th><th>Дробленные %</th><th>Другие %</th></tr></thead><tbody>${accounts.map((row, index) => `<tr><td>${index + 1}</td><td><a class="address" href="https://app.hyperliquid.xyz/explorer/address/${row.address}" target="_blank" rel="noopener">${row.address}</a></td><td><span class="badge ${row.dominance === 'ПОКУПКИ' ? 'short' : row.dominance === 'ПРОДАЖИ' ? 'long' : 'yellow'}">${esc(row.dominance)}</span></td><td>${row.observed_trades || 0}</td><td>$${fmt(row.large_usd || 0, 0)}</td><td>${pct(row.buy_pct)}</td><td>${pct(row.sell_pct)}</td><td>${pct(row.fractional_pct)}</td><td>${pct(row.other_pct)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">За последние 24 часа не найдено адресов с публичными участниками.</div>'}`;
      appendDayStatusColumn(box, accounts);
      $('#export24hAnalysisCsv')?.addEventListener('click', () => downloadCsv('hyperliquid_24h_analysis', accounts, [{ label: 'address', value: 'address' }, { label: 'dominance', value: 'dominance' }, { label: 'observed_trades', value: 'observed_trades' }, { label: 'qualified_usd', value: 'large_usd' }, { label: 'qualified_buy_usd', value: 'large_buy_usd' }, { label: 'qualified_sell_usd', value: 'large_sell_usd' }, { label: 'buy_pct', value: 'buy_pct' }, { label: 'sell_pct', value: 'sell_pct' }, { label: 'fractional_usd', value: 'fractional_usd' }, { label: 'fractional_pct', value: 'fractional_pct' }, { label: 'other_usd', value: 'other_usd' }, { label: 'other_pct', value: 'other_pct' }]));
    } catch (error) { box.innerHTML = '<div class="empty">Анализ за 24 часа недоступен: ' + esc(error.message) + '</div>'; }
  }
  async function load12hWhales() {
    let box = $('#hl12hWhalesBox');
    if (!box) {
      box = document.createElement('div'); box.id = 'hl12hWhalesBox'; box.className = 'panel'; box.style.marginTop = '16px';
      $('#hlOverview').appendChild(box);
    }
    box.innerHTML = '<div class="empty">Собираю 12-часовые fills китов от $500. Повторный запрос кэшируется на 5 минут...</div>';
    try {
      const response = await fetch('/api/hyperliquid/12h-whales?' + new URLSearchParams({ coin: selectedCoin(), minUsd: '500', minAgeDays: '120', requirePositiveWinRate: '1', requireLastTradeToday: '0', maxAccounts: '20' }));
      const data = await response.json(); if (!response.ok) throw Error(data.error || `HTTP ${response.status}`);
      const totals = data.totals || {}; const whales = sortByDayStatus(data.whales || [], 'volume_usd', 'net_pnl', 'fills'); const cash = (value) => value == null ? '—' : `${Number(value) >= 0 ? '+' : '-'}$${fmt(Math.abs(Number(value) || 0), 2)}`; const pct = (value) => value == null ? '—' : `${Number(value) >= 0 ? '+' : ''}${Number(value).toFixed(2)}%`;
      const actionText = (row) => { const actions = row.actions || {}; return `OL ${actions['Open Long']?.fills || 0} · CL ${actions['Close Long']?.fills || 0} · OS ${actions['Open Short']?.fills || 0} · CS ${actions['Close Short']?.fills || 0}`; };
      box.innerHTML = `<h2>Киты: PnL за 12 часов</h2><p class="note">Монета: <strong>${esc(data.coin || 'ALL')}</strong> · каждая сделка от <strong>$${fmt(data.threshold_usd || 500, 0)}</strong> · возраст первой прибыльной сделки: <strong>от ${data.min_age_days || 120} дней</strong> · последняя сделка: <strong>${esc(data.report_day_msk || 'сегодня')} MSK</strong> · прошло все фильтры: <strong>${data.qualified_count || 0}</strong> · ${data.cached ? 'результат из кэша' : 'свежий сбор'}<br>Файл: <span class="address">${esc(data.report_path || 'не удалось сохранить')}</span></p><div class="metrics"><div class="metric"><span>Грязная прибыль</span><strong>${cash(totals.gross_profit)}</strong></div><div class="metric"><span>Closed PnL до комиссий</span><strong>${cash(totals.closed_pnl_before_fees)}</strong></div><div class="metric"><span>Чистый PnL</span><strong class="${Number(totals.net_pnl || 0) >= 0 ? 'green' : 'red'}">${cash(totals.net_pnl)}</strong></div><div class="metric"><span>Успешные закрытия</span><strong>${pct(totals.profitable_close_rate_pct)}</strong></div><div class="metric"><span>Комиссии</span><strong>${cash(-Math.abs(Number(totals.fees || 0)))}</strong></div><div class="metric"><span>Открытый PnL</span><strong class="${Number(totals.open_pnl || 0) >= 0 ? 'green' : 'red'}">${cash(totals.open_pnl)}</strong></div></div><p class="note">Успешное закрытие: closedPnl &gt; 0. Адреса с 0% прибыли, возрастом меньше 120 дней или без сделки в день отчёта отсеяны сервером.</p><div class="toolbar"><span class="muted">Кандидатов: ${data.candidate_count || 0} · PnL-фильтр: ${data.pnl_qualified_count || 0} · активны сегодня: ${data.today_qualified_count || 0} · кэш: 5 минут</span><button id="export12hWhalesCsv" class="pair">Excel CSV</button></div>${whales.length ? `<table><thead><tr><th>#</th><th>Адрес кита</th><th>Fills</th><th>Объём USD</th><th>Gross</th><th>Net</th><th>Win rate</th><th>Open PnL</th><th>Возраст / последняя</th><th>Long / Short</th></tr></thead><tbody>${whales.map((row, index) => `<tr><td>${index + 1}</td><td><a class="address" href="https://app.hyperliquid.xyz/explorer/address/${row.address}" target="_blank" rel="noopener">${row.address}</a></td><td>${row.fills || 0}</td><td>$${fmt(row.volume_usd || 0, 0)}</td><td>${cash(row.gross_profit)}</td><td class="${Number(row.net_pnl || 0) >= 0 ? 'green' : 'red'}">${cash(row.net_pnl)}</td><td>${row.profitable_close_fills || 0}/${row.realized_close_fills || 0} · ${pct(row.profitable_close_rate_pct)}</td><td class="${Number(row.open_pnl || 0) >= 0 ? 'green' : 'red'}">${cash(row.open_pnl)}</td><td class="compact-cell">${Number(row.first_profitable_close_age_days || 0).toFixed(0)} дн.<br>${row.last_fill_time ? esc(new Date(row.last_fill_time).toLocaleString('ru-RU')) : '—'}</td><td class="compact-cell">${actionText(row)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Нет адресов, одновременно прошедших PnL, win rate, возраст 120 дней и активность сегодня.</div>'}`;
      appendDayStatusColumn(box, whales);
      $('#export12hWhalesCsv')?.addEventListener('click', () => downloadCsv('hyperliquid_12h_whales', whales, [{ label: 'address', value: 'address' }, { label: 'fills', value: 'fills' }, { label: 'volume_usd', value: 'volume_usd' }, { label: 'gross_profit', value: 'gross_profit' }, { label: 'closed_pnl_before_fees', value: 'closed_pnl_before_fees' }, { label: 'fees', value: 'fees' }, { label: 'net_pnl', value: 'net_pnl' }, { label: 'net_pct_of_gross_profit', value: 'net_pct_of_gross_profit' }, { label: 'open_pnl', value: 'open_pnl' }, { label: 'total_pnl_including_open', value: 'total_pnl_including_open' }]));
    } catch (error) { box.innerHTML = '<div class="empty">Отчёт китов недоступен: ' + esc(error.message) + '</div>'; }
  }
  async function load12hPnl1500() {
    let box = $('#hl12hPnl1500Box');
    if (!box) {
      box = document.createElement('div'); box.id = 'hl12hPnl1500Box'; box.className = 'panel'; box.style.marginTop = '16px';
      $('#hlOverview').appendChild(box);
    }
    box.innerHTML = '<div class="empty">Проверяю сохранённые адреса: PnL за 12 часов от $1,500, Long/Short и частоту fills...</div>';
    try {
      const params = new URLSearchParams({ coin: 'ALL', minUsd: '0', minPnl: '1500', minAgeDays: '120', requirePositiveWinRate: '1', requireLastTradeToday: '0', maxAccounts: '50' });
      const response = await fetch('/api/hyperliquid/12h-whales?' + params); const data = await response.json();
      if (!response.ok) throw Error(data.error || `HTTP ${response.status}`);
      const totals = data.totals || {}; const whales = sortByDayStatus(data.whales || [], 'total_pnl_including_open', 'net_pnl', 'open_pnl');
      const cash = (value) => value == null ? '—' : `${Number(value) >= 0 ? '+' : '-'}$${fmt(Math.abs(Number(value) || 0), 2)}`;
      const pct = (value) => value == null ? '—' : `${Number(value).toFixed(2)}%`;
      const actions = (row) => { const data = row.actions || {}; return `OL ${data['Open Long']?.fills || 0} · CL ${data['Close Long']?.fills || 0} · OS ${data['Open Short']?.fills || 0} · CS ${data['Close Short']?.fills || 0}`; };
      const closeResult = (row) => `${row.profitable_close_fills || 0} из ${row.realized_close_fills || 0} · ${pct(row.profitable_close_rate_pct)}<br><span class="green">${cash(row.gross_profit)}</span>`;
      const openResult = (row) => { const decided = Number(row.profitable_open_positions || 0) + Number(row.losing_open_positions || 0); const positions = (row.positions || []).slice(0, 4).map((position) => `${esc(position.coin || '—')} ${esc(position.side || '—')} ${cash(position.unrealized_pnl)}`).join('<br>'); return `${row.profitable_open_positions || 0} из ${decided} · ${pct(row.open_position_profit_rate_pct)}<br><span class="green">${cash(row.profitable_open_pnl)}</span>${positions ? `<br><span class="muted">${positions}</span>` : ''}`; };
      const activity = (row) => `${Number(row.first_profitable_close_age_days || 0).toFixed(0)} дн.<br><span class="muted">первая +: ${row.first_profitable_close_time ? esc(new Date(row.first_profitable_close_time).toLocaleDateString('ru-RU')) : '—'}<br>последняя: ${row.last_fill_time ? esc(new Date(row.last_fill_time).toLocaleString('ru-RU')) : '—'}</span>`;
      box.innerHTML = `<h2>PnL от $1,500 за 12 часов</h2><p class="note">Обязательные фильтры: <strong>win rate закрытий &gt; 0%</strong> · первая прибыльная закрытая сделка <strong>не менее ${data.min_age_days || 120} дней назад</strong> · последняя сделка <strong>${esc(data.report_day_msk || 'сегодня')} MSK</strong>. Проверено: <strong>${data.checked_count || 0}</strong> · PnL: <strong>${data.pnl_qualified_count || 0}</strong> · win rate: <strong>${data.win_qualified_count || 0}</strong> · активны сегодня: <strong>${data.today_qualified_count || 0}</strong> · прошло всё: <strong>${data.qualified_count || 0}</strong><br>TXT: <span class="address">${esc(data.report_path || 'не удалось сохранить')}</span></p><div class="metrics"><div class="metric"><span>Чистый closed PnL</span><strong>${cash(totals.net_pnl)}</strong></div><div class="metric"><span>Win rate закрытий</span><strong>${pct(totals.profitable_close_rate_pct)}</strong></div><div class="metric"><span>Доходность closed</span><strong>${pct(totals.net_closed_return_pct)}</strong></div><div class="metric"><span>Открытый PnL</span><strong>${cash(totals.open_pnl)}</strong></div><div class="metric"><span>Итоговый PnL</span><strong>${cash(totals.total_pnl_including_open)}</strong></div><div class="metric"><span>Комиссии</span><strong>${cash(-Math.abs(Number(totals.fees || 0)))}</strong></div></div><div class="toolbar"><span class="muted">Процент закрытий считает только closedPnl ≠ 0; нулевые Open fills исключены.</span><button id="export12hPnlCsv" class="pair">Excel CSV</button></div>${whales.length ? `<table><thead><tr><th>#</th><th>Адрес</th><th>Net closed</th><th>Open PnL</th><th>Итог</th><th>Частота</th><th>Прибыльные закрытия</th><th>Позиции в плюсе</th><th>Возраст / активность</th><th>Long / Short</th></tr></thead><tbody>${whales.map((row, index) => `<tr><td>${index + 1}</td><td><a class="address" href="https://app.hyperliquid.xyz/explorer/address/${row.address}" target="_blank" rel="noopener">${row.address}</a></td><td class="${Number(row.net_pnl || 0) >= 0 ? 'green' : 'red'}">${cash(row.net_pnl)}<br><span class="muted">${pct(row.net_closed_return_pct)}</span></td><td class="${Number(row.open_pnl || 0) >= 0 ? 'green' : 'red'}">${cash(row.open_pnl)}</td><td class="${Number(row.total_pnl_including_open || 0) >= 0 ? 'green' : 'red'}">${cash(row.total_pnl_including_open)}</td><td>${esc(row.frequency || '—')}</td><td class="compact-cell">${closeResult(row)}</td><td class="compact-cell">${openResult(row)}</td><td class="compact-cell">${activity(row)}</td><td class="compact-cell">${actions(row)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Нет адресов, одновременно прошедших PnL $1,500, положительный процент закрытий, возраст 120 дней и сделку сегодня.</div>'}`;
      appendDayStatusColumn(box, whales);
      $('#export12hPnlCsv')?.addEventListener('click', () => downloadCsv('hyperliquid_12h_pnl_filtered', whales, [{ label: 'address', value: 'address' }, { label: 'frequency', value: 'frequency' }, { label: 'profitable_close_fills', value: 'profitable_close_fills' }, { label: 'losing_close_fills', value: 'losing_close_fills' }, { label: 'profitable_close_rate_pct', value: 'profitable_close_rate_pct' }, { label: 'gross_profit', value: 'gross_profit' }, { label: 'net_pnl', value: 'net_pnl' }, { label: 'net_closed_return_pct', value: 'net_closed_return_pct' }, { label: 'open_pnl', value: 'open_pnl' }, { label: 'profitable_open_positions', value: 'profitable_open_positions' }, { label: 'losing_open_positions', value: 'losing_open_positions' }, { label: 'open_position_profit_rate_pct', value: 'open_position_profit_rate_pct' }, { label: 'profitable_open_pnl', value: 'profitable_open_pnl' }, { label: 'total_pnl_including_open', value: 'total_pnl_including_open' }, { label: 'first_profitable_close_time', value: 'first_profitable_close_time' }, { label: 'first_profitable_close_age_days', value: 'first_profitable_close_age_days' }, { label: 'last_fill_time', value: 'last_fill_time' }]));
    } catch (error) { box.innerHTML = '<div class="empty">PnL-отчёт за 12 часов недоступен: ' + esc(error.message) + '</div>'; }
  }
  async function load24hDeep() {
    let box = $('#hl24hDeepBox');
    if (!box) {
      box = document.createElement('div'); box.id = 'hl24hDeepBox'; box.className = 'panel'; box.style.marginTop = '16px';
      $('#hlOverview').appendChild(box);
    }
    box.innerHTML = '<div class="empty">Медленно собираю 24-часовой отчёт от $150 и проверяю возраст аккаунтов (без автообновления)...</div>';
    try {
      const params = new URLSearchParams({ coin: selectedCoin(), minUsd: '150', maxAccounts: '30', minAgeDays: '60', feeRate: '0.002' });
      const response = await fetch('/api/hyperliquid/24h-deep?' + params); const data = await response.json();
      if (!response.ok) throw Error(data.error || `HTTP ${response.status}`);
      const totals = data.totals || {}; const accounts = sortByDayStatus(data.accounts || [], 'volume_usd', 'net_pnl', 'gross_profit', 'fills'); const actions = data.actions || {}; const orderTypes = data.order_types || {};
      const money = (value) => `${Number(value || 0) >= 0 ? '+' : '-'}$${fmt(Math.abs(Number(value) || 0), 2)}`;
      const pct = (value) => `${Number(value || 0) >= 0 ? '+' : ''}${Number(value || 0).toFixed(2)}%`;
      const actionText = (row) => { const a = row.actions || {}; return `OL ${a['Open Long']?.fills || 0} · CL ${a['Close Long']?.fills || 0} · OS ${a['Open Short']?.fills || 0} · CS ${a['Close Short']?.fills || 0}`; };
      const typeText = (row) => { const t = row.order_types || {}; return `M ${t['MARKET/TAKER']?.fills || 0} · L ${t['LIMIT/MAKER']?.fills || 0}`; };
      box.innerHTML = `<h2>Глубокий анализ Hyperliquid за 24 часа</h2><p class="note">Монета: <strong>${esc(data.coin || 'ALL')}</strong> · каждая qualifying-сделка от <strong>$${fmt(data.threshold_usd || 150, 0)}</strong> · возраст аккаунта: <strong>не менее ${data.min_age_days || 60} дней</strong> · проверено: <strong>${data.checked_count || 0}</strong> · подходят по возрасту: <strong>${data.eligible_count || 0}</strong> · показано: <strong>${data.selected_count || 0}</strong><br>Файл: <span class="address">${esc(data.report_path || 'не удалось сохранить')}</span>${data.cached ? ' · результат из кэша' : ' · свежий сбор'}</p><div class="metrics"><div class="metric"><span>Грязная закрытая прибыль</span><strong>${money(totals.gross_profit)}</strong></div><div class="metric"><span>Закрытый результат до fee</span><strong>${money(totals.closed_pnl_before_fees)}</strong></div><div class="metric"><span>Комиссии 0.2% / fill</span><strong>${money(-Math.abs(Number(totals.modeled_fees || 0)))}</strong></div><div class="metric"><span>Чистый PnL</span><strong class="${Number(totals.net_pnl || 0) >= 0 ? 'green' : 'red'}">${money(totals.net_pnl)}</strong></div><div class="metric"><span>Net от gross</span><strong class="${Number(totals.net_pct_of_gross_profit || 0) >= 0 ? 'green' : 'red'}">${pct(totals.net_pct_of_gross_profit)}</strong></div><div class="metric"><span>Открытый PnL</span><strong class="${Number(totals.open_pnl || 0) >= 0 ? 'green' : 'red'}">${money(totals.open_pnl)}</strong></div></div><p class="note">Действия: Open Long ${actions['Open Long']?.fills || 0} · Close Long ${actions['Close Long']?.fills || 0} · Open Short ${actions['Open Short']?.fills || 0} · Close Short ${actions['Close Short']?.fills || 0}. Исполнение: Market/Taker ${orderTypes['MARKET/TAKER']?.fills || 0} · Limit/Maker ${orderTypes['LIMIT/MAKER']?.fills || 0}. Открытый PnL показан отдельно и не считается закрытой прибылью.</p><div class="toolbar"><span class="muted">Кандидатов из реального market-потока: ${data.candidate_count || 0} · кэш: 10 минут · автообновления нет</span><button id="export24hDeepCsv" class="pair">Excel CSV</button></div>${accounts.length ? `<table><thead><tr><th>#</th><th>Адрес / возраст</th><th>Fills</th><th>Объём</th><th>Gross</th><th>Fee</th><th>Net</th><th>Net/Gross</th><th>Open PnL</th><th>Open/Close</th><th>Market/Limit</th></tr></thead><tbody>${accounts.map((row, index) => `<tr><td>${index + 1}</td><td><a class="address" href="https://app.hyperliquid.xyz/explorer/address/${row.address}" target="_blank" rel="noopener">${row.address}</a><br><span class="muted">${row.first_operation_time ? esc(new Date(row.first_operation_time).toLocaleDateString('ru-RU')) : '—'} · ${Number(row.first_operation_age_days || 0).toFixed(0)} дн.</span></td><td>${row.fills || 0}</td><td>$${fmt(row.volume_usd || 0, 0)}</td><td>${money(row.gross_profit)}</td><td>${money(-Math.abs(Number(row.modeled_fees || 0)))}</td><td class="${Number(row.net_pnl || 0) >= 0 ? 'green' : 'red'}">${money(row.net_pnl)}</td><td>${pct(row.net_pct_of_gross_profit)}</td><td class="${Number(row.open_pnl || 0) >= 0 ? 'green' : 'red'}">${money(row.open_pnl)}</td><td class="compact-cell">${actionText(row)}</td><td class="compact-cell">${typeText(row)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">За 24 часа не найдено адресов, одновременно прошедших порог и проверку возраста.</div>'}`;
      appendDayStatusColumn(box, accounts);
      $('#export24hDeepCsv')?.addEventListener('click', () => downloadCsv('hyperliquid_24h_deep', accounts, [{ label: 'address', value: 'address' }, { label: 'first_operation_time', value: 'first_operation_time' }, { label: 'first_operation_age_days', value: 'first_operation_age_days' }, { label: 'fills', value: 'fills' }, { label: 'volume_usd', value: 'volume_usd' }, { label: 'gross_profit', value: 'gross_profit' }, { label: 'closed_pnl_before_fees', value: 'closed_pnl_before_fees' }, { label: 'modeled_fees', value: 'modeled_fees' }, { label: 'net_pnl', value: 'net_pnl' }, { label: 'net_pct_of_gross_profit', value: 'net_pct_of_gross_profit' }, { label: 'open_pnl', value: 'open_pnl' }, { label: 'total_pnl_including_open', value: 'total_pnl_including_open' }, { label: 'actions', value: 'actions' }, { label: 'order_types', value: 'order_types' }]));
    } catch (error) { box.innerHTML = '<div class="empty">Глубокий отчёт за 24 часа недоступен: ' + esc(error.message) + '</div>'; }
  }
  function parseCellNumber(value) {
    const match = String(value || '').replace(/\u00a0/g, ' ').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
    return match ? numberValue(match[0]) : 0;
  }
  function sortRenderedTable(table) {
    const headerCells = Array.from(table.tHead?.rows?.[0]?.cells || []);
    const headers = headerCells.map((cell) => String(cell.textContent || '').trim());
    const body = table.tBodies?.[0];
    if (!body || !headers.length) return;
    const rows = Array.from(body.rows);
    const mainRows = rows.filter((row) => !row.classList.contains('trade-detail'));
    if (mainRows.length < 2) return;
    const detailByMain = new Map();
    rows.forEach((row, index) => {
      if (!row.classList.contains('trade-detail')) {
        const next = rows[index + 1];
        if (next?.classList.contains('trade-detail')) detailByMain.set(row, next);
      }
    });
    const isWalletTable = Boolean(table.closest('#hlWallets'));
    const isAddressSummary = Boolean(table.closest('#hlSummary')) && headers.some((header) => /^Buy USD$/i.test(header));
    const totalIndexes = headers.reduce((list, header, index) => {
      if (/^(?:Покупки USD|Продажи USD|Buy USD|Sell USD)$/i.test(header)) list.push(index);
      return list;
    }, []);
    const preferredIndex = [
      /^Всего USD$/i,
      /^Объём USD$/i,
      /^Объём$/i,
      /^USD$/i,
      /^Net$/i,
      /Closed PnL/i,
      /^Gross$/i,
      /Покупки USD/i,
      /Продажи USD/i,
      /Fills|Участий|Частей/i,
      /Цена/i
    ].map((pattern) => headers.findIndex((header) => pattern.test(header))).find((index) => index >= 0);
    if (preferredIndex < 0 && !isWalletTable && !isAddressSummary) return;
    const valueFor = (row) => {
      if ((isWalletTable || isAddressSummary) && totalIndexes.length) return totalIndexes.reduce((sum, index) => sum + parseCellNumber(row.cells[index]?.textContent), 0);
      return parseCellNumber(row.cells[preferredIndex]?.textContent);
    };
    const ordered = mainRows.map((row, index) => ({ row, index, value: valueFor(row) })).sort((a, b) => b.value - a.value || a.index - b.index);
    if (ordered.every((item, index) => item.row === mainRows[index])) return;
    ordered.forEach(({ row }) => {
      body.appendChild(row);
      const detail = detailByMain.get(row);
      if (detail) body.appendChild(detail);
    });
  }
  function installDescendingTableSort() {
    let sorting = false;
    const sortAll = () => {
      if (sorting) return;
      sorting = true;
      document.querySelectorAll('table').forEach(sortRenderedTable);
      sorting = false;
    };
    const observer = new MutationObserver(() => queueMicrotask(sortAll));
    observer.observe(document.body, { childList: true, subtree: true });
    sortAll();
  }
  const pnlNumber = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const pnlMoney = (value) => {
    const amount = pnlNumber(value);
    return `${amount > 0 ? '+' : amount < 0 ? '-' : ''}$${fmt(Math.abs(amount), 2)}`;
  };
  const pnlGroup = (value) => value > 0 ? 'profit' : value < 0 ? 'loss' : 'flat';
  const pnlGroupLabel = (group) => group === 'profit' ? 'Прибыльные' : group === 'loss' ? 'Убыточные' : 'Без результата';
  const pnlGroupClass = (group) => group === 'profit' ? 'green' : group === 'loss' ? 'red' : 'yellow';
  function renderPnlGroups(items, valueOf, renderItem, emptyText) {
    const groups = { profit: [], loss: [], flat: [] };
    (items || []).forEach((item) => groups[pnlGroup(pnlNumber(valueOf(item)))].push(item));
    return `<div class="pnl-groups">${Object.entries(groups).map(([group, rows]) => {
      const total = rows.reduce((sum, item) => sum + pnlNumber(valueOf(item)), 0);
      return `<div class="pnl-group ${group}"><strong class="${pnlGroupClass(group)}">${pnlGroupLabel(group)} · ${rows.length} · ${pnlMoney(total)}</strong><div class="pnl-items">${rows.length ? rows.map(renderItem).join('') : `<span class="muted">${emptyText || 'Нет записей'}</span>`}</div></div>`;
    }).join('')}</div>`;
  }
  function renderPositionGroups(positions) {
    const rows = positions || [];
    const renderPosition = (position) => {
      const value = pnlNumber(position.position_value);
      const pnl = pnlNumber(position.unrealized_pnl);
      const liquidation = position.liquidation_price == null || position.liquidation_price === '' ? '—' : position.liquidation_price;
      return `<div><strong>${esc(position.coin || '—')} ${esc(position.side || '')}</strong> · USD в позиции: $${fmt(Math.abs(value), 2)} · размер: ${fmt(Math.abs(position.size || 0), 6)} · вход: ${fmt(position.entry_price, 6)} · PnL: <strong class="${pnlGroupClass(pnlGroup(pnl))}">${pnlMoney(pnl)}</strong> · ликвидация: ${esc(liquidation)}</div>`;
    };
    return renderPnlGroups(rows, (position) => position.unrealized_pnl, renderPosition, 'Нет позиций в этой категории');
  }
  function renderClosedGroups(fills, fallbackPnl) {
    const rows = (fills || []).filter((fill) => fill.closed_pnl !== undefined && fill.closed_pnl !== null);
    if (!rows.length) return renderPnlGroups([{ closed_pnl: pnlNumber(fallbackPnl) }], (item) => item.closed_pnl, () => `<div>Closed PnL: <strong>${pnlMoney(fallbackPnl)}</strong></div>`, 'Нет закрытых fills');
    return renderPnlGroups(rows, (fill) => fill.closed_pnl, (fill) => `<div>${hlTime(fill.time)} · ${esc(fill.coin || '—')} · ${esc(fill.action || '—')} · <strong>${pnlMoney(fill.closed_pnl)}</strong></div>`, 'Нет закрытых fills');
  }
  function accountOpenPnl(account) {
    if (account && account.unrealized_pnl !== undefined && account.unrealized_pnl !== null) return pnlNumber(account.unrealized_pnl);
    return (account?.positions || []).reduce((sum, position) => sum + pnlNumber(position.unrealized_pnl), 0);
  }
  function renderAccountDetails(account, analysis, options = {}) {
    const data = account || {};
    const closedPnl = analysis?.total_closed_pnl ?? options.closedPnl ?? 0;
    const fills = options.coin ? (analysis?.fills || []).filter((fill) => String(fill.coin || '').toUpperCase() === String(options.coin).toUpperCase()) : (analysis?.fills || []);
    const positions = options.positions || (options.coin ? (data.positions || []).filter((position) => String(position.coin || '').toUpperCase() === String(options.coin).toUpperCase()) : (data.positions || []));
    const openPnl = accountOpenPnl(data);
    const link = data.user || options.user;
    return `<div class="wallet-stats"><div class="wallet-stat"><div class="address">${esc(link || '—')}</div><div>Баланс аккаунта: <strong>$${fmt(data.account_value, 2)}</strong></div><div>Открытый PnL: <strong class="${pnlGroupClass(pnlGroup(openPnl))}">${pnlMoney(openPnl)}</strong></div><div class="muted">Доступно: $${fmt(data.withdrawable, 2)} · Открытые позиции: $${fmt(data.total_position_value, 2)} · Маржа: $${fmt(data.margin_used, 2)}</div><h4>Закрытый PnL · категории</h4>${renderClosedGroups(fills, closedPnl)}<p><a class="address" href="https://app.hyperliquid.xyz/explorer/address/${encodeURIComponent(link || '')}" target="_blank" rel="noopener">Открыть аккаунт Hyperliquid</a></p></div><div class="wallet-stat"><h4>Открытые позиции · категории</h4>${renderPositionGroups(positions)}</div></div>`;
  }
  async function requestJson(url) {
    const response = await fetch(url);
    const data = await response.json();
    if (!response.ok) throw Error(data.error || `HTTP ${response.status}`);
    return data;
  }
  async function loadAccountBundle(user) {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const account = await requestJson(`/api/hyperliquid/account?user=${encodeURIComponent(user)}`);
    let analysis = null;
    try { analysis = await requestJson(`/api/hyperliquid/analysis?user=${encodeURIComponent(user)}&startTime=${start.getTime()}`); } catch (_) { /* Account details remain useful when daily fills are rate limited. */ }
    return { account, analysis };
  }
  async function enhancedLoadOverviewAccount(id, user) {
    const detail = $('#' + id), row = detail?.closest('tr');
    if (!detail || !row) return;
    if (detail.dataset.loaded === 'true') { row.hidden = !row.hidden; return; }
    row.hidden = false; detail.innerHTML = '<div class="muted">Загрузка баланса, закрытого PnL и категорий позиций...</div>';
    try {
      const bundle = await loadAccountBundle(user);
      detail.dataset.loaded = 'true'; detail.innerHTML = renderAccountDetails(bundle.account, bundle.analysis, { user });
    } catch (error) { detail.innerHTML = '<div class="red">Не удалось загрузить состояние аккаунта: ' + esc(error.message) + '</div>'; }
  }
  async function enhancedLoadTradeWallets(id, addresses) {
    const detail = $('#' + id), row = detail?.closest('tr');
    if (!detail || !row) return;
    if (detail.dataset.loaded === 'true') { row.hidden = !row.hidden; return; }
    row.hidden = false; detail.innerHTML = '<div class="muted">Загрузка PnL и категорий позиций участников...</div>';
    const users = [...new Set((addresses || []).filter((address) => /^0x[a-fA-F0-9]{40}$/.test(address)))];
    if (!users.length) { detail.innerHTML = '<div class="muted">Hyperliquid не передал адреса участников для этой сделки.</div>'; return; }
    try {
      const result = await Promise.all(users.map(async (user) => ({ user, ...(await loadAccountBundle(user)) })));
      detail.dataset.loaded = 'true'; detail.innerHTML = '<div class="note">Позиции распределены по PnL: плюс — «Прибыльные», минус — «Убыточные».</div>' + result.map((item) => renderAccountDetails(item.account, item.analysis, { user: item.user })).join('');
    } catch (error) { detail.innerHTML = '<div class="red">Не удалось загрузить категории PnL: ' + esc(error.message) + '</div>'; }
  }
  async function enhancedLoadTradeParticipants(id, trade) {
    const detail = $('#' + id), row = detail?.closest('tr');
    if (!detail || !row) return;
    if (detail.dataset.loaded === 'true') { row.hidden = !row.hidden; return; }
    row.hidden = false; detail.innerHTML = '<div class="muted">Сопоставляю сделку, закрытый PnL и категории позиций...</div>';
    try {
      const query = new URLSearchParams({ coin: trade.coin, tradeId: trade.trade_id, time: String(trade.time), addresses: (trade.participants || []).join(',') });
      const data = await requestJson('/api/hyperliquid/trade-participants?' + query);
      detail.dataset.loaded = 'true';
      detail.innerHTML = `<div class="note">Рыночная сторона: ${trade.side === 'BUY' ? 'ПОКУПКА' : 'ПРОДАЖА'}. Плюс относится к прибыльным, минус — к убыточным позициям и закрытым fills.</div><div class="wallet-stats">${(data.participants || []).map((participant) => {
        const closed = participant.closed_pnl;
        const openPnl = participant.unrealized_pnl;
        const positionGroups = renderPositionGroups(participant.positions || []);
        const closedGroups = renderClosedGroups([], closed);
        return `<div class="wallet-stat"><div class="address">${esc(participant.address)}</div><div>Позиционное действие: <strong>${esc(participant.action || 'не определено')}</strong></div><div class="muted">${participant.matched ? `Сторона исполнения: ${esc(participant.side || '—')} · цена ${fmt(participant.price, 6)} · размер ${fmt(participant.size, 6)}` : 'Fill этой сделки не найден в доступной истории адреса.'}</div><h4>Закрытый PnL этой сделки · категория</h4>${closed === null || closed === undefined ? '<div class="muted">Нет данных о закрытом PnL</div>' : closedGroups}<h4>Открытый PnL · категории позиций</h4>${positionGroups}<div class="muted">Баланс: ${participant.account_value == null ? '—' : '$' + fmt(participant.account_value, 2)} · Доступно: ${participant.withdrawable == null ? '—' : '$' + fmt(participant.withdrawable, 2)} · Итого открытый PnL: <strong class="${pnlGroupClass(pnlGroup(openPnl))}">${pnlMoney(openPnl)}</strong></div><p><a class="address" href="https://app.hyperliquid.xyz/explorer/address/${encodeURIComponent(participant.address || '')}" target="_blank" rel="noopener">Открыть аккаунт</a></p></div>`;
      }).join('')}</div>`;
      addSaveButtonsToParticipants(detail);
    } catch (error) { detail.innerHTML = '<div class="red">Не удалось сопоставить категории PnL: ' + esc(error.message) + '</div>'; }
  }
  async function enhancedLoadIcebergAccount(id, user, signal, coin) {
    const detail = $('#' + id), row = detail?.closest('tr');
    if (!detail || !row) return;
    if (detail.dataset.loaded === 'true') { row.hidden = !row.hidden; return; }
    row.hidden = false; detail.innerHTML = '<div class="muted">Загрузка баланса, закрытого PnL и категорий позиций...</div>';
    try {
      const bundle = await loadAccountBundle(user);
      const positions = (bundle.account.positions || []).filter((position) => String(position.coin || '').toUpperCase() === String(coin || '').toUpperCase());
      const label = signal?.side === 'BUY' ? 'ПОКУПКА' : 'ПРОДАЖА';
      detail.dataset.loaded = 'true'; detail.innerHTML = `<div class="note">Сигнал: ${label} на $${fmt(signal?.usd, 2)} · ${signal?.parts || 0} частей. Позиции ниже распределены по открытому PnL.</div>${renderAccountDetails(bundle.account, bundle.analysis, { user, coin, positions })}`;
    } catch (error) { detail.innerHTML = '<div class="red">Не удалось загрузить категории PnL: ' + esc(error.message) + '</div>'; }
  }
  async function enhancedLoadWalletAccount(id, user, closedPnl = 0) {
    const detail = $('#' + id), row = detail?.closest('tr');
    if (!detail || !row) return;
    if (detail.dataset.loaded === 'true') { row.hidden = !row.hidden; return; }
    row.hidden = false; detail.innerHTML = '<div class="muted">Загрузка баланса и категорий PnL...</div>';
    try {
      const bundle = await loadAccountBundle(user);
      detail.dataset.loaded = 'true'; detail.innerHTML = renderAccountDetails(bundle.account, bundle.analysis, { user, closedPnl });
    } catch (error) { detail.innerHTML = '<div class="red">Не удалось загрузить категории PnL: ' + esc(error.message) + '</div>'; }
  }
  function renderBybitApiStatus(status) {
    const dot = $('#bybitApiDot');
    const label = $('#bybitApiStatus');
    const message = $('#bybitApiMessage');
    if (!dot || !label || !message) return;
    dot.className = 'api-status-dot ' + (status?.connected ? 'connected' : status?.configured ? 'error' : 'warning');
    label.textContent = status?.connected ? 'Подключён' : status?.configured ? 'Не подключён' : 'Ключ не задан';
    $('#bybitApiEnvironment').textContent = status?.environment === 'testnet' ? 'Testnet' : 'Mainnet';
    $('#bybitApiKeyType').textContent = status?.key_type || 'HMAC';
    $('#bybitApiMasked').textContent = status?.key_masked || '—';
    $('#bybitApiChecked').textContent = status?.checked_at ? new Date(status.checked_at).toLocaleTimeString('ru-RU') : '—';
    if ($('#bybitApiTestnet') && status?.configured) $('#bybitApiTestnet').checked = status.environment === 'testnet';
    message.className = 'note ' + (status?.connected ? 'green' : status?.configured ? 'red' : 'yellow');
    message.textContent = status?.connected ? `Проверка чтения подтверждена (${status.account_type || 'UNIFIED'}).` : (status?.error || 'Подключение не подтверждено.');
  }
  async function loadBybitApiStatus() {
    try {
      const response = await fetch('/api/bybit/api-status'); const status = await response.json();
      if (!response.ok) throw Error(status.error || `HTTP ${response.status}`);
      renderBybitApiStatus(status); return status;
    } catch (error) {
      renderBybitApiStatus({ configured: false, connected: false, error: 'Сервер API недоступен: ' + error.message });
      return null;
    }
  }
  async function saveBybitApiConfig() {
    const key = ($('#bybitApiKey')?.value || '').trim();
    const secret = ($('#bybitApiSecret')?.value || '').trim();
    const button = $('#saveBybitApi');
    if (!key || !secret) { renderBybitApiStatus({ configured: false, connected: false, error: 'Введите API Key и API Secret.' }); return; }
    if (button) { button.disabled = true; button.textContent = 'Проверка...'; }
    try {
      const response = await fetch('/api/bybit/api-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: key, api_secret: secret, testnet: Boolean($('#bybitApiTestnet')?.checked) }) });
      const data = await response.json(); if (!response.ok) throw Error(data.error || `HTTP ${response.status}`);
      if ($('#bybitApiKey')) $('#bybitApiKey').value = ''; if ($('#bybitApiSecret')) $('#bybitApiSecret').value = '';
      renderBybitApiStatus(data.status || {});
    } catch (error) {
      renderBybitApiStatus({ configured: false, connected: false, error: error.message });
    } finally { if (button) { button.disabled = false; button.textContent = 'Сохранить и проверить'; } }
  }
  function radarMoney(value) { return `${Number(value || 0) >= 0 ? '+' : '-'}$${fmt(Math.abs(Number(value || 0)), 2)}`; }
  function renderRadar(data) {
    const box = $('#hlRadarResults'); if (!box) return;
    const rows = data.addresses || [];
    $('#hlRadarCount').textContent = `Найдено адресов: ${data.count || 0}`;
    $('#hlRadarState').textContent = data.running ? (data.scanning ? 'Сканирование...' : 'Радар запущен') : 'Радар остановлен';
    $('#hlRadarState').className = 'muted ' + (data.running ? 'green' : 'yellow');
    $('#hlRadarAddressText').value = rows.map((row) => row.address).join(', ');
    box.innerHTML = rows.length ? `<table><thead><tr><th>Адрес</th><th>Баланс</th><th>Closed PnL</th><th>Open PnL</th><th>Итог</th><th>Время PnL</th><th>Возраст аккаунта</th><th>Open / Close</th></tr></thead><tbody>${rows.map((row) => { const actions = row.actions || {}; return `<tr><td class="address">${esc(row.address)}</td><td>$${fmt(row.account_value, 2)}</td><td class="green">${radarMoney(row.closed_pnl)}</td><td class="green">${radarMoney(row.open_pnl)}</td><td class="green">${radarMoney(row.total_pnl)}</td><td>${fmt(Number(row.pnl_duration_seconds || 0) / 3600, 2)} ч</td><td>${fmt(row.account_age_days, 0)} дн.</td><td>OL ${actions['Open Long'] || 0} · CL ${actions['Close Long'] || 0}<br>OS ${actions['Open Short'] || 0} · CS ${actions['Close Short'] || 0}</td></tr>`; }).join('')}</tbody></table>` : '<div class="empty">Пока нет адресов, прошедших все фильтры.</div>';
  }
  async function refreshRadar() { try { const response = await fetch('/api/hyperliquid/radar/status'); const data = await response.json(); if (!response.ok) throw Error(data.error || `HTTP ${response.status}`); renderRadar(data); } catch (error) { if ($('#hlRadarState')) $('#hlRadarState').textContent = 'Радар недоступен: ' + error.message; } }
  async function startRadar() {
    const button = $('#hlRadarStart'); if (button) button.disabled = true;
    try { const response = await fetch('/api/hyperliquid/radar/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ window_seconds: Number($('#hlRadarWindow').value), min_pnl: Number($('#hlRadarMinPnl').value) }) }); const data = await response.json(); if (!response.ok) throw Error(data.error || `HTTP ${response.status}`); renderRadar(data); } catch (error) { $('#hlRadarState').textContent = 'Ошибка запуска: ' + error.message; } finally { if (button) button.disabled = false; }
  }
  async function stopRadar() { const response = await fetch('/api/hyperliquid/radar/stop', { method: 'POST' }); renderRadar(await response.json()); }
  function injectRadarPanel() {
    if ($('#hlRadarPanel')) return;
    const view = $('#hlOverview'); if (!view) return;
    const panel = document.createElement('div'); panel.id = 'hlRadarPanel'; panel.className = 'panel'; panel.style.marginTop = '16px'; panel.innerHTML = '<h2>Радар свежих PnL-адресов</h2><p class="note">Отдельная база: hyperliquid_radar.sqlite3. Радар ищет подтверждённые Open/Close fills, PnL от заданного порога, возраст аккаунта от 5 месяцев и последний fill не старше 1 минуты. Повторные адреса не добавляются.</p><div class="toolbar"><label class="pair">Окно PnL <select id="hlRadarWindow"><option value="1">1 секунда</option><option value="3600">1 час</option><option value="86400" selected>1 день</option><option value="172800">2 дня</option><option value="259200">3 дня</option></select></label><label class="pair">Минимум PnL <input id="hlRadarMinPnl" class="input" style="width:120px;min-width:120px" type="number" min="0" step="100" value="1500"></label><button class="btn" id="hlRadarStart">Запустить радар</button><button class="pair" id="hlRadarStop">Стоп</button><span id="hlRadarState" class="muted">Радар остановлен</span><span id="hlRadarCount" class="muted">Найдено адресов: 0</span></div><div class="toolbar"><input id="hlRadarAddressText" class="input" style="flex:1;min-width:320px" readonly placeholder="Адреса, найденные радаром, появятся здесь через запятую"></div><div id="hlRadarResults"><div class="empty">Нажмите «Запустить радар».</div></div>'; view.appendChild(panel); $('#hlRadarStart').onclick = startRadar; $('#hlRadarStop').onclick = stopRadar; refreshRadar(); setInterval(refreshRadar, 10000);
  }
  async function saveOnchainAddress(address, button) {
    button.disabled = true;
    try { const response = await fetch('/api/dex/onchain/addresses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address }) }); const data = await response.json(); if (!response.ok) throw Error(data.error || `HTTP ${response.status}`); button.textContent = 'Сохранено'; button.classList.add('saved'); $('#dexSavedCount').textContent = `Сохранено on-chain адресов: ${data.addresses.length}`; } catch (error) { button.disabled = false; button.textContent = 'Сохранить'; button.title = error.message; }
  }
  function showDexAddressDetails(address, stats) {
    const row = stats?.[address] || { address, buy_count: 0, sell_count: 0, buy_amount: 0, sell_amount: 0, buy_usd: 0, sell_usd: 0, estimated_result_usd: 0, total_count: 0, frequency_blocks: 0 };
    const detail = document.querySelector(`[data-dex-detail="${address}"]`); if (!detail) return; detail.hidden = !detail.hidden;
    if (!detail.hidden) detail.querySelector('div').innerHTML = `<div class="wallet-stats"><div class="wallet-stat"><h4>Покупки токена</h4>${row.buy_count} транзакций · ${fmt(row.buy_amount, 6)} токенов · $${fmt(row.buy_usd, 2)}</div><div class="wallet-stat"><h4>Продажи токена</h4>${row.sell_count} транзакций · ${fmt(row.sell_amount, 6)} токенов · $${fmt(row.sell_usd, 2)}</div><div class="wallet-stat"><h4>Частота</h4>Всего: ${row.total_count} операций · примерно каждые ${fmt(row.frequency_blocks, 0)} блоков</div><div class="wallet-stat"><h4>PnL</h4>Расчётная разница потоков: <span class="${row.estimated_result_usd >= 0 ? 'green' : 'red'}">${radarMoney(row.estimated_result_usd)}</span><br><span class="muted">Точный closed/open PnL Dexscreener не предоставляет.</span></div></div>`;
  }
  async function loadDexOnchainBuys() {
    const box = $('#dexOnchainResults'); const chain = $('#dexChain').value; const token = $('#dexToken').value.trim(); const minUsd = $('#dexMinUsd').value;
    box.innerHTML = '<div class="empty">Ищу крупные покупки в последних блоках...</div>';
    try {
      const response = await fetch('/api/dex/onchain?' + new URLSearchParams({ chain, token, minUsd })); const data = await response.json(); if (!response.ok) throw Error(data.error || `HTTP ${response.status}`);
      const pair = data.pair || {}; const buyers = data.buyers || []; const stats = Object.fromEntries((data.address_stats || []).map((row) => [row.address, row])); const uniqueBuyers = new Map(); buyers.forEach((row) => { if (!uniqueBuyers.has(row.address) || uniqueBuyers.get(row.address).estimated_usd < row.estimated_usd) uniqueBuyers.set(row.address, row); }); const profitableBuyers = [...uniqueBuyers.values()].filter((row) => Number(stats[row.address]?.estimated_result_usd || 0) > 0); window.dexOnchainStats = stats;
      box.innerHTML = `<div class="toolbar"><span class="muted">Пара: ${esc(pair.name || '—')} · цена: $${fmt(pair.price_usd, 8)} · ликвидность: $${fmt(pair.liquidity_usd, 0)} · блоков: ${data.blocks_scanned || 0}</span><span id="dexSavedCount" class="muted">Сохранённые адреса загружаются...</span></div><p class="note">Показаны адреса с положительной расчётной разницей потоков. Изменение цены: 5м ${esc(String(pair.price_change?.m5 ?? '—'))}% · 1ч ${esc(String(pair.price_change?.h1 ?? '—'))}% · 24ч ${esc(String(pair.price_change?.h24 ?? '—'))}%. Адрес является получателем swap-лога; router может быть контрактом.</p>${profitableBuyers.length ? `<table><thead><tr><th>Получатель swap</th><th>Покупка токенов</th><th>Оценка USD</th><th>Блок</th><th>Действия</th></tr></thead><tbody>${profitableBuyers.map((row) => `<tr><td><button class="address wallet-address" onclick="showDexAddressDetails('${row.address}',window.dexOnchainStats)">${row.address}</button></td><td>${fmt(row.amount, 6)}</td><td>$${fmt(row.estimated_usd, 2)}</td><td>${row.block}</td><td><button class="pair" onclick="saveOnchainAddress('${row.address}',this)">Сохранить</button></td></tr><tr class="trade-detail" hidden data-dex-detail="${row.address}"><td colspan="5"><div></div></td></tr>`).join('')}</tbody></table>` : '<div class="empty">Расчётно прибыльных адресов в выбранном диапазоне не найдено.</div>'}`;
      const saved = await (await fetch('/api/dex/onchain/addresses')).json(); $('#dexSavedCount').textContent = `Сохранено on-chain адресов: ${(saved.addresses || []).length}`;
    } catch (error) { box.innerHTML = '<div class="empty">On-chain поиск недоступен: ' + esc(error.message) + '</div>'; }
  }
  function injectDexOnchainPanel() {
    if ($('#dexOnchain')) return;
    const footer = document.querySelector('.footer'); if (!footer) return;
    const view = document.createElement('section'); view.id = 'dexOnchain'; view.className = 'view'; view.innerHTML = '<div class="panel"><h2>On-chain крупные покупки</h2><p class="note">Без ключей: Dexscreener выбирает наиболее ликвидную пару токена, публичный RPC читает swap-логи последних блоков. Поддерживаются BSC, Ethereum и Base.</p><div class="toolbar"><label class="pair">Сеть <select id="dexChain"><option value="bsc">BSC</option><option value="ethereum">Ethereum</option><option value="base">Base</option></select></label><input id="dexToken" class="input" placeholder="Адрес токена 0x..."><label class="pair">От $ <input id="dexMinUsd" class="input" style="width:110px;min-width:110px" type="number" min="0" step="100" value="1000"></label><button id="loadDexOnchain" class="btn">Найти покупки</button></div><div id="dexOnchainResults"><div class="empty">Введите адрес токена и запустите поиск.</div></div></div>';
    footer.before(view); window.saveOnchainAddress = saveOnchainAddress; window.showDexAddressDetails = showDexAddressDetails; $('#loadDexOnchain').onclick = loadDexOnchainBuys;
  }
  function injectControls() {
    const toolbar = $('#hlOverviewCoin')?.parentElement; if (!toolbar || $('#hlUseSavedAddresses')) return;
    const limit = document.createElement('select'); limit.id = 'hlOverviewLimit'; limit.className = 'input'; limit.innerHTML = '<option value="100">100 значений</option><option value="200">200 значений</option><option value="500">500 значений</option><option value="custom">Произвольное</option>'; toolbar.insertBefore(limit, $('#loadHlOverview'));
    const custom = document.createElement('input'); custom.id = 'hlOverviewCustomLimit'; custom.className = 'input'; custom.type = 'number'; custom.min = '1'; custom.max = '500'; custom.placeholder = 'Максимум значений'; custom.hidden = true; toolbar.insertBefore(custom, $('#loadHlOverview')); limit.onchange = () => { custom.hidden = limit.value !== 'custom'; };
    const panel = document.createElement('div'); panel.className = 'panel'; panel.style.marginBottom = '16px'; panel.innerHTML = '<div class="toolbar"><label class="pair"><input id="hlUseSavedAddresses" type="checkbox"> анализировать сохранённые адреса</label><input id="hlSavedAddresses" class="input" style="flex:1;min-width:320px" placeholder="Адреса через запятую: 0x..., 0x..."><button class="pair" id="saveHlAddresses">Сохранить адреса</button><span id="hlSavedStatus" class="muted">Адреса хранятся локально в проекте</span></div>'; const view = $('#hlOverview'); view.insertBefore(panel, view.firstElementChild.nextElementSibling); $('#saveHlAddresses').onclick = saveAddresses; loadSaved();
    const exportButton = addExportButton(toolbar, '#exportHlTradesCsv', 'Excel CSV', () => downloadCsv('hyperliquid_trades', enhanced.trades, [{ label: 'time', value: 'time' }, { label: 'coin', value: 'coin' }, { label: 'side', value: 'side' }, { label: 'price', value: 'price' }, { label: 'size', value: 'size' }, { label: 'usd', value: 'usd' }]));
    const minimum = document.createElement('input'); minimum.id = 'hlOverviewMinUsd'; minimum.className = 'input'; minimum.type = 'number'; minimum.min = '0'; minimum.step = '1'; minimum.placeholder = 'Минимум USD'; minimum.title = 'Скрыть сделки ниже указанного USD-эквивалента'; minimum.style.width = '160px'; toolbar.insertBefore(minimum, exportButton);
    addExportButton(toolbar, '#run24hAnalysis', '24ч / $5k / 500', load24hAnalysis).title = 'Реальный анализ за 24 часа: порог $5,000 и до 500 адресов';
    addExportButton(toolbar, '#run12hWhales', '12ч / $500 / киты', load12hWhales).title = 'Точные fills китов за 12 часов: Long/Short, Open/Close, PnL и комиссии';
    addExportButton(toolbar, '#run12hPnl1500', '12ч / PnL $1.5k', load12hPnl1500).title = 'Сохранённые адреса и текущий поток: net closed PnL плюс open PnL от $1,500';
    addExportButton(toolbar, '#run24hDeep', '24ч / $150 / возраст', load24hDeep).title = 'Медленный точный отчёт: fills от $150, аккаунты старше 60 дней, Open/Close Long/Short, Market/Limit, PnL';
    addExportButton(toolbar, '#runPaperBacktest', 'Paper $1k', loadPaperBacktest).title = 'Симуляция следования самому прибыльному сохранённому адресу за сегодня';
  }
  function start() {
    injectControls();
    injectRadarPanel();
    injectDexOnchainPanel();
    wrapParticipantDetails();
    const style = document.createElement('style');
    style.textContent = '.address-actions{display:flex;align-items:center;gap:6px}.save-detected-address{margin-left:8px;min-width:32px;padding:4px 8px}.address-actions .save-detected-address{margin-left:0}.save-detected-address.saved{border-color:var(--cyan);color:var(--cyan)}.pnl-groups{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px;margin-top:8px}.pnl-group{padding:9px;border:1px solid var(--line);border-radius:7px;background:#0d151f}.pnl-group.profit{border-color:rgba(85,214,194,.45)}.pnl-group.loss{border-color:rgba(255,139,147,.45)}.pnl-group.flat{border-color:rgba(241,207,105,.45)}.pnl-items{margin-top:6px;color:var(--muted);line-height:1.45;max-height:300px;overflow:auto}.wallet-stat h4{margin:10px 0 6px;color:var(--muted);font-size:12px}';
    document.head.appendChild(style);
    installDescendingTableSort();
    window.loadHlOverview = enhancedLoadHlOverview;
    window.loadTradeWallets = enhancedLoadTradeWallets;
    window.loadOverviewAccount = enhancedLoadOverviewAccount;
    window.loadTradeParticipants = enhancedLoadTradeParticipants;
    window.loadIcebergAccount = enhancedLoadIcebergAccount;
    window.loadWalletAccount = enhancedLoadWalletAccount;
    const button = $('#loadHlOverview');
    if (button) button.onclick = () => enhancedLoadHlOverview();
    const icebergButton = $('#loadHlIcebergs');
    if (icebergButton) icebergButton.onclick = () => loadEnhancedIcebergs().catch((error) => { $('#hlIcebergs').innerHTML = '<div class="empty">Сигналы недоступны: ' + esc(error.message) + '</div>'; });
    const originalAuto = $('#hlOverviewAuto');
    if (originalAuto) originalAuto.onchange = () => { if (originalAuto.checked) enhancedLoadHlOverview(); };
    const apiTab = document.querySelector('[data-view="apiToken"]');
    if (apiTab) apiTab.addEventListener('click', loadBybitApiStatus);
    const saveApi = $('#saveBybitApi'); if (saveApi) saveApi.onclick = saveBybitApiConfig;
    const testApi = $('#testBybitApi'); if (testApi) testApi.onclick = () => { testApi.disabled = true; loadBybitApiStatus().finally(() => { testApi.disabled = false; }); };
    loadBybitApiStatus();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
}());
