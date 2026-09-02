(function () {
  'use strict';

  if (window.location.protocol === 'file:') {
    window.location.replace('http://localhost:4174/');
    return;
  }

  const $ = (selector) => document.querySelector(selector);
  const PAGE_SIZE = 25;
  const enhanced = { limit: 100, page: { trades: 1, people: 1, icebergs: 1 }, trades: [], people: [], icebergs: [], saved: [], secondaryAddresses: [], savedCursor: 0, marketInfo: null, loading: false, detailsLoading: false, notificationGroups: {} };
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
      // The copy panel may render before the saved-address request completes.
      // Refresh it once the addresses arrive so the live portfolio rows appear
      // without requiring a second manual click.
      if ($('#hlCopyTradePanel')) refreshCopyPanel();
    } catch (error) { if ($('#hlSavedStatus')) $('#hlSavedStatus').textContent = 'Не удалось прочитать локальные адреса'; }
    if ($('#hlUseSavedAddresses')?.checked) loadSavedLeaderSummary();
  }
  const expandedLeaderPortfolios = new Set();
  const leaderPortfolioCache = new Map();
  const leaderPortfolioPrefetching = new Set();
  async function prefetchLeaderPortfolios(addresses) {
    for (const address of [...new Set(addresses || [])]) {
      const key = String(address || '').toLowerCase();
      if (!/^0x[a-f0-9]{40}$/.test(key) || leaderPortfolioPrefetching.has(key)) continue;
      const cached = leaderPortfolioCache.get(key);
      if (cached && Date.now() - cached.loadedAt < 60000) continue;
      leaderPortfolioPrefetching.add(key);
      try {
        const response = await fetch('/api/hyperliquid/account?user=' + encodeURIComponent(key) + '&_ts=' + Date.now(), { cache: 'no-store' });
        const data = await response.json();
        if (response.ok) leaderPortfolioCache.set(key, { data, loadedAt: Date.now() });
      } catch (_) { /* Clicking the address retries a failed live request. */ }
      finally { leaderPortfolioPrefetching.delete(key); }
    }
  }
  async function loadSavedLeaderSummary() {
    const box = $('#hlSavedLeaderSummary'); if (!box) return;
    box.innerHTML = '<div class="empty">Анализирую сохранённые адреса...</div>';
    try { const response = await fetch('/api/hyperliquid/saved-leader-summary'); const data = await response.json(); if (!response.ok) throw Error(data.error || `HTTP ${response.status}`); const card = (title, row) => { if (!row) return `<div class="wallet-stat"><h3>${title}</h3><div class="muted">Нет данных</div></div>`; const latest = row.latest_buy; const position = row.positions?.slice().sort((a,b) => Number(b.unrealized_pnl||0)-Number(a.unrealized_pnl||0))[0]; const portfolioId = `leader-portfolio-${String(row.address).toLowerCase().replace(/[^a-z0-9]/g, '')}`; const orderButton = position ? `<button type="button" class="btn prepare-leader-order" data-address="${esc(row.address)}" data-coin="${esc(position.coin)}" data-side="${esc(position.side)}">Подготовить лимитную заявку · $10</button>` : ''; return `<div class="wallet-stat"><h3>${title}</h3><button type="button" class="address wallet-address leader-portfolio-button" data-address="${esc(row.address)}" data-target="${portfolioId}">${esc(row.address)}</button><div class="green">Closed PnL: +$${fmt(row.closed_pnl,2)}</div><div class="green">Open PnL: +$${fmt(row.open_pnl,2)}</div><div>Свежая покупка: <strong>${latest ? `${esc(latest.coin)} · ${latest.direction} · ${hlTime(latest.time)}` : 'нет'}</strong></div><div>Лучшая открытая позиция: ${position ? `${esc(position.coin)} ${position.side === 'Buy' ? 'LONG' : 'SHORT'} · $${fmt(position.position_value,2)} · PnL ${position.unrealized_pnl >= 0 ? '+' : ''}$${fmt(position.unrealized_pnl,2)}` : 'нет'}</div>${orderButton}<div id="${portfolioId}" class="leader-portfolio-detail" hidden></div></div>`; }; box.innerHTML = `<div class="toolbar"><label class="pair"><input id="notifyLeader" type="checkbox" ${notificationState.leader ? 'checked' : ''}> уведомлять лидера</label><label class="pair"><input id="notifySaved" type="checkbox" ${notificationState.saved ? 'checked' : ''}> уведомлять сохранённые адреса</label><span class="muted">проверка каждые 15 секунд</span></div><div class="wallet-stats">${card('Лучший лидер по закрытому PnL', data.best_closed)}${card('Лучший лидер по открытому PnL', data.best_open)}</div><div class="muted">Проверено сохранённых адресов: ${data.checked} · обновлено: ${new Date(data.updated_at).toLocaleTimeString('ru-RU')}</div>`; box.querySelectorAll('.leader-portfolio-button').forEach((button) => { button.onclick = () => loadLeaderPortfolio(button.dataset.address, button.dataset.target); }); expandedLeaderPortfolios.forEach((address) => { const button=box.querySelector(`.leader-portfolio-button[data-address=\"${address}\"]`); if (button) loadLeaderPortfolio(address, button.dataset.target); }); box.querySelectorAll('.prepare-leader-order').forEach((button) => { button.onclick = async () => { const panel = $('#hlCopyTradePanel'); if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' }); await refreshCopyPanel(); }; }); const leaderAddress=(data.best_closed||data.best_open||{}).address; $('#notifyLeader').onchange=(event)=>{ notificationState.leader=event.target.checked; requestNotificationPermission(); startNotificationPolling(leaderAddress); }; $('#notifySaved').onchange=(event)=>{ notificationState.saved=event.target.checked; requestNotificationPermission(); startNotificationPolling(leaderAddress); }; startNotificationPolling(leaderAddress); } catch (error) { box.innerHTML = `<div class="red">Не удалось проанализировать сохранённые адреса: ${esc(error.message)}</div>`; }
  }
  async function loadLeaderPortfolio(address, targetId) { const detail=$('#'+targetId); if (!detail) return; const key=String(address).toLowerCase(); if (!detail.hidden) { detail.hidden=true; expandedLeaderPortfolios.delete(key); return; } expandedLeaderPortfolios.add(key); detail.hidden=false; detail.innerHTML='<div class="muted">Загружаю подготовленные live-данные портфеля...</div>'; try { const cached=leaderPortfolioCache.get(key); const response=cached && Date.now()-cached.loadedAt < 60000 ? null : await fetch('/api/hyperliquid/account?user='+encodeURIComponent(address)+'&_ts='+Date.now(),{cache:'no-store'}); const data=response ? await response.json() : cached.data; if(response && !response.ok) throw Error(data.error||`HTTP ${response.status}`); leaderPortfolioCache.set(key,{data,loadedAt:Date.now()}); const positions=(data.positions||[]).map((position)=>{const pct=radarPnlPercent(position);return `<div><strong>${esc(position.coin)} ${position.side==='Buy'?'LONG':'SHORT'}</strong> · объём $${fmt(position.position_value,2)} · PnL <span class="${Number(position.unrealized_pnl||0)>=0?'green':'red'}">${Number(position.unrealized_pnl||0)>=0?'+':''}$${fmt(position.unrealized_pnl,2)} (${pct>=0?'+':''}${fmt(pct,3)}%)</span> · вход ${fmt(position.entry_price,6)} · открыта ${position.opened_at ? hlTime(position.opened_at) : 'время открытия неизвестно'}</div>`}).join('')||'Открытых позиций нет'; const fills=(data.fills||[]).map((fill)=>`<div>${hlTime(fill.time)} · <strong>${esc(fill.coin)} ${esc(fill.action)}</strong> · объём $${fmt(fill.usd,2)} · PnL ${Number(fill.closed_pnl||0)>=0?'+':''}$${fmt(fill.closed_pnl,2)}</div>`).join('')||'Закрытых сделок за 7 дней нет'; detail.innerHTML=`<div class="wallet-stat"><strong>Портфель адреса</strong><div>Баланс: $${fmt(data.account_value,2)} · Доступно: $${fmt(data.withdrawable,2)} · Open PnL: <span class="${Number(data.unrealized_pnl||0)>=0?'green':'red'}">${Number(data.unrealized_pnl||0)>=0?'+':''}$${fmt(data.unrealized_pnl,2)}</span></div><h4>Открытые позиции</h4><div class="notification-history">${positions}</div><h4>Открытые и закрытые операции за 7 дней</h4><div class="notification-history">${fills}</div></div>`; } catch(error) { detail.innerHTML='<div class="red">Портфель недоступен: '+esc(error.message)+'</div>'; } }
  async function requestNotificationPermission() { if (notificationState.leader || notificationState.saved) { try { if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission(); } catch (_) {} } }
  function ensureTradeNotifications() { let box=$('#hlTradeNotifications'); if (!box) { const summary=$('#hlSavedLeaderSummary'); const stats=summary?.querySelector('.wallet-stats'); if (!stats) return null; box=document.createElement('div'); box.id='hlTradeNotifications'; box.className='panel notification-panel'; box.innerHTML='<h3>Уведомления о покупках и продажах</h3>'; stats.insertAdjacentElement('afterend',box); } return box; }
  function renderLeaderActivity() { const summary=$('#hlSavedLeaderSummary'); const stats=summary?.querySelector('.wallet-stats'); if (!stats) return; let box=$('#hlLeaderActivity'); if (!box) { box=document.createElement('section'); box.id='hlLeaderActivity'; box.className='panel notification-panel'; stats.insertAdjacentElement('afterend',box); } const rows=notificationState.leaderEvents.slice(-50).reverse().map((event)=>`<div class="notification-event"><strong class="${String(event.action).startsWith('Open')?'green':'yellow'}">${esc(event.action)}</strong><span>${esc(event.coin)} · $${fmt(event.usd,2)} · ${hlTime(event.time)} · ${esc(event.address)}</span></div>`).join(''); box.innerHTML=`<h3>Операции лучшего лидера в реальном времени</h3><div class="muted">${esc(notificationState.leaderAddress || 'Адрес не выбран')} · проверка каждые 15 секунд</div><div class="notification-history">${rows || '<div class="muted">Новых покупок или продаж пока нет. Блок обновится при следующей операции лидера.</div>'}</div>`; }
  function renderNotificationGroups() { const box=$('#hlTradeNotifications'); if (!box) return; const groups=Object.values(enhanced.notificationGroups||{}).sort((a,b)=>Number(b.latest?.time||0)-Number(a.latest?.time||0)); const cards=groups.map((group,index)=>{const latest=group.latest||{};const details=group.events.slice().sort((a,b)=>Number(b.time||0)-Number(a.time||0)).map(event=>`<div class="notification-event"><span>${hlTime(event.time)} · ${esc(event.action)} · ${esc(event.coin)} · $${fmt(event.usd,2)} · ${esc(event.address)}</span></div>`).join('');return `<details class="notification-group" ${index===0?'open':''}><summary><span class="yellow">${esc(group.address)} · ${esc(group.coin)} · ${esc(group.action)}</span><span class="muted">${group.events.length} раз · всего $${fmt(group.totalUsd,2)} · последняя ${hlTime(latest.time)}</span></summary><div class="notification-history">${details}</div></details>`}).join(''); const existing=box.querySelector('.notification-groups'); if(existing) existing.innerHTML=cards||'<div class="muted">Новых операций пока нет.</div>'; else box.insertAdjacentHTML('beforeend',`<div class="notification-groups">${cards||'<div class="muted">Новых операций пока нет.</div>'}</div>`); }
  function notifyTrade(event) { const when=event.time ? new Date(Number(event.time)).toLocaleString('ru-RU') : 'время неизвестно'; const text=`${event.address.slice(0,8)}… ${event.action} ${event.coin} · $${fmt(event.usd,2)} · ${when}`; const key=`${String(event.address||'').toLowerCase()}:${String(event.coin||'').toUpperCase()}:${event.action}`; const group=enhanced.notificationGroups[key]||(enhanced.notificationGroups[key]={address:event.address,coin:event.coin,action:event.action,totalUsd:0,events:[],latest:event}); group.totalUsd+=Number(event.usd||0);group.events.push(event);if(Number(event.time||0)>=Number(group.latest?.time||0))group.latest=event; renderNotificationGroups(); if ('Notification' in window && Notification.permission==='granted') new Notification('Hyperliquid: новая операция',{body:text}); }
  function startNotificationPolling(leaderAddress) {
    notificationState.leaderAddress=String(leaderAddress||'').toLowerCase();
    if (notificationState.leader) renderLeaderActivity();
    if (notificationState.timer) clearInterval(notificationState.timer);
    if (!notificationState.leader && !notificationState.saved) return;
    const poll=async()=>{ const addresses=[]; if (notificationState.leader && leaderAddress) addresses.push(leaderAddress); if (notificationState.saved) addresses.push(...enhanced.saved); addresses.push(...notificationState.tokenAddresses); try { const response=await fetch('/api/hyperliquid/notifications?'+new URLSearchParams({addresses:[...new Set(addresses)].join(','),since:String(Date.now()-30000)})); const data=await response.json(); for (const event of data.events||[]) { if (notificationState.seen.has(event.id)) continue; notificationState.seen.add(event.id); if (notificationState.initialized) { if (String(event.address||'').toLowerCase()===notificationState.leaderAddress) { notificationState.leaderEvents.push(event); renderLeaderActivity(); } notifyTrade(event); } } notificationState.initialized=true; } catch (_) {} };
    poll(); notificationState.timer=setInterval(poll,15000);
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
      const radarSaved = $('#hlRadarSavedAddresses'); if (radarSaved) { radarSaved.innerHTML = enhanced.saved.map((item) => `<button type="button" class="address wallet-address radar-saved-address" data-address="${esc(item)}">${esc(item)}</button>`).join(' '); radarSaved.querySelectorAll('.radar-saved-address').forEach((item) => item.onclick = () => loadRadarAddressDetails('radar-saved-detail', item.dataset.address)); }
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
    const info = enhanced.marketInfo; const refreshed = info?.refreshed_at ? ` · свежий запрос: ${new Date(info.refreshed_at).toLocaleTimeString('ru-RU')}` : ''; const coverage = info && info.markets_total > 1 ? ` · рынков обновлено: ${info.markets_refreshed}/${info.markets_total}, в кэше: ${info.markets_cached}${refreshed}` : refreshed;
    box.innerHTML = enhanced.trades.length ? `<div class="toolbar"><span class="muted">Показано ${view.start + 1}–${view.start + view.rows.length} из ${enhanced.trades.length}${coverage}</span></div><table><thead><tr><th>Время</th><th>Рыночная сторона</th><th>Монета</th><th>Цена</th><th>Размер</th><th>USD</th><th>Подраздел</th></tr></thead><tbody>${view.rows.map((x, i) => { const id = `enhanced-trade-${view.start + i}`; const payload = encodeURIComponent(JSON.stringify(x)); return `<tr><td>${hlTime(x.time)}</td><td><button class="badge ${x.side === 'BUY' ? 'short' : 'long'}" onclick="loadTradeParticipants('${id}',JSON.parse(decodeURIComponent('${payload}')))" >${x.side === 'BUY' ? 'РЫН. ПОКУПКА' : 'РЫН. ПРОДАЖА'}</button></td><td>${esc(x.coin)}</td><td>${fmt(x.price, 6)}</td><td>${fmt(x.size, 6)}</td><td>$${fmt(x.usd, 0)}</td><td>${dayStatus(x)}</td></tr><tr class="trade-detail" hidden><td colspan="7"><div id="${id}"></div></td></tr>`; }).join('')}</tbody></table>${pager('trades', view.total)}` : '<div class="empty">Рыночных сделок по выбранному фильтру пока нет.</div>';
    bindPagers(box);
  }
  function renderPeople() {
    const box = $('#hlOverviewAddresses'); if (!box) return; sortByDayStatus(enhanced.people, 'totalUsd', 'buyUsd', 'sellUsd'); const view = slicePage(enhanced.people, 'people');
    box.innerHTML = enhanced.people.length ? `<div class="toolbar"><span class="muted">Показано ${view.start + 1}–${view.start + view.rows.length} из ${enhanced.people.length}</span><button id="exportPeopleCsv" class="pair">Excel CSV</button></div><table><thead><tr><th>Адрес участника</th><th>Участий</th><th>Покупки</th><th>Покупки USD</th><th>Продажи</th><th>Продажи USD</th><th>Всего USD</th><th>Стиль торговли</th><th>Аккаунт</th><th>Частота покупок</th><th>Подраздел</th></tr></thead><tbody>${view.rows.map((p, i) => { const id = `enhanced-account-${view.start + i}`; const address = String(p.address || '').toLowerCase(); const saved = savedAddress(address); const f = state.hlFrequency[p.address]; const frequency = f ? `${esc(f.label)}<br><span class="muted">${f.buy_count} покупок · ${f.active_days} дн.</span>` : '<span class="muted">анализ...</span>'; const style = f ? `${esc(f.trade_style || 'нет данных')}<br><span class="muted">удержание: ${f.median_holding_hours == null ? '—' : fmt(f.median_holding_hours, 1) + ' ч'} · ${fmt(f.fills_per_active_day || 0, 1)} fills/день</span>` : '<span class="muted">анализ...</span>'; return `<tr><td><div class="address-actions"><button class="address wallet-address" onclick="loadOverviewAccount('${id}','${address}')">${address}</button><button type="button" class="pair save-detected-address${saved ? ' saved' : ''}" data-address="${address}" title="${saved ? 'Адрес сохранён' : 'Сохранить адрес'}" aria-label="${saved ? 'Адрес сохранён' : 'Сохранить адрес'}"${saved ? ' disabled' : ''}>${saved ? '✓' : '⇩'}</button></div></td><td>${p.trades}</td><td>${p.buyTrades}</td><td>$${fmt(p.buyUsd, 0)}</td><td>${p.sellTrades}</td><td>$${fmt(p.sellUsd, 0)}</td><td><strong>$${fmt(p.totalUsd, 0)}</strong></td><td class="compact-cell">${style}</td><td><a class="address" href="https://app.hyperliquid.xyz/explorer/address/${address}" target="_blank" rel="noopener">Открыть</a></td><td class="compact-cell">${frequency}</td><td>${dayStatus(p)}</td></tr><tr class="trade-detail" hidden><td colspan="11"><div id="${id}"></div></td></tr>`; }).join('')}</tbody></table>${pager('people', view.total)}` : '<div class="empty">Нет адресов в выбранном фильтре.</div>';
    bindAddressSaveButtons(box);
    let lossBox=$('#hlRadarLosses'); if(!lossBox){ lossBox=document.createElement('details'); lossBox.id='hlRadarLosses'; lossBox.className='panel radar-losses'; box.insertAdjacentElement('afterend',lossBox); }
    const losses=[]; rows.forEach((row)=> (row.positions||[]).forEach((position)=>{ if(Number(position.unrealized_pnl||0)<0) losses.push({row,position}); }));
    lossBox.innerHTML=`<summary>Убыточные открытые позиции · ${losses.length}</summary><div class="pnl-items">${losses.map(({row,position})=>`<div class="radar-position"><span><strong>${esc(position.coin)} ${esc(position.side)}</strong> · ${esc(String(row.address||'').toLowerCase())} · ${position.opened_at?hlTime(position.opened_at):'время неизвестно'}</span><span class="red">$${fmt(position.position_value,2)} · PnL ${radarMoney(position.unrealized_pnl)}</span></div>`).join('')||'<div class="muted">Убыточных позиций нет.</div>'}</div>`;
    box.querySelector('.radar-more')?.addEventListener('click',()=>{ data.__showAll=!data.__showAll; renderRadar(data); });
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
  const copyState = { leader: null, bybit: null, follow: null, trackedAddress: '', monitoring: true, timer: null, loading: false, openedFrom: '', openedTo: '', minVolume: 20000, windowPreset: '20m', useLocalHistory: false };
  const copyMoscowInput = (date) => { const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(date).reduce((out, part) => (out[part.type] = part.value, out), {}); return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`; };
  const notificationState = { leader: false, saved: false, tokenAddresses: [], leaderAddress: '', seen: new Set(), timer: null, initialized: false, leaderEvents: [] };
  const copyFmt = (value, digits = 2) => Number(value || 0).toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const mskTime = (value) => value ? new Date(Number(value)).toLocaleTimeString('ru-RU',{timeZone:'Europe/Moscow'}) + ' MSK' : '—';
  const copySymbol = (coin) => `${String(coin || '').toUpperCase()}USDT`;
  const copyTime = (value) => value ? new Date(Number(value)).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'}) + ' MSK' : 'время открытия неизвестно';
  function renderCopyPanel(error = '') {
    const root = $('#hlCopyTradePanel'); if (!root) return;
    const activeBeforeRender = document.activeElement?.id;
    if (root.dataset.ready === 'true' && ['copyOpenedFrom', 'copyOpenedTo', 'copyMinVolume'].includes(activeBeforeRender)) return;
    const activeValueBeforeRender = ['copyOpenedFrom', 'copyOpenedTo', 'copyMinVolume'].includes(activeBeforeRender) ? document.activeElement.value : null;
    const activeSelectionStart = ['copyOpenedFrom', 'copyOpenedTo', 'copyMinVolume'].includes(activeBeforeRender) ? document.activeElement.selectionStart : null;
    const activeSelectionEnd = ['copyOpenedFrom', 'copyOpenedTo', 'copyMinVolume'].includes(activeBeforeRender) ? document.activeElement.selectionEnd : null;
    const leader = copyState.leader; const account = copyState.bybit;
    const leaderPosition = leader?.target_position || leader?.positions?.[0]; const ownPosition = account?.positions?.[0]; const waitingOrder = account?.open_orders?.find((order) => !order.reduce_only);
    const leaderOwnMatch = ownPosition ? (leader?.positions || []).find((position) => copySymbol(position.coin) === String(ownPosition.symbol || '').toUpperCase() && position.side === (ownPosition.side === 'Buy' ? 'Buy' : 'Sell')) : null;
    const leaderOwnStatus = ownPosition ? (leaderOwnMatch ? `<div class="copy-follow-status"><span class="green">Лидер всё ещё держит ${esc(ownPosition.symbol)} ${esc(ownPosition.side === 'Buy' ? 'LONG' : 'SHORT')}</span><span>Open PnL лидера: ${leaderOwnMatch.unrealized_pnl >= 0 ? '+' : ''}$${copyFmt(leaderOwnMatch.unrealized_pnl)}</span></div>` : `<div class="copy-follow-status"><span class="yellow">Лидер продал ${esc(ownPosition.symbol)} ${esc(ownPosition.side === 'Buy' ? 'LONG' : 'SHORT')}</span><strong>У лидера такой позиции больше нет. Проверьте и закройте свою позицию вручную.</strong><button id="copyCloseLeaderStatus" class="btn">Закрыть мою позицию</button></div>`) : '';
    const openedFromTime = copyState.openedFrom ? new Date(copyState.openedFrom).getTime() : 0;
    const openedToTime = copyState.openedTo ? new Date(copyState.openedTo).getTime() : 0;
    const recentFills = Array.isArray(leader?.recent_fills) ? leader.recent_fills : [];
    const fillTotals = recentFills.reduce((totals, fill) => { const coin = String(fill.coin || '').toUpperCase(); totals[coin] = (totals[coin] || 0) + Math.abs(Number(fill.usd || 0)); return totals; }, {});
    const leaderOpenPositions = (leader?.positions || []).filter((position) => Math.max(Math.abs(Number(position.position_value || 0)), Number(fillTotals[String(position.coin || '').toUpperCase()] || 0)) >= Number(copyState.minVolume || 0) && ((!openedFromTime && !openedToTime) || (Number(position.opened_at || 0) && (!openedFromTime || Number(position.opened_at) >= openedFromTime) && (!openedToTime || Number(position.opened_at) <= openedToTime)))).sort((left, right) => Number(right.opened_at || 0) - Number(left.opened_at || 0));
    const fillBreakdown = (position) => {
      const coin = String(position.coin || '').toUpperCase();
      const side = position.side === 'Buy' ? 'LONG' : 'SHORT';
      const fills = recentFills.filter((fill) => String(fill.coin || '').toUpperCase() === coin && ((side === 'LONG' && String(fill.direction || '').toLowerCase().includes('long')) || (side === 'SHORT' && String(fill.direction || '').toLowerCase().includes('short')) || !fill.direction));
      if (fills.length < 2) return '';
      const total = fills.reduce((sum, fill) => sum + Math.abs(Number(fill.usd || 0)), 0);
      const parts = fills.slice().sort((a, b) => Number(a.time || 0) - Number(b.time || 0)).map((fill) => `$${copyFmt(fill.usd || 0)} ${copyTime(fill.time)}`).join(' · ');
      return ` · дробление: ${fills.length} входа, всего $${copyFmt(total)} (${parts})`;
    };
    const leaderNearProfitPositions = leaderOpenPositions.map((position) => ({ ...position, pnl_percent: Math.abs(Number(position.position_value || 0)) ? Number(position.unrealized_pnl || 0) / Math.abs(Number(position.position_value || 0)) * 100 : 0 })).filter((position) => position.pnl_percent >= 0 && position.pnl_percent <= 1).slice(0, 2);
    const largestLeaderPosition = leaderOpenPositions.slice().sort((left, right) => Math.abs(Number(right.position_value || 0)) - Math.abs(Number(left.position_value || 0)))[0];
    const largestLeaderMarkup = largestLeaderPosition ? `<div class="copy-largest-position"><span class="muted">Самая крупная покупка</span><strong>${esc(largestLeaderPosition.coin)} · ${largestLeaderPosition.side === 'Buy' ? 'LONG' : 'SHORT'} · $${copyFmt(Math.abs(Number(largestLeaderPosition.position_value || 0)))}</strong><span>Время открытия: ${esc(copyTime(largestLeaderPosition.opened_at))}</span></div>` : '';
    const allLeaderPositions = leaderOpenPositions.map((position) => { const value = Math.abs(Number(position.position_value || 0)); const pnl = Number(position.unrealized_pnl || 0); const pct = value ? pnl / value * 100 : 0; return `${esc(position.coin)} ${position.side === 'Buy' ? 'LONG' : 'SHORT'} · объём $${copyFmt(value)} · PnL ${pnl >= 0 ? '+' : ''}$${copyFmt(pnl)} (${copyFmt(pct, 3)}%) · последняя операция ${esc(copyTime(position.opened_at))}${esc(fillBreakdown(position))}`; }).join(', ');
    const marketReady = Number(account?.last_price || 0) > 0;
    const leaderPortfolioId = `copy-leader-portfolio-${String(leader?.address || '').toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    const trackedPositions = copyState.trackedAddress && leader && String(leader.address).toLowerCase() === copyState.trackedAddress ? (leader.positions || []) : [];
    const trackedFills = copyState.trackedAddress && leader && String(leader.address).toLowerCase() === copyState.trackedAddress ? (leader.recent_fills || []) : [];
    const trackedBlock = copyState.trackedAddress ? `<div class="copy-follow-status"><strong>Текущие позиции отслеживаемого адреса</strong>${trackedPositions.length ? trackedPositions.map((position) => `<span>${esc(position.coin)} ${position.side === 'Buy' ? 'LONG' : 'SHORT'} · $${copyFmt(position.position_value)} · открыта ${esc(copyTime(position.opened_at))}</span>`).join('') : '<span>Открытых позиций нет</span>'}${trackedFills.filter((fill) => String(fill.action || '').startsWith('Close')).slice(0, 10).map((fill) => `<span class="red">Продал ${esc(fill.coin)} · $${copyFmt(fill.usd)} · ${esc(copyTime(fill.time))}</span>`).join('')}</div>` : '';
    const trackedAddresses = Array.from(new Set([...(enhanced.saved || []), ...(copyState.trackedAddress ? [copyState.trackedAddress] : [])].map((address) => String(address).toLowerCase()).filter(Boolean)));
    // Warm a small live cache in the background without expanding any card.
    // Clicking an address can then render immediately while the rest stays collapsed.
    prefetchLeaderPortfolios(trackedAddresses);
    const trackedAddressesBlock = trackedAddresses.length ? `<div class="copy-saved-addresses"><div class="muted">Сохранённые и отслеживаемые адреса · открытые позиции загружаются live</div><div id="copySavedBestLeaders" class="copy-saved-best-leaders"><div class="muted">Лучшие адреса по PnL будут загружены live.</div></div><div class="copy-saved-address-list">${trackedAddresses.map((address, index) => { const id = `copy-saved-portfolio-${index}`; return `<div class="copy-saved-address-row"><button type="button" class="address wallet-address copy-saved-address" data-address="${esc(address)}" data-target="${id}">${esc(address)}</button><button type="button" class="pair copy-saved-open" data-address="${esc(address)}" data-target="${id}">Скрыть/показать позиции</button><div id="${id}" class="leader-portfolio-detail" hidden></div></div>`; }).join('')}</div></div>` : '';
    const leaderText = leader ? `${trackedAddressesBlock}<div class="copy-grid"><div><span class="muted">Лучший сохранённый адрес</span><button type="button" class="address wallet-address copy-leader-address" data-address="${esc(leader.address)}" data-target="${leaderPortfolioId}">${esc(leader.address)}</button><div id="${leaderPortfolioId}" class="leader-portfolio-detail" hidden></div><span class="${leader.net_closed_pnl >= 0 ? 'green' : 'red'}">Closed PnL: ${leader.net_closed_pnl >= 0 ? '+' : ''}$${copyFmt(leader.net_closed_pnl)}</span><span class="muted">локальная история · fills: ${leader.fills} · проверено адресов: ${leader.checked_saved_addresses}</span></div><div><span class="muted">Открытые позиции лидера: плюс 0–1%</span>${leaderNearProfitPositions.length ? leaderNearProfitPositions.map((position) => `<strong>${esc(position.coin)} · ${position.side === 'Buy' ? 'LONG' : 'SHORT'}</strong><span>Объём: $${copyFmt(Math.max(Math.abs(Number(position.position_value || 0)), Number(fillTotals[String(position.coin || "").toUpperCase()] || 0)))} · Open PnL: +$${copyFmt(position.unrealized_pnl)} (${copyFmt(position.pnl_percent, 3)}%) · открыта ${esc(copyTime(position.opened_at))}</span>`).join('') : '<strong>Подходящих позиций нет</strong>'}<div class="copy-all-positions" title="Все открытые позиции лидера"><span class="muted">Все открытые позиции и PnL:</span><br>${allLeaderPositions || 'Открытых позиций нет'}</div>${largestLeaderMarkup}</div><div><span class="muted">Ваш Bybit USDT</span><strong>$${copyFmt(account?.wallet_balance)}</strong><span>Доступно: $${copyFmt(account?.available_balance)}</span><span>Equity: $${copyFmt(account?.equity)}</span></div><div><span class="muted">Ваша позиция</span>${ownPosition ? `<strong>${esc(ownPosition.symbol)} · ${esc(ownPosition.side)}</strong><span>Объём: $${copyFmt(ownPosition.position_value)}</span><span class="${ownPosition.unrealized_pnl >= 0 ? 'green' : 'red'}">PnL: ${ownPosition.unrealized_pnl >= 0 ? '+' : ''}$${copyFmt(ownPosition.unrealized_pnl)}</span>` : '<strong>Нет открытой позиции</strong>'}</div></div>` : `${trackedAddressesBlock}<div class="empty">Ищу лучшего сохранённого адреса по локальной истории...</div>`;
    const follow = copyState.follow;
    const next = follow?.next_position;
    const signal = next ? `<div class="copy-follow-status"><span class="yellow">Лидер закрыл ${esc(follow.coin)} и уже открыл ${esc(next.coin)} ${esc(next.side === 'Sell' ? 'SHORT' : 'LONG')}</span><strong>Сигнал: проверьте и подтвердите новую заявку вручную.</strong></div>` : '';
    const opened = Array.isArray(follow?.new_positions_signal) ? follow.new_positions_signal : [];
    const openedSignal = opened.length ? `<div class="copy-follow-status"><span class="yellow">Лидер открыл новые позиции: ${opened.map((p) => `${esc(p.coin)} ${esc(p.side === 'Sell' ? 'SHORT' : 'LONG')} · $${fmt(p.position_value || 0, 2)}`).join('; ')}</span><strong>Проверьте сигнал и подтвердите копирование вручную.</strong></div>` : '';
    const closeSignal = follow?.leader_closed_signal ? `<div class="copy-follow-status"><span class="yellow">Лидер закрыл ${esc(follow.coin)} ${esc(follow.side === 'Sell' ? 'SHORT' : 'LONG')}.</span><strong>Закройте свою позицию вручную лимитной заявкой.</strong><button id="copyCloseAfterLeader" class="btn" ${ownPosition ? '' : 'disabled'}>Закрыть мою позицию</button></div>` : '';
    const followFresh = follow?.last_checked_at && (Date.now() - Number(follow.last_checked_at) <= 60000); const followInfo = follow?.active && followFresh ? `<div class="copy-follow-status"><span class="green">Автозакрытие активно</span><span>Связка: ${esc(follow.symbol)} ${esc(follow.side === 'Sell' ? 'SHORT' : 'LONG')}</span><span>Лидер: ${esc(follow.leader)}</span><span>Проверено: ${follow.last_checked_at ? new Date(follow.last_checked_at).toLocaleTimeString('ru-RU') : 'ожидание первой проверки'}</span><span>Проверок закрытия: ${Number(follow.missing_checks || 0)}/2</span></div>` : (follow?.action ? `<div class="copy-follow-status"><span class="yellow">Автозакрытие завершено: ${esc(follow.action)}</span></div>` : '');
    const tradeControls = leaderPosition ? `${followInfo}<div class="toolbar copy-actions"><span class="muted">Сигнал: ${esc(copySymbol(leaderPosition.coin))} · ${leaderPosition.side === 'Buy' ? 'Buy / LONG' : 'Sell / SHORT'} · лимит до $10 · 1x</span>${waitingOrder ? `<span class="yellow">Ожидает ордер ${esc(waitingOrder.symbol)} ${esc(waitingOrder.side)}: ${copyFmt(waitingOrder.qty, 4)} по ${copyFmt(waitingOrder.price, 6)}</span>` : ''}${marketReady ? '' : '<span class="red">Инструмент пока недоступен на Bybit</span>'}<button id="copyOpenOrder" class="btn" ${ownPosition || waitingOrder || !marketReady ? 'disabled' : ''}>Открыть лимитный ордер</button><button id="copyFollowOrder" class="pair" ${(!ownPosition && !waitingOrder) ? 'disabled' : ''}>Выбрать позицию и закрыть вместе с лидером</button><button id="copyCloseOrder" class="pair" ${ownPosition ? '' : 'disabled'}>Закрыть всю позицию</button></div>` : followInfo;
    root.innerHTML = `<h2>Копирование лидера: Bybit Futures</h2><div class="toolbar"><label class="pair"><input id="copyMonitorEnabled" type="checkbox" ${copyState.monitoring ? 'checked' : ''}> отслеживать каждые 15 секунд</label><button id="copyRefresh" class="pair">Обновить</button><label class="pair">Период <select id="copyWindowPreset" class="pair"><option value="20m" ${copyState.windowPreset === '20m' ? 'selected' : ''}>Последние 20 минут</option><option value="1h" ${copyState.windowPreset === '1h' ? 'selected' : ''}>Последний час</option><option value="manual" ${copyState.windowPreset === 'manual' ? 'selected' : ''}>Вручную</option></select></label><label class="pair">Открыты с <input id="copyOpenedFrom" type="datetime-local" value="${esc(copyState.openedFrom)}"></label><label class="pair">по <input id="copyOpenedTo" type="datetime-local" value="${esc(copyState.openedTo)}"></label><label class="pair">Минимальный объём USD <input id="copyMinVolume" class="input" type="number" min="20000" step="100" value="${copyState.minVolume || 20000}" placeholder="например 20000"></label><button id="copyApplyOpenedFilter" class="pair">Применить фильтр</button><button id="copyClearOpenedFilter" class="pair" ${copyState.openedFrom || copyState.openedTo || copyState.minVolume !== 20000 ? '' : 'disabled'}>Сбросить фильтр</button><span class="muted">Показано открытых: ${leaderOpenPositions.length}</span><span class="muted">Авто-вход отключён: реальный ордер требует отдельного подтверждения.</span></div>${error ? `<div class="red">${esc(error)}</div>` : ''}${leaderOwnStatus}${signal}${openedSignal}${closeSignal}${leaderText}${tradeControls}`;
    if (copyState.trackedAddress) { const tracking = document.createElement('div'); tracking.className = 'copy-follow-status'; tracking.innerHTML = `<span class="green">Отслеживается адрес: ${esc(copyState.trackedAddress)}</span><button id="copyFinishTracking" class="pair">Закончить слежку и сохранить адрес</button>`; root.prepend(tracking); if (trackedBlock) root.insertAdjacentHTML('beforeend', trackedBlock); }
    root.dataset.ready = 'true';
    const savedList = root.querySelector('.copy-saved-address-list');
    if (savedList && !savedList.dataset.compactReady) {
      savedList.dataset.compactReady = 'true';
      const savedRows = [...savedList.querySelectorAll('.copy-saved-address-row')];
      if (savedRows.length > 2) {
        savedRows.slice(2).forEach((row) => { row.hidden = true; });
        const more = document.createElement('button');
        more.type = 'button'; more.className = 'pair copy-saved-more';
        more.textContent = `Ещё адреса (${savedRows.length - 2})`;
        more.onclick = () => {
          const expanded = more.dataset.expanded === 'true';
          savedRows.slice(2).forEach((row) => { row.hidden = expanded; });
          more.dataset.expanded = expanded ? 'false' : 'true';
          more.textContent = expanded ? `Ещё адреса (${savedRows.length - 2})` : 'Скрыть остальные';
        };
        savedList.insertAdjacentElement('afterend', more);
      }
    }
    const copyToolbar=root.querySelector('.toolbar'); if(copyToolbar){ const historyToggle=document.createElement('label'); historyToggle.className='pair'; historyToggle.innerHTML=`<input id="copyUseLocalHistory" type="checkbox" ${copyState.useLocalHistory?'checked':''}> анализировать из сохранённых`; copyToolbar.appendChild(historyToggle); const resetLive=document.createElement('button'); resetLive.type='button'; resetLive.className='pair'; resetLive.textContent='Сбросить фильтр'; resetLive.onclick=()=>{ copyState.openedFrom=''; copyState.openedTo=''; copyState.minVolume=20000; copyState.windowPreset='20m'; copyState.useLocalHistory=false; refreshCopyPanel(); }; copyToolbar.appendChild(resetLive); $('#copyUseLocalHistory').onchange=(event)=>{ copyState.useLocalHistory=event.target.checked; refreshCopyPanel(); }; }
    root.querySelectorAll('.copy-leader-address').forEach((button) => { button.onclick = () => loadLeaderPortfolio(button.dataset.address, button.dataset.target); });
    root.querySelectorAll('.copy-saved-address,.copy-saved-open').forEach((button) => { button.onclick = () => loadLeaderPortfolio(button.dataset.address, button.dataset.target); });
    const bestBox = root.querySelector('#copySavedBestLeaders');
    if (bestBox && !bestBox.dataset.loading) {
      bestBox.dataset.loading = 'true';
      fetch('/api/hyperliquid/saved-leader-summary?_ts=' + Date.now(), { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } }).then((response) => response.json().then((data) => ({ response, data }))).then(({ response, data }) => {
        if (!response.ok) throw Error(data.error || `HTTP ${response.status}`);
        const card = (title, row, pnlKey) => row ? `<div class="copy-saved-best-card"><span class="muted">${title}</span><button type="button" class="address wallet-address copy-saved-address" data-address="${esc(row.address)}" data-target="copy-best-${pnlKey}">${esc(row.address)}</button><strong class="${Number(row[pnlKey] || 0) >= 0 ? 'green' : 'red'}">${Number(row[pnlKey] || 0) >= 0 ? '+' : ''}$${copyFmt(row[pnlKey] || 0)}</strong></div>` : `<div class="copy-saved-best-card"><span class="muted">${title}</span><span>Нет данных</span></div>`;
        bestBox.innerHTML = card('Лучший открытый PnL', data.best_open, 'open_pnl') + card('Лучший закрытый PnL', data.best_closed, 'closed_pnl');
        bestBox.querySelectorAll('.copy-saved-address').forEach((button) => { button.onclick = () => { const detailId = button.dataset.target; let detail = document.getElementById(detailId); if (!detail) { detail = document.createElement('div'); detail.id = detailId; detail.className = 'leader-portfolio-detail'; button.closest('.copy-saved-best-card').appendChild(detail); } loadLeaderPortfolio(button.dataset.address, detailId); }; });
      }).catch(() => { bestBox.innerHTML = '<div class="muted">Live-данные лучших адресов временно недоступны.</div>'; });
    }
    expandedLeaderPortfolios.forEach((address) => {
      const button = root.querySelector(`.copy-saved-address[data-address="${address}"]`) || root.querySelector(`.copy-leader-address[data-address="${address}"]`);
      if (button) {
        const detail = document.getElementById(button.dataset.target);
        if (detail && detail.hidden) loadLeaderPortfolio(address, button.dataset.target);
      }
    });
    const finishTracking = root.querySelector('#copyFinishTracking'); if (finishTracking) finishTracking.onclick = async () => { const address = copyState.trackedAddress; copyState.trackedAddress = ''; if (address) { enhanced.saved = Array.from(new Set(enhanced.saved.concat(address))); await saveAddresses(); } refreshCopyPanel(); };
    $('#copyMonitorEnabled').onchange = (event) => setCopyMonitoring(event.target.checked);
    $('#copyRefresh').onclick = () => refreshCopyPanel();
    $('#copyWindowPreset').onchange = (event) => { const value = event.target.value; copyState.windowPreset = value; if (value === 'manual') return; const now = new Date(); const minutes = value === '1h' ? 60 : 20; copyState.openedTo = copyMoscowInput(now); copyState.openedFrom = copyMoscowInput(new Date(now.getTime() - minutes * 60000)); renderCopyPanel(); };
    $('#copyOpenedFrom').oninput = (event) => { copyState.openedFrom = event.target.value; };
    $('#copyOpenedTo').oninput = (event) => { copyState.openedTo = event.target.value; };
    $('#copyMinVolume').oninput = (event) => { copyState.minVolume = Math.max(0, Number(event.target.value || 0)); };
    $('#copyApplyOpenedFilter').onclick = () => renderCopyPanel();
    $('#copyClearOpenedFilter').onclick = () => { copyState.openedFrom = ''; copyState.openedTo = ''; copyState.minVolume = 20000; copyState.useLocalHistory=false; refreshCopyPanel(); };
    $('#copyOpenOrder')?.addEventListener('click', openCopyOrder);
    $('#copyFollowOrder')?.addEventListener('click', armCopyFollow);
    $('#copyCloseOrder')?.addEventListener('click', closeCopyOrder);
    $('#copyCloseAfterLeader')?.addEventListener('click', closeCopyOrder);
    $('#copyCloseLeaderStatus')?.addEventListener('click', closeCopyOrder);
    if (activeBeforeRender && activeValueBeforeRender !== null) {
      const restored = document.getElementById(activeBeforeRender);
      if (restored) {
        restored.value = activeValueBeforeRender;
        restored.focus({ preventScroll: true });
        try { restored.setSelectionRange(activeSelectionStart, activeSelectionEnd); } catch (_) {}
      }
    }
  }
  async function refreshCopyPanel() {
    if (copyState.loading) return;
    copyState.loading = true; renderCopyPanel();
    try {
      const liveOptions={cache:'no-store',headers:{'Cache-Control':'no-cache'}}; const trackedCoin=copyState.bybit?.positions?.[0]?.symbol ? String(copyState.bybit.positions[0].symbol).toUpperCase().replace('USDT','') : ''; const leaderResponse = await fetch('/api/hyperliquid/copy-leader?'+new URLSearchParams({_ts:String(Date.now()),local:copyState.useLocalHistory?'1':'0',coin:trackedCoin}),liveOptions); const leaderData = await leaderResponse.json(); if (!leaderResponse.ok) throw Error(leaderData.error || `HTTP ${leaderResponse.status}`);
      copyState.leader = leaderData.leader; copyState.leader.updated_at=leaderData.updated_at || Date.now();
      const target = copyState.leader.target_position || copyState.leader.positions?.[0];
      const symbol = target ? copySymbol(target.coin) : '';
      const accountResponse = await fetch('/api/bybit/copy-status?' + new URLSearchParams({ symbol, _ts: String(Date.now()) }),liveOptions); const accountData = await accountResponse.json(); if (!accountResponse.ok) throw Error(accountData.error || `HTTP ${accountResponse.status}`);
      copyState.bybit = accountData; renderCopyPanel();
      const followResponse = await fetch('/api/bybit/copy-follow-status?_ts='+Date.now(),liveOptions); copyState.follow = await followResponse.json(); renderCopyPanel();
    } catch (error) { renderCopyPanel(error.message); }
    finally { copyState.loading = false; }
  }
  function setCopyMonitoring(enabled) {
    copyState.monitoring = enabled; if (copyState.timer) { clearInterval(copyState.timer); copyState.timer = null; }
    if (enabled) copyState.timer = setInterval(refreshCopyPanel, 15000);
    renderCopyPanel();
  }
  async function openCopyOrder() {
    const position = copyState.leader?.target_position || copyState.leader?.positions?.[0]; if (!position) return;
    const symbol = copySymbol(position.coin); const side = position.side;
    if (!window.confirm(`Разместить реальный лимитный ${side} ордер ${symbol} на Bybit? Лимит суммы: $10, плечо: 1x.`)) return;
    try {
      const response = await fetch('/api/bybit/copy-order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol, side, confirm: true }) }); const data = await response.json(); if (!response.ok) throw Error(data.error || `HTTP ${response.status}`);
      alert(`Лимитный ордер ${data.side} ${data.symbol} создан: $${copyFmt(data.notional_usd)} по ${data.price}.`); await refreshCopyPanel();
    } catch (error) { alert(`Ордер не создан: ${error.message}`); }
  }
  async function closeCopyOrder() {
    const positions = (copyState.bybit?.positions || []).filter((item) => Number(item.position_value || 0) !== 0); if (!positions.length) return;
    let position = positions[0];
    if (positions.length > 1) {
      const choices = positions.map((item, index) => `${index + 1}. ${item.symbol} ${item.side} · $${copyFmt(item.position_value)}`).join('\n');
      const selected = window.prompt(`Выберите позицию для закрытия вместе с лидером:\n${choices}\nВведите номер:`, '1');
      const index = Number(selected) - 1;
      if (!Number.isInteger(index) || !positions[index]) return;
      position = positions[index];
    }
    if (!window.confirm(`Закрыть всю реальную позицию ${position.symbol} лимитной заявкой по текущей цене?`)) return;
    try {
      const response = await fetch('/api/bybit/copy-close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol: position.symbol, confirm: true }) }); const data = await response.json(); if (!response.ok) throw Error(data.error || `HTTP ${response.status}`);
      alert(`Лимитная заявка на закрытие ${data.symbol} отправлена.`); await refreshCopyPanel();
    } catch (error) { alert(`Закрытие не создано: ${error.message}`); }
  }
  async function armCopyFollow() {
    if (!copyState.leader) return;
    const ownPositions = (copyState.bybit?.positions || []).filter((item) => Number(item.position_value || 0) !== 0);
    let order = ownPositions[0] || copyState.bybit?.open_orders?.find((item) => !item.reduce_only);
    if (ownPositions.length > 1) { const choices=ownPositions.map((item,index)=>`${index+1}. ${item.symbol} ${item.side} · $${copyFmt(item.position_value)}`).join('\n'); const selected=window.prompt(`Выберите позицию, которую связывать с лидером:\n${choices}\nВведите номер:`, '1'); const index=Number(selected)-1; if(!Number.isInteger(index)||!ownPositions[index]) return; order=ownPositions[index]; }
    const position = copyState.leader.positions?.find((item) => copySymbol(item.coin) === order?.symbol && item.side === order?.side);
    if (!order || !position) { alert('Не удалось сопоставить заявку Bybit с текущей позицией лидера.'); return; }
    if (!window.confirm(`Включить автоматическое закрытие ${order.symbol} после закрытия этой позиции лидером?`)) return;
    try {
      const payload=JSON.stringify({ leader: copyState.leader.address, coin: position.coin, symbol: order.symbol, side: position.side, confirm: true }); let response; let lastError; for(let attempt=0;attempt<2;attempt++){ try { response=await fetch('/api/bybit/copy-follow', { method: 'POST', cache:'no-store', headers: { 'Content-Type': 'application/json', 'Cache-Control':'no-cache' }, body: payload }); break; } catch(error) { lastError=error; if(attempt===0) await new Promise((resolve)=>setTimeout(resolve,1000)); } } if(!response) throw lastError || Error('Локальный сервер недоступен'); const data = await response.json(); if (!response.ok) throw Error(data.error || `HTTP ${response.status}`);
      copyState.follow = data; renderCopyPanel();
    } catch (error) { alert(`Автозакрытие не включено: ${error.message}`); }
  }
  function injectCopyPanel() {
    const view = $('#hlOverview'); if (!view) return;
    const existing = $('#hlCopyTradePanel');
    const place = (panel) => { const icebergPanel = $('#hlIcebergs')?.closest('.panel'); const metrics = view.querySelector('.metrics'); if (icebergPanel) icebergPanel.insertAdjacentElement('afterend', panel); else if (metrics) metrics.insertAdjacentElement('afterend', panel); else view.insertBefore(panel, view.firstElementChild); };
    if (existing) { place(existing); setCopyMonitoring(true); refreshCopyPanel(); return; }
    const panel = document.createElement('section'); panel.id = 'hlCopyTradePanel'; panel.className = 'panel copy-panel'; place(panel); setCopyMonitoring(true); refreshCopyPanel();
  }
  function injectAutoTradingPanel() {
    const view = $('#hlOverview');
    if (!view || $('#hlAutoTradingPanel')) return;
    const panel = document.createElement('section');
    panel.id = 'hlAutoTradingPanel'; panel.className = 'panel auto-trading-panel';
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('liquidationRadar.autoTrading') || '{}') || {}; } catch (_) {}
    panel.innerHTML = `<h2>Автоторговля</h2><p class="note">Отдельные настройки автоматического копирования. Лимитная заявка выставляется только после явного подтверждения. Переключатель выключен по умолчанию.</p><div class="toolbar auto-trading-toolbar"><label class="pair"><input id="autoTradingEnabled" type="checkbox" ${saved.enabled ? 'checked' : ''}> включить автоторговлю</label><label class="pair">Сумма USD <input id="autoTradingAmount" class="input" type="number" min="1" max="10" step="0.01" value="${esc(saved.amount || 10)}"></label><label class="pair">Плечо <select id="autoTradingLeverage" class="pair"><option value="1" ${String(saved.leverage || 1)==='1'?'selected':''}>1x</option><option value="2" ${String(saved.leverage || 1)==='2'?'selected':''}>2x</option><option value="3" ${String(saved.leverage || 1)==='3'?'selected':''}>3x</option></select></label><label class="pair">Направление <select id="autoTradingSide" class="pair"><option value="leader" ${saved.side === 'leader' || !saved.side ? 'selected' : ''}>как у лидера</option><option value="long" ${saved.side === 'long' ? 'selected' : ''}>только Long</option><option value="short" ${saved.side === 'short' ? 'selected' : ''}>только Short</option></select></label><label class="pair">Закрытие <select id="autoTradingClose" class="pair"><option value="all" ${saved.closeMode === 'all' || !saved.closeMode ? 'selected' : ''}>всю позицию</option><option value="part" ${saved.closeMode === 'part' ? 'selected' : ''}>долю как лидер</option></select></label><button id="autoTradingSave" type="button" class="btn">Сохранить настройки</button></div><div id="autoTradingStatus" class="copy-follow-status"><span class="yellow">Автоторговля выключена</span><span>Сначала выберите лидера и монету в блоке копирования.</span></div>`;
    const persist = () => { const settings = { enabled: Boolean($('#autoTradingEnabled')?.checked), amount: Math.min(10, Math.max(1, Number($('#autoTradingAmount')?.value || 10))), leverage: Number($('#autoTradingLeverage')?.value || 1), side: $('#autoTradingSide')?.value || 'leader', closeMode: $('#autoTradingClose')?.value || 'all' }; try { localStorage.setItem('liquidationRadar.autoTrading', JSON.stringify(settings)); } catch (_) {} return settings; };
    panel.querySelector('#autoTradingSave').onclick = () => { const settings = persist(); if (settings.enabled && !window.confirm('Включить режим автоторговли? Реальные заявки будут возможны только после отдельного подтверждения каждой заявки.')) { panel.querySelector('#autoTradingEnabled').checked = false; persist(); } const status=panel.querySelector('#autoTradingStatus'); if (status) status.innerHTML = settings.enabled ? '<span class="yellow">Автоторговля включена в настройках</span><span>Заявки требуют отдельного подтверждения.</span>' : '<span class="yellow">Автоторговля выключена</span><span>Настройки сохранены.</span>'; };
    panel.querySelector('#autoTradingEnabled').onchange = () => { if (panel.querySelector('#autoTradingEnabled').checked && !window.confirm('Включить автоторговлю в настройках?')) panel.querySelector('#autoTradingEnabled').checked = false; persist(); };
    // Keep the controls next to copy-trading instead of letting them drift
    // below the long live tables. The section remains visible after refreshes.
    const copyPanel = $('#hlCopyTradePanel');
    if (copyPanel) copyPanel.insertAdjacentElement('afterend', panel);
    else view.insertBefore(panel, view.firstElementChild || null);
  }
  function injectOpenPnlLeadersPanel() {
    const view = $('#hlOverview');
    if (!view || $('#hlOpenPnlLeaders')) return;
    const panel = document.createElement('section');
    panel.id = 'hlOpenPnlLeaders'; panel.className = 'panel open-pnl-leaders-panel';
    panel.innerHTML = '<h2>Лучшие открытые PnL в реальном времени</h2><p class="note">Только сохранённые и отслеживаемые адреса. Данные запрашиваются из Hyperliquid без локального кэша. Позиция должна быть открыта в выбранном окне.</p><div class="toolbar"><label class="pair">Сумма USD <input id="openPnlAmount" class="input" type="number" min="1" max="10" step="0.01" value="10"></label><label class="pair">Плечо <select id="openPnlLeverage" class="pair"><option value="1">1x</option><option value="2">2x</option><option value="3">3x</option></select></label><button id="refreshOpenPnlLeaders" class="pair">Обновить live</button><span id="openPnlLeadersStatus" class="muted">Нажмите для запроса</span></div><div id="openPnlLeadersGrid" class="open-pnl-leaders-grid"><div class="empty">Нет загруженных live-данных.</div></div>';
    view.appendChild(panel);
    const render = (data) => {
      const grid = $('#openPnlLeadersGrid'); if (!grid) return;
      const card = (key, label, row) => row ? `<article class="open-pnl-leader-card"><h3>${label}</h3><button type="button" class="address wallet-address open-pnl-address" data-address="${esc(row.address)}">${esc(row.address)}</button><div><strong>${esc(row.coin)} · ${row.side}</strong></div><div>Объём: $${fmt(row.position_value,2)} · открыта ${esc(hlTime(row.opened_at))}</div><div class="${Number(row.unrealized_pnl)>=0?'green':'red'}">Open PnL: ${Number(row.unrealized_pnl)>=0?'+':''}$${fmt(row.unrealized_pnl,2)}</div><div class="open-pnl-actions"><button type="button" class="pair open-pnl-track" data-address="${esc(row.address)}">Отслеживать</button><button type="button" class="btn open-pnl-prepare" data-address="${esc(row.address)}" data-coin="${esc(row.coin)}" data-side="${esc(row.side)}">Подготовить покупку</button></div><div class="muted">Покупка/ордер не отправляется автоматически. Требуется подтверждение в блоке копирования.</div></article>` : `<article class="open-pnl-leader-card"><h3>${label}</h3><div class="empty">Подходящих открытых позиций нет.</div></article>`;
      grid.innerHTML = card('1h','Последний час',data.windows?.['1h']) + card('2h','Последние 2 часа',data.windows?.['2h']);
      grid.querySelectorAll('.open-pnl-address').forEach((button)=>{ button.onclick=()=>{ const id='open-pnl-portfolio-'+button.dataset.address.slice(2); let detail=document.getElementById(id); if(!detail){ detail=document.createElement('div'); detail.id=id; detail.className='leader-portfolio-detail'; button.closest('article').appendChild(detail); } loadLeaderPortfolio(button.dataset.address,id); }; });
      grid.querySelectorAll('.open-pnl-track').forEach((button)=>{ button.onclick=()=>trackRadarLeader(button.dataset.address); });
      grid.querySelectorAll('.open-pnl-prepare').forEach((button)=>{ button.onclick=async()=>{ const amount=Math.min(10,Math.max(1,Number($('#openPnlAmount')?.value||10))); const leverage=Number($('#openPnlLeverage')?.value||1); window.alert(`Сигнал ${button.dataset.coin} ${button.dataset.side}. Сумма $${amount.toFixed(2)}, плечо ${leverage}x. Откройте блок копирования и подтвердите лимитную заявку вручную.`); await trackRadarLeader(button.dataset.address); }; });
    };
    $('#refreshOpenPnlLeaders').onclick = async () => { const status=$('#openPnlLeadersStatus'); const button=$('#refreshOpenPnlLeaders'); button.disabled=true; status.textContent='Запрашиваю live-данные...'; try { const addresses=Array.from(new Set([...(enhanced.saved||[]), ...(copyState.trackedAddress?[copyState.trackedAddress]:[])])).join(','); const query=new URLSearchParams({_ts:String(Date.now()),addresses}); const response=await fetch('/api/hyperliquid/open-pnl-leaders?'+query,{cache:'no-store',headers:{'Cache-Control':'no-cache'}}); const data=await response.json(); if(!response.ok) throw Error(data.error||`HTTP ${response.status}`); render(data); status.textContent=`LIVE · проверено адресов: ${data.checked} · ${hlTime(data.updated_at)}`; } catch(error) { status.textContent='Live-данные недоступны: '+error.message; $('#openPnlLeadersGrid').innerHTML='<div class="empty red">Нет ответа от Hyperliquid. Локальный кэш не используется.</div>'; } finally { button.disabled=false; } };
  }
  async function enhancedLoadHlOverview() {
    if (enhanced.loading) return;
    enhanced.loading = true;
    const coin = selectedCoin(); enhanced.limit = selectedLimit(); enhanced.page = { trades: 1, people: 1, icebergs: 1 };
    const tradesBox = $('#hlOverviewTrades'), peopleBox = $('#hlOverviewAddresses'); tradesBox.innerHTML = '<div class="empty">Загрузка реальных рыночных сделок...</div>'; peopleBox.innerHTML = '<div class="empty">Анализ участников...</div>';
    try {
      const q = new URLSearchParams({ coin, limit: String(enhanced.limit), fresh: '1', _ts: String(Date.now()) }); const response = await fetch('/api/hyperliquid/trades?' + q, { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } }); const data = await response.json(); if (!response.ok) throw Error(data.error || `HTTP ${response.status}`);
      if (!data.fresh_requested || data.cached || Number(data.market_info?.markets_cached || 0) > 0) throw Error('Сервер не подтвердил свежий поток');
      const minUsd = selectedMarketMinUsd();
      const previousTrades=enhanced.trades||[];
      enhanced.marketInfo = data.market_info || null; enhanced.marketInfo.refreshed_at = data.refreshed_at || Date.now(); enhanced.marketInfo.fresh_requested = Boolean(data.fresh_requested); enhanced.trades = (data.trades || []).filter((trade) => Number(trade.usd || 0) >= minUsd); const buys = enhanced.trades.filter((x) => x.side === 'BUY'); const sells = enhanced.trades.filter((x) => x.side === 'SELL'); const sum = (rows) => rows.reduce((total, row) => total + Number(row.usd || 0), 0); const participants = {};
      enhanced.trades.forEach((trade) => (trade.participants || []).forEach((address) => { const p = participants[address] || (participants[address] = { address, trades: 0, buyTrades: 0, sellTrades: 0, buyUsd: 0, sellUsd: 0, totalUsd: 0, last_time: 0 }); p.last_time = Math.max(numberValue(p.last_time), numberValue(trade.time)); p.trades++; p.totalUsd += Number(trade.usd || 0); if (trade.side === 'BUY') { p.buyTrades++; p.buyUsd += Number(trade.usd || 0); } else { p.sellTrades++; p.sellUsd += Number(trade.usd || 0); } }));
      if (useSaved() === '1') { enhanced.saved.forEach((address) => { if (!participants[address]) participants[address] = { address, trades: 0, buyTrades: 0, sellTrades: 0, buyUsd: 0, sellUsd: 0, totalUsd: 0, saved: true }; }); }
      const rows = useSaved() === '1' ? Object.values(participants).filter((row) => enhanced.saved.includes(String(row.address || '').toLowerCase())) : Object.values(participants);
      sortByDayStatus(rows, 'totalUsd', 'buyUsd', 'sellUsd');
      state.hlOverviewPeople = enhanced.people = rows; enhanced.secondaryAddresses = chooseSecondaryAddresses(); state.hlFrequency = {};
      $('#hlOverviewBuy').textContent = buys.length; $('#hlOverviewSell').textContent = sells.length; $('#hlOverviewBuyUsd').textContent = '$' + fmt(sum(buys), 0); $('#hlOverviewSellUsd').textContent = '$' + fmt(sum(sells), 0); renderTrades(); renderPeople();
      refreshSecondaryPanels(coin);
      if ($('#hlUseSavedAddresses')?.checked) { loadSavedLeaderSummary(); if (window.__leaderSummaryTimer) clearInterval(window.__leaderSummaryTimer); window.__leaderSummaryTimer=setInterval(() => { if (!document.hidden && $('#hlUseSavedAddresses')?.checked) loadSavedLeaderSummary(); },15000); }
    } catch (error) { const message = 'Hyperliquid временно недоступен. Локальный кэш не используется; повторю свежий запрос через 15 секунд.'; tradesBox.innerHTML = '<div class="empty">' + message + '</div>'; peopleBox.innerHTML = '<div class="empty">' + message + '</div>'; clearTimeout(window.__hlFreshRetry); window.__hlFreshRetry=setTimeout(() => enhancedLoadHlOverview(),15000); }
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
  function radarPnlPercent(position) { const pnl=Number(position?.unrealized_pnl||0); const entry=Math.abs(Number(position?.entry_price||0)*Number(position?.size||0)); const base=entry||Math.abs(Number(position?.position_value||0)); return base ? pnl/base*100 : 0; }
  function renderRadar(data) {
    const box = $('#hlRadarResults'); if (!box) return;
    const rows = data.addresses || [];
    const displayRows = data.__showAll ? rows : rows.slice(0, 1);
    const scanning = Boolean(data.running && data.scanning);
    $('#hlRadarCount').textContent = scanning && !rows.length ? 'Сканирование: первые результаты ещё загружаются' : `Найдено адресов: ${data.count || 0}`;
    $('#hlRadarState').textContent = data.running ? (data.scanning ? 'Сканирование...' : 'Радар запущен') : 'Радар остановлен';
    $('#hlRadarState').className = 'muted ' + (data.running ? 'green' : 'yellow');
    $('#hlRadarAddressText').value = rows.map((row) => row.address).join(', ');
    const best = rows.reduce((winner, row) => Number(row.open_pnl || 0) > Number(winner?.open_pnl || 0) ? row : winner, null);
    const minimum = Number($('#hlRadarMinPnl')?.value || 500);
    const bestAddress = best ? String(best.address).toLowerCase() : '';
    const bestLabel = best ? `Самый прибыльный: <button type="button" class="address wallet-address radar-best-address" data-address="${esc(bestAddress)}">${esc(bestAddress)}</button> · Open PnL ${radarMoney(best.open_pnl)}` : 'Самый прибыльный: пока нет данных';
    const bestBox = $('#hlRadarBest');
    // The radar refreshes every 10 seconds. Do not replace an expanded address
    // card while the user is reading it; it closes only on a repeated click.
    const bestDetail = $('#radar-best-detail');
    const bestDetailOpen = Boolean(bestDetail && !bestDetail.hidden);
    if (bestBox && !bestDetailOpen) {
      bestBox.innerHTML = `${bestLabel} · минимум ${radarMoney(minimum)}<div id="radar-best-detail" class="leader-portfolio-detail" hidden></div>`;
      bestBox.querySelector('.radar-best-address')?.addEventListener('click', () => loadRadarAddressDetails('radar-best-detail', bestAddress));
    }
    const savedRadar = $('#hlRadarSavedAddresses');
    if (savedRadar) savedRadar.innerHTML = enhanced.saved.length ? enhanced.saved.map((address) => `<button type="button" class="address wallet-address radar-saved-address" data-address="${esc(address)}">${esc(address)}</button>`).join(' ') : '<span class="muted">Сохранённых адресов радара пока нет.</span>';
    box.innerHTML = rows.length ? `<table><thead><tr><th>Адрес</th><th>Открытые позиции</th><th>Открытия сегодня</th><th>Баланс</th><th>Open PnL</th><th>Итог</th></tr></thead><tbody>${displayRows.map((row, index) => { const actions = row.actions || {}; const positions = (row.positions || []).map((position) => { const opened=position.opened_at ? hlTime(position.opened_at) : 'время неизвестно'; const pct=radarPnlPercent(position); return `<div class="radar-position"><span><strong>${esc(position.coin)} ${esc(position.side)}</strong> · открыта ${opened}</span><span class="${Number(position.unrealized_pnl||0)>=0?'green':'red'}">$${fmt(position.position_value,2)} · PnL ${radarMoney(position.unrealized_pnl)} (${pct>=0?'+':''}${fmt(pct,3)}%)</span></div>`; }).join('') || 'нет'; const address=String(row.address||'').toLowerCase(); const saved=savedAddress(address); const detailId=`radar-detail-${index}`; return `<tr><td><div class="address-actions"><button class="address wallet-address" onclick="loadRadarAddressDetails('${detailId}','${address}')">${address}</button><button type="button" class="pair save-detected-address${saved ? ' saved' : ''}" data-address="${address}" title="${saved ? 'Адрес сохранён' : 'Сохранить адрес'}" aria-label="${saved ? 'Адрес сохранён' : 'Сохранить адрес'}"${saved ? ' disabled' : ''}>${saved ? '✓' : '⇩'}</button><button type="button" class="pair track-radar-leader" data-address="${address}">Отслеживать лидера</button></div></td><td class="compact-cell">${positions}</td><td>${actions['Open Long'] || 0} LONG · ${actions['Open Short'] || 0} SHORT</td><td>$${fmt(row.account_value, 2)}</td><td class="green">${radarMoney(row.open_pnl)}</td><td class="green">${radarMoney(row.total_pnl)}</td></tr><tr class="trade-detail" hidden><td colspan="6"><div id="${detailId}"></div></td></tr>`; }).join('')}</tbody></table>${rows.length>1?`<button type="button" class="pair radar-more">${data.__showAll?'Скрыть остальные':'Ещё '+(rows.length-1)+' адресов'}</button>`:''}` : '<div class="empty">Сегодняшних адресов с открытым PnL от $500 не найдено.</div>';
    bindAddressSaveButtons(box);
    box.querySelectorAll('.track-radar-leader').forEach((button) => { button.onclick = () => trackRadarLeader(button.dataset.address); });
    box.querySelectorAll('.radar-saved-address').forEach((button) => { button.onclick = () => loadRadarAddressDetails('radar-saved-detail', button.dataset.address); });
    box.querySelectorAll('.wallet-address').forEach((button) => { button.onclick = () => window.loadRadarAddressDetails(button.getAttribute('onclick').match(/'([^']+)'/)[1], button.textContent.trim()); });
    let activity=$('#hlRadarActivity'); if(!activity){ activity=document.createElement('section'); activity.id='hlRadarActivity'; activity.className='panel radar-activity'; }
    // Keep the live activity outside the results container so rerendering the
    // filtered table can never remove or hide the block.
    const radarPanel=box.closest('#hlRadarPanel');
    if (radarPanel && activity.parentElement !== radarPanel.parentElement) radarPanel.insertAdjacentElement('afterend', activity);
    else if (!activity.parentElement) box.insertAdjacentElement('afterend', activity);
    const now=Date.now(); const radarWindow=Number(data.config?.window_seconds||86400)*1000; const windowStart=now-radarWindow; const events=[]; rows.forEach((row)=> (row.positions||[]).forEach((position)=>{ const time=Number(position.opened_at||row.last_seen||0); if(time && time<windowStart) return; const value=Math.abs(Number(position.position_value||0)); const pnl=Number(position.unrealized_pnl||0); const pct=value?pnl/value*100:0; events.push({time,address:row.address,coin:position.coin,side:position.side,usd:value,pnl,pct}); })); events.sort((a,b)=>b.time-a.time);
    const buys=events.filter((event)=>String(event.side).toUpperCase().includes('LONG')||String(event.side).toUpperCase()==='BUY'); const sells=events.filter((event)=>!buys.includes(event)); const line=(event)=>{ const address=String(event.address||'').toLowerCase(); const saved=savedAddress(address); return `<div class="notification-event"><span>${hlTime(event.time)} · <button type="button" class="address wallet-address radar-activity-address" data-address="${esc(address)}">${esc(address)}</button> · <strong>${esc(event.coin)} ${esc(String(event.side).toUpperCase().includes('LONG')||event.side==='Buy'?'LONG':'SHORT')}</strong> · $${fmt(event.usd,2)}</span><strong class="${event.pnl>=0?'green':'red'}">PnL ${event.pnl>=0?'+':''}$${fmt(event.pnl,2)} (${event.pct>=0?'+':''}${fmt(event.pct,3)}%)</strong><span class="activity-actions"><button type="button" class="pair save-detected-address${saved?' saved':''}" data-address="${esc(address)}"${saved?' disabled':''}>${saved?'Сохранено':'Сохранить'}</button><button type="button" class="pair track-radar-leader" data-address="${esc(address)}">Следить</button></span></div>`; };
    const activityWindow = Math.min(Number(data.config?.window_seconds || 3600), 3600) * 1000; const activityLabel = activityWindow <= 1800000 ? 'последние 30 минут' : 'последний час';
    const emptyActivity = scanning && !rows.length ? 'Сканирование live продолжается — ждём первые ответы API, старые данные не подставляются.' : '';
    const largestBuy = buys.slice().sort((a,b)=>b.usd-a.usd)[0];
    const largestBuyMarkup = largestBuy ? `<div class="radar-largest-buy"><strong>Самая крупная покупка</strong><span>${esc(largestBuy.coin)} · ${esc(String(largestBuy.side).toUpperCase().includes('LONG')?'LONG':'SHORT')} · $${fmt(largestBuy.usd,2)}</span><time>${hlTime(largestBuy.time)}</time></div>` : '';
    activity.innerHTML=`<h3>Покупки и продажи радара в реальном времени</h3><div class="muted">Период: ${hlTime(Date.now()-activityWindow)} — ${hlTime(Date.now())} · ${activityLabel} · найдено адресов по фильтру: ${rows.length} · обновляется из live-сканирования</div>${emptyActivity ? `<div class="radar-live-wait">${emptyActivity}</div>` : `<div class="pnl-groups"><div class="pnl-group profit"><strong>Покупки / LONG · ${buys.length}</strong><div class="pnl-items">${buys.map(line).join('')||'Нет покупок по текущему фильтру'}</div></div><div class="pnl-group loss"><strong>Продажи / SHORT · ${sells.length}</strong><div class="pnl-items">${sells.map(line).join('')||'Нет продаж по текущему фильтру'}</div></div></div>${largestBuyMarkup}`}`;
    bindAddressSaveButtons(activity);
    activity.querySelectorAll('.radar-activity-address').forEach((button)=>button.onclick=async()=>{ await saveDetectedAddress(button.dataset.address); loadRadarAddressDetails('radar-best-detail',button.dataset.address); });
    activity.querySelectorAll('.track-radar-leader').forEach((button)=>button.onclick=async()=>{ await requestNotificationPermission(); await trackRadarLeader(button.dataset.address); startNotificationPolling(button.dataset.address); });
  }
  async function trackRadarLeader(address) { const normalized=String(address||'').toLowerCase(); if(!/^0x[a-f0-9]{40}$/.test(normalized)) return; copyState.trackedAddress=normalized; try { const response=await fetch('/api/hyperliquid/saved-addresses',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({addresses:enhanced.saved})}); const data=await response.json(); if(!response.ok) throw Error(data.error||`HTTP ${response.status}`); enhanced.saved=data.addresses||[]; if($('#hlSavedAddresses')) $('#hlSavedAddresses').value=enhanced.saved.join(', '); if($('#hlSavedStatus')) $('#hlSavedStatus').textContent=`Лидер отслеживается: ${normalized}`; if ($('#hlUseSavedAddresses')?.checked) await loadSavedLeaderSummary(); const panel=$('#hlCopyTradePanel'); if(panel) panel.scrollIntoView({behavior:'smooth',block:'start'}); await refreshCopyPanel(); } catch(error) { if($('#hlSavedStatus')) $('#hlSavedStatus').textContent=`Не удалось включить отслеживание: ${error.message}`; } }
  async function loadRadarAddressDetails(id, user) {
    const detail=$('#'+id), row=detail?.closest('tr'); if (!detail) return; if (detail.dataset.loaded==='true') { if (row) row.hidden=!row.hidden; else detail.hidden=!detail.hidden; return; } if (row) row.hidden=false; detail.hidden=false; detail.innerHTML='<div class="muted">Загружаю дневные транзакции...</div>';
    try { const start=new Date(); start.setHours(0,0,0,0); const response=await fetch('/api/hyperliquid/analysis?'+new URLSearchParams({user,startTime:String(start.getTime())})); const data=await response.json(); if (!response.ok) throw Error(data.error||`HTTP ${response.status}`); const fills=data.fills||[]; const first=fills[0], last=fills[fills.length-1]; const opens=fills.filter((fill)=>String(fill.action||'').startsWith('Open ')); const profitableCloses=fills.filter((fill)=>String(fill.action||'').startsWith('Close ')&&Number(fill.closed_pnl||0)>0); const openUsd=opens.reduce((sum,fill)=>sum+Number(fill.usd||0),0); const profitUsd=profitableCloses.reduce((sum,fill)=>sum+Number(fill.closed_pnl||0),0); const pnl=Number(data.total_closed_pnl||0); const closeUsd=fills.filter((fill)=>String(fill.action||'').startsWith('Close ')).reduce((sum,fill)=>sum+Number(fill.usd||0),0); const totalUsd=openUsd+closeUsd; const closedShare=totalUsd?(closeUsd/totalUsd*100):0; const lastClose=fills.filter((fill)=>String(fill.action||'').startsWith('Close ')).sort((a,b)=>Number(b.time||0)-Number(a.time||0))[0]; const openRows=opens.slice().sort((a,b)=>Number(b.time||0)-Number(a.time||0)).map((fill)=>`<div class="notification-event"><span>${hlTime(fill.time)} · ${esc(fill.coin)} · ${esc(fill.action)}</span><strong>$${fmt(fill.usd,2)}</strong></div>`).join('')||'<div class="muted">Покупок/открытий сегодня нет.</div>'; const profitRows=profitableCloses.slice().sort((a,b)=>Number(b.time||0)-Number(a.time||0)).map((fill)=>`<div class="notification-event"><span>${hlTime(fill.time)} · ${esc(fill.coin)} · ${esc(fill.action)}</span><strong class="green">+$${fmt(fill.closed_pnl,2)}</strong></div>`).join('')||'<div class="muted">Прибыльных закрытий сегодня нет.</div>'; const liveId=`${id}-live`; detail.dataset.loaded='true'; detail.innerHTML=`<div class="wallet-stats"><div class="wallet-stat"><h4>${esc(user)}</h4><button type="button" class="pair" onclick="loadRadarAddressDetails('${id}','${user}')">Обновить live-позиции</button><button type="button" class="btn" onclick="trackRadarLeader('${user}')">Перейти в копирование лидера</button><div id="${liveId}" class="muted">Загружаю текущий портфель...</div><div>Первая транзакция сегодня: <strong>${first ? `${hlTime(first.time)} · ${esc(first.coin)} · ${esc(first.action)}` : 'нет'}</strong></div><div>Последняя транзакция сегодня: <strong>${last ? `${hlTime(last.time)} · ${esc(last.coin)} · ${esc(last.action)}` : 'нет'}</strong></div><div>Всего fills: <strong>${fills.length}</strong></div><div class="wallet-stat"><h4>Итоги открытий и закрытий</h4><div>Открыто: <strong>${opens.length}</strong> · $${fmt(openUsd,2)}</div><div>Закрыто: <strong>${fills.filter((fill)=>String(fill.action||'').startsWith('Close ')).length}</strong> · $${fmt(closeUsd,2)} · ${fmt(closedShare,2)}% от общего объёма</div><div>Заработано на закрытиях: <strong class="${pnl>=0?'green':'red'}">${pnl>=0?'+':''}$${fmt(pnl,2)}</strong>${lastClose?` · последнее закрытие ${hlTime(lastClose.time)}`:''}</div></div><div>Открытий/покупок: <strong>${opens.length}</strong> · общий объём: <strong>$${fmt(openUsd,2)}</strong></div><div>Прибыльных закрытий: <strong>${profitableCloses.length}</strong> · прибыль: <strong class="green">+$${fmt(profitUsd,2)}</strong></div><div>Дневной Closed PnL: <strong class="${pnl>=0?'green':'red'}">${pnl>=0?'+':''}$${fmt(pnl,2)}</strong></div></div><div class="wallet-stat"><h4>Все покупки и открытия · от новых к старым</h4><div class="notification-history">${openRows}</div></div><div class="wallet-stat"><h4>Прибыльные закрытия · от новых к старым</h4><div class="notification-history">${profitRows}</div></div></div>`; loadRadarLivePortfolio(user,liveId); } catch(error) { detail.innerHTML='<div class="red">Не удалось загрузить дневной анализ: '+esc(error.message)+'</div>'; }
  }
  async function loadRadarLivePortfolio(user, targetId) { const box=$('#'+targetId); if(!box) return; try { const response=await fetch('/api/hyperliquid/account?user='+encodeURIComponent(user)); const data=await response.json(); if(!response.ok) throw Error(data.error||`HTTP ${response.status}`); const positions=(data.positions||[]).sort((a,b)=>Number(b.opened_at||0)-Number(a.opened_at||0)).map((position)=>{const pct=radarPnlPercent(position);return `${esc(position.coin)} ${position.side==='Buy'?'LONG':'SHORT'} · $${fmt(position.position_value,2)} · PnL ${Number(position.unrealized_pnl||0)>=0?'+':''}$${fmt(position.unrealized_pnl,2)} (${pct>=0?'+':''}${fmt(pct,3)}%) · открыта ${position.opened_at?hlTime(position.opened_at):'время неизвестно'}`}).join('<br>')||'Открытых позиций нет'; box.innerHTML=`Баланс $${fmt(data.account_value,2)} · доступно $${fmt(data.withdrawable,2)} · Open PnL ${Number(data.unrealized_pnl||0)>=0?'+':''}$${fmt(data.unrealized_pnl,2)}<br>${positions}`; } catch(error) { box.innerHTML='<span class="red">Live-портфель недоступен: '+esc(error.message)+'</span>'; } }
  let radarRefreshSerial = 0;
  async function refreshRadar() {
    const serial = ++radarRefreshSerial;
    try {
      const response = await fetch('/api/hyperliquid/radar/status?_ts='+Date.now(), {cache:'no-store'});
      const data = await response.json();
      if (!response.ok) throw Error(data.error || `HTTP ${response.status}`);
      // A slow request must never overwrite a newer live response.
      if (serial === radarRefreshSerial) renderRadar(data);
    } catch (error) {
      if (serial === radarRefreshSerial && $('#hlRadarState')) $('#hlRadarState').textContent = 'Радар недоступен: ' + error.message;
    }
  }
  async function startRadar() {
    if (!$('#hlRadarSavedOnly')) { const label=document.createElement('label'); label.className='pair'; label.innerHTML='<input id="hlRadarSavedOnly" type="checkbox" checked> анализировать только сохранённые адреса'; $('#hlRadarStart')?.before(label); }
    const button = $('#hlRadarStart'); if (button) button.disabled = true;
    try { const response = await fetch('/api/hyperliquid/radar/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ window_seconds: Number($('#hlRadarWindow').value), min_pnl: Number($('#hlRadarMinPnl').value), saved_only: Boolean($('#hlRadarSavedOnly')?.checked) }) }); const data = await response.json(); if (!response.ok) throw Error(data.error || `HTTP ${response.status}`); renderRadar(data); } catch (error) { $('#hlRadarState').textContent = 'Ошибка запуска: ' + error.message; } finally { if (button) button.disabled = false; }
  }
  async function stopRadar() { const response = await fetch('/api/hyperliquid/radar/stop', { method: 'POST' }); renderRadar(await response.json()); }
  function injectRadarPanel() {
    const existing = $('#hlRadarPanel');
    if (existing) {
      if (!$('#hlRadarActivity')) {
        const activity = document.createElement('section');
        activity.id = 'hlRadarActivity';
        activity.className = 'panel radar-activity';
        activity.innerHTML = '<h3>Покупки и продажи радара в реальном времени</h3><div class="muted">Запустите радар, чтобы увидеть свежие операции.</div>';
        existing.insertAdjacentElement('afterend', activity);
      }
      return;
    }
    const view = $('#hlOverview'); if (!view) return;
    const panel = document.createElement('div'); panel.id = 'hlRadarPanel'; panel.className = 'panel'; panel.style.marginTop = '16px'; panel.innerHTML = '<h2>Радар: покупки сегодня и Open PnL от $500</h2><p class="note">Локальный радар ищет свежие адреса с Open Long/Short fill сегодня и проверяет их текущие открытые позиции в реальном времени. В список попадают только позиции с незакрытым PnL не менее $500. Несохранённые адреса не добавляются в список отслеживания.</p><div class="toolbar"><label class="pair">Окно поиска <select id="hlRadarWindow"><option value="86400">сегодня</option><option value="1800">последние 30 минут</option><option value="3600" selected>последний час</option></select></label><label class="pair">Минимум Open PnL <input id="hlRadarMinPnl" class="input" style="width:120px;min-width:120px" type="number" min="500" step="100" value="500"></label><span id="hlRadarBest" class="radar-best" aria-live="polite">Самый прибыльный: пока нет данных · минимум +$500.00</span><button class="btn" id="hlRadarStart">Запустить локальный поиск</button><button class="pair" id="hlRadarStop">Стоп</button><span id="hlRadarState" class="muted">Радар остановлен</span><span id="hlRadarCount" class="muted">Найдено адресов: 0</span></div><div class="toolbar"><input id="hlRadarAddressText" class="input" style="flex:1;min-width:320px" readonly placeholder="Найденные адреса (не сохраняются автоматически)"></div><div class="panel radar-saved-panel"><h3>Сохранённые адреса радара</h3><div id="hlRadarSavedAddresses" class="radar-saved-list"><span class="muted">Загрузка сохранённых адресов...</span></div><div id="radar-saved-detail" class="leader-portfolio-detail" hidden></div></div><div id="hlRadarResults"><div class="empty">Нажмите «Запустить локальный поиск».</div></div><section id="hlRadarActivity" class="panel radar-activity"><h3>Покупки и продажи радара в реальном времени</h3><div class="muted">Запустите радар, чтобы увидеть свежие операции.</div></section>'; view.appendChild(panel); $('#hlRadarStart').onclick = startRadar; $('#hlRadarStop').onclick = stopRadar; refreshRadar(); setInterval(refreshRadar, 10000);
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
  function injectTokenLeaderSearch() {
    const view=$('#hlOverview'); if(!view || $('#hlTokenLeaderSearch')) return;
    const panel=document.createElement('section'); panel.id='hlTokenLeaderSearch'; panel.className='panel'; panel.innerHTML='<h2>Поиск прибыльных адресов по токену</h2><div class="toolbar"><input id="hlTokenLeaderInput" class="input" placeholder="Токен, например SOL" autocomplete="off"><button id="hlTokenLeaderSearchBtn" class="btn">Найти SOLUSDT</button><span id="hlTokenLeaderStatus" class="muted">Только живой поток Hyperliquid</span></div><div id="hlTokenLeaderResults" class="empty">Введите тикер токена.</div><div id="hlTokenLeaderEvents" class="notification-history"><span class="muted">Новые покупки и продажи найденных адресов появятся здесь автоматически.</span></div>'; view.appendChild(panel);
    const renderEvents=(events)=>{ const box=$('#hlTokenLeaderEvents'); if(box) box.innerHTML=events.slice(0,50).map((event)=>`<div class="notification-event"><span>${hlTime(event.time)} · ${esc(event.address)} · ${esc(event.coin)} · ${esc(event.action)}</span><strong>$${fmt(event.usd,2)}</strong></div>`).join('')||'<span class="muted">Новых операций пока нет.</span>'; };
    const monitor=(addresses)=>{ if(window.__tokenLeaderTimer) clearInterval(window.__tokenLeaderTimer); let events=[]; const poll=async()=>{ try { const data=await (await fetch('/api/hyperliquid/notifications?'+new URLSearchParams({addresses:addresses.join(','),since:String(Date.now()-30000)}),{cache:'no-store'})).json(); events=[...(data.events||[]),...events].sort((a,b)=>Number(b.time)-Number(a.time)); renderEvents(events); } catch(_){} }; poll(); window.__tokenLeaderTimer=setInterval(poll,15000); };
    $('#hlTokenLeaderSearchBtn').onclick=async()=>{ const coin=String($('#hlTokenLeaderInput').value||'').trim().toUpperCase().replace('USDT',''); if(!coin) return; const status=$('#hlTokenLeaderStatus'), box=$('#hlTokenLeaderResults'); status.textContent='Ищу свежих участников '+coin+'USDT...'; box.innerHTML='<div class="empty">Живой поиск...</div>'; let lastError=null; for(let attempt=1;attempt<=2;attempt++){ try { const controller=new AbortController(); const timeout=setTimeout(()=>controller.abort(),45000); const response=await fetch('/api/hyperliquid/token-leaders?'+new URLSearchParams({coin,_ts:String(Date.now())}),{cache:'no-store',signal:controller.signal}); clearTimeout(timeout); const data=await response.json(); if(!response.ok) throw Error(data.error||`HTTP ${response.status}`); const rows=data.rows||[]; notificationState.tokenAddresses=rows.map((row)=>row.address); monitor(notificationState.tokenAddresses); status.textContent=`LIVE ${data.symbol} · проверено адресов: ${data.checked} · обновлено ${hlTime(data.updated_at)}`; box.innerHTML=rows.length?rows.map((row)=>`<div class="notification-event"><button type="button" class="address wallet-address token-portfolio" data-address="${esc(row.address)}">${esc(row.address)}</button><span>${esc(row.coin)} ${esc(row.side||'нет открытой позиции')} · последняя: ${esc(row.last_action)} · ${hlTime(row.last_time)}</span><strong class="${row.total_pnl>=0?'green':'red'}">Open ${row.open_pnl>=0?'+':''}$${fmt(row.open_pnl,2)} · Closed ${row.closed_pnl>=0?'+':''}$${fmt(row.closed_pnl,2)} · всего ${row.total_pnl>=0?'+':''}$${fmt(row.total_pnl,2)} · позиция $${fmt(row.position_value,2)} · сделка $${fmt(row.last_usd,2)}</strong><button class="pair token-save" data-address="${esc(row.address)}">Сохранить</button><button class="pair token-follow" data-address="${esc(row.address)}">Следить</button></div>`).join(''):'<div class="empty">В свежем потоке нет адресов с данными для '+esc(data.symbol)+'.</div>'; box.querySelectorAll('.token-portfolio').forEach((button)=>{ button.onclick=()=>{ const id='token-portfolio-'+button.dataset.address.slice(2); let detail=document.getElementById(id); if(!detail){ detail=document.createElement('div'); detail.id=id; detail.className='leader-portfolio-detail'; button.closest('.notification-event').after(detail); } loadLeaderPortfolio(button.dataset.address,id); }; }); box.querySelectorAll('.token-save').forEach((button)=>button.onclick=async()=>{ enhanced.saved=Array.from(new Set(enhanced.saved.concat(button.dataset.address))); if($('#hlSavedAddresses')) $('#hlSavedAddresses').value=enhanced.saved.join(', '); await saveAddresses(); button.textContent='Сохранено'; button.disabled=true; }); box.querySelectorAll('.token-follow').forEach((button)=>button.onclick=()=>trackRadarLeader(button.dataset.address)); return; } catch(error){ lastError=error; if(attempt<2){ status.textContent='API отвечает медленно, повторяю live-запрос...'; await new Promise((resolve)=>setTimeout(resolve,1000)); } } } status.textContent='Живой поиск недоступен'; const message=lastError?.name==='AbortError'?'Hyperliquid не ответил за 45 секунд. Повторите запрос позже.':'Сервер или Hyperliquid API временно недоступен. Повторите через несколько секунд.'; box.innerHTML='<div class="empty red">'+message+'</div>'; };
  }
  function injectControls() {
    const toolbar = $('#hlOverviewCoin')?.parentElement; if (!toolbar || $('#hlUseSavedAddresses')) return;
    const limit = document.createElement('select'); limit.id = 'hlOverviewLimit'; limit.className = 'input'; limit.innerHTML = '<option value="100">100 значений</option><option value="200">200 значений</option><option value="500">500 значений</option><option value="custom">Произвольное</option>'; toolbar.insertBefore(limit, $('#loadHlOverview'));
    const custom = document.createElement('input'); custom.id = 'hlOverviewCustomLimit'; custom.className = 'input'; custom.type = 'number'; custom.min = '1'; custom.max = '500'; custom.placeholder = 'Максимум значений'; custom.hidden = true; toolbar.insertBefore(custom, $('#loadHlOverview')); limit.onchange = () => { custom.hidden = limit.value !== 'custom'; };
    const panel = document.createElement('div'); panel.className = 'panel'; panel.style.marginBottom = '16px'; panel.innerHTML = '<div class="toolbar"><label class="pair"><input id="hlUseSavedAddresses" type="checkbox"> анализировать сохранённые адреса</label><input id="hlSavedAddresses" class="input" style="flex:1;min-width:320px" placeholder="Адреса через запятую: 0x..., 0x..."><button class="pair" id="saveHlAddresses">Сохранить адреса</button><span id="hlSavedStatus" class="muted">Адреса хранятся локально в проекте</span></div><div id="hlSavedLeaderSummary" style="margin-top:14px"><div class="empty">Нажмите «Обновить поток» для анализа сохранённых адресов.</div></div>'; const view = $('#hlOverview'); view.insertBefore(panel, view.firstElementChild.nextElementSibling); $('#saveHlAddresses').onclick = async () => { await saveAddresses(); loadSavedLeaderSummary(); }; loadSaved();
    $('#hlUseSavedAddresses').onchange=(event)=>{if(event.target.checked) loadSavedLeaderSummary(); else {const summary=$('#hlSavedLeaderSummary'); if(summary) summary.innerHTML='<div class="empty">Анализ сохранённых адресов отключён.</div>';}}; const notificationPanel=document.createElement('div'); notificationPanel.id='hlTradeNotifications'; notificationPanel.className='panel notification-panel'; notificationPanel.innerHTML='<h3>Уведомления о покупках и продажах</h3><div class="muted">Новые операции появятся здесь при включённых уведомлениях.</div>'; panel.appendChild(notificationPanel);
    const exportButton = addExportButton(toolbar, '#exportHlTradesCsv', 'Excel CSV', () => downloadCsv('hyperliquid_trades', enhanced.trades, [{ label: 'time', value: 'time' }, { label: 'coin', value: 'coin' }, { label: 'side', value: 'side' }, { label: 'price', value: 'price' }, { label: 'size', value: 'size' }, { label: 'usd', value: 'usd' }]));
    const minimum = document.createElement('input'); minimum.id = 'hlOverviewMinUsd'; minimum.className = 'input'; minimum.type = 'number'; minimum.min = '0'; minimum.step = '1'; minimum.placeholder = 'Минимум USD'; minimum.title = 'Скрыть сделки ниже указанного USD-эквивалента'; minimum.style.width = '160px'; toolbar.insertBefore(minimum, exportButton);
    addExportButton(toolbar, '#run24hAnalysis', '24ч / $5k / 500', load24hAnalysis).title = 'Реальный анализ за 24 часа: порог $5,000 и до 500 адресов';
    addExportButton(toolbar, '#run12hWhales', '12ч / $500 / киты', load12hWhales).title = 'Точные fills китов за 12 часов: Long/Short, Open/Close, PnL и комиссии';
    addExportButton(toolbar, '#run12hPnl1500', '12ч / PnL $1.5k', load12hPnl1500).title = 'Сохранённые адреса и текущий поток: net closed PnL плюс open PnL от $1,500';
    addExportButton(toolbar, '#run24hDeep', '24ч / $150 / возраст', load24hDeep).title = 'Медленный точный отчёт: fills от $150, аккаунты старше 60 дней, Open/Close Long/Short, Market/Limit, PnL';
    addExportButton(toolbar, '#runPaperBacktest', 'Paper $1k', loadPaperBacktest).title = 'Симуляция следования самому прибыльному сохранённому адресу за сегодня';
  }
  const chartBookHistory = {};
  async function loadChartOrderbook() { const box=$('#chartOrderbook'); if(!box) return; try { const data=await (await fetch('/api/bybit/orderbook?'+new URLSearchParams({symbol:state.active,depth:'30'}))).json(); const previous=chartBookHistory[state.active]||{}; const current=[...(data.bids||[]).map(x=>({...x,side:'BID'})),...(data.asks||[]).map(x=>({...x,side:'ASK'}))].filter(x=>x.large); const rows=current.map(x=>{const key=`${x.side}:${x.price}`;const old=previous[key];const ratio=old?x.usd/old:1;const status=!old?'новый уровень':ratio<0.65?'заявку активно съедают':ratio<0.9?'заявка уменьшается':'уровень держится';return {...x,ratio,status}});const oldKeys=Object.keys(previous);const disappeared=oldKeys.filter(key=>!current.some(x=>`${x.side}:${x.price}`===key));chartBookHistory[state.active]=Object.fromEntries(current.map(x=>[`${x.side}:${x.price}`,x.usd])); const closest=(side)=>{const prices=disappeared.filter(key=>key.startsWith(side+':')).map(key=>Number(key.split(':')[1])).filter(Number.isFinite);return side==='BID'?Math.max(...prices):Math.min(...prices)};const goneBid=closest('BID'),goneAsk=closest('ASK');const vanished=[Number.isFinite(goneBid)?`BID $${fmt(goneBid,6)}`:'',Number.isFinite(goneAsk)?`ASK $${fmt(goneAsk,6)}`:''].filter(Boolean).join(' · '); const large=rows.map(x=>`<tr><td class="${x.side==='BID'?'green':'red'}">${x.side}</td><td>$${fmt(x.price,6)}</td><td>$${fmt(x.usd,0)}</td><td>${fmt((x.price/(data.best_bid||x.price)-1)*100,3)}%</td><td>${x.status}</td></tr>`).join(''); box.innerHTML=`<h2>Крупные лимитные заявки и айсберги · ${esc(state.active)}</h2><div class="toolbar"><strong class="${data.pressure==='BUY'?'green':data.pressure==='SELL'?'red':'yellow'}">Давление: ${data.pressure}</strong><span class="muted">BID $${fmt(data.best_bid,6)} · ASK $${fmt(data.best_ask,6)} · обновлено ${new Date(data.updated_at).toLocaleTimeString('ru-RU')}</span></div><p class="note">«Съедают» означает: крупный уровень уменьшился между двумя снимками стакана. Это не доказывает, что заявка была исполнена, так как её могли снять.</p>${large?`<table><thead><tr><th>Сторона</th><th>Цена</th><th>Остаток USD</th><th>Отклонение</th><th>Статус</th></tr></thead><tbody>${large}</tbody></table>`:'<div class="empty">Крупных уровней сейчас нет.</div>'}${vanished?`<div class="yellow">Ближайшие исчезнувшие уровни: ${vanished}. Возможное исполнение или снятие заявки.</div>`:''}`; } catch(error) { box.innerHTML='<div class="empty">Стакан недоступен: '+esc(error.message)+'</div>'; } }
  function injectChartOrderbook() { if($('#chartOrderbook')) return; const chart=$('#priceChart')?.closest('.panel'); if(!chart) return; const panel=document.createElement('div'); panel.id='chartOrderbook'; panel.className='panel'; panel.style.marginTop='16px'; chart.after(panel); loadChartOrderbook(); setInterval(()=>{ if($('#liquidations')?.classList.contains('active')) loadChartOrderbook(); },5000); }
  function start() {
    document.querySelectorAll('.tab[data-view],.view').forEach((node) => node.classList.remove('active'));
    document.querySelector('.tab[data-view="hlOverview"]')?.classList.add('active');
    document.querySelector('#hlOverview')?.classList.add('active');
    injectControls();
    injectChartOrderbook();
    injectCopyPanel();
    injectOpenPnlLeadersPanel();
    injectRadarPanel();
    // Insert after all primary panels exist; live requests must not prevent
    // the settings block from being rendered.
    injectAutoTradingPanel();
    setTimeout(injectAutoTradingPanel, 250);
    injectTokenLeaderSearch();
    injectDexOnchainPanel();
    wrapParticipantDetails();
    const responsiveCopyStyle = document.createElement('style');
    responsiveCopyStyle.textContent = '.copy-saved-addresses{grid-column:1/-1;padding:12px;background:#0d151f;border:1px solid var(--line);border-radius:7px}.copy-saved-best-leaders{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:10px 0}.copy-saved-best-card{display:grid;gap:5px;min-width:0;padding:10px;background:#111d2a;border:1px solid var(--line);border-radius:7px}.copy-saved-best-card .address{min-width:0;overflow-wrap:anywhere;text-align:left}.copy-saved-best-card .leader-portfolio-detail{grid-column:1/-1}.copy-saved-address-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin-top:8px;max-height:260px;overflow:auto}.copy-saved-address-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px;align-items:center;padding:6px 0;border-bottom:1px solid rgba(34,48,63,.5)}.copy-saved-address{min-width:0;text-align:left}.copy-saved-open{white-space:nowrap}.open-pnl-leaders-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.open-pnl-leader-card{min-width:0;padding:14px;background:#0d151f;border:1px solid var(--line);border-radius:7px;display:grid;gap:7px}.open-pnl-leader-card h3{margin:0;color:var(--muted)}.open-pnl-leader-card .address{overflow-wrap:anywhere;text-align:left}.open-pnl-actions{display:flex;gap:8px;flex-wrap:wrap}.open-pnl-actions button{flex:1;min-width:150px}.auto-trading-toolbar{align-items:flex-end}.auto-trading-toolbar .pair{display:flex;align-items:center;gap:8px;min-height:42px}.auto-trading-toolbar input.input{width:100px;min-width:100px}.auto-trading-toolbar select.pair{padding:8px 10px}@media(max-width:560px){.copy-saved-best-leaders{grid-template-columns:1fr}.copy-saved-address-list{grid-template-columns:1fr}.copy-saved-address-row{grid-template-columns:1fr}.copy-saved-open{width:100%}.open-pnl-leaders-grid{grid-template-columns:1fr}.open-pnl-actions{display:grid;grid-template-columns:1fr}.open-pnl-actions button{width:100%}.auto-trading-toolbar{display:grid;grid-template-columns:1fr}.auto-trading-toolbar .pair,.auto-trading-toolbar .btn{width:100%}.auto-trading-toolbar input.input{width:100%;min-width:0}}';
    document.head.appendChild(responsiveCopyStyle);
    const style = document.createElement('style');
    style.textContent = '.radar-best{color:var(--cyan);font-weight:700;padding:8px 10px;border:1px solid rgba(85,214,194,.4);border-radius:7px;white-space:normal;overflow-wrap:anywhere;max-width:100%}.radar-saved-panel{margin:0 0 16px;padding:12px;background:#0d151f}.radar-saved-panel h3{margin:0 0 8px;color:var(--muted);font-size:14px}.radar-saved-list{display:flex;flex-wrap:wrap;gap:8px}.radar-saved-address{padding:4px 0}.notification-group{margin:8px 0;padding:10px 12px;background:#0d151f;border:1px solid var(--line);border-radius:7px}.notification-group summary{display:flex;justify-content:space-between;gap:12px;cursor:pointer;list-style:none}.notification-group summary::-webkit-details-marker{display:none}.notification-history{margin-top:8px;padding-top:6px;border-top:1px solid var(--line);max-height:260px;overflow:auto}.notification-event{padding:5px 0;color:var(--muted);border-bottom:1px solid rgba(34,48,63,.5)}.address-actions{display:flex;align-items:center;gap:6px}.save-detected-address{margin-left:8px;min-width:32px;padding:4px 8px}.address-actions .save-detected-address{margin-left:0}.save-detected-address.saved{border-color:var(--cyan);color:var(--cyan)}.radar-position{display:flex;justify-content:space-between;gap:16px;min-width:520px;padding:4px 0;border-bottom:1px solid rgba(34,48,63,.55)}.radar-position>span:last-child{white-space:nowrap;text-align:right}.pnl-groups{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px;margin-top:8px}.pnl-group{padding:9px;border:1px solid var(--line);border-radius:7px;background:#0d151f}.pnl-group.profit{border-color:rgba(85,214,194,.45)}.pnl-group.loss{border-color:rgba(255,139,147,.45)}.pnl-group.flat{border-color:rgba(241,207,105,.45)}.pnl-items{margin-top:6px;color:var(--muted);line-height:1.45;max-height:300px;overflow:auto}.wallet-stat h4{margin:10px 0 6px;color:var(--muted);font-size:12px}.copy-panel{margin-top:16px}.copy-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.copy-grid>div{min-width:0;display:grid;gap:5px;padding:12px;background:#0d151f;border:1px solid var(--line);border-radius:7px}.copy-grid strong{overflow-wrap:anywhere}.copy-all-positions{max-height:180px;overflow:auto;padding-top:6px;color:var(--muted);line-height:1.45}.copy-actions{margin-top:14px}.copy-follow-status{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:14px;padding:10px;background:#0d151f;border:1px solid var(--line);border-radius:7px;font-size:12px}.copy-follow-status span{overflow-wrap:anywhere}@media(max-width:900px){.copy-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:560px){.copy-grid{grid-template-columns:1fr}.copy-actions .btn,.copy-actions .pair{width:100%}.radar-position{min-width:0;display:block}.radar-position>span:last-child{display:block;text-align:left}.radar-best{width:100%}.notification-group summary{display:block}.notification-group summary .muted{display:block;margin-top:5px}}';
    document.head.appendChild(style);
    installDescendingTableSort();
    window.loadHlOverview = enhancedLoadHlOverview;
    window.loadTradeWallets = enhancedLoadTradeWallets;
    window.loadOverviewAccount = enhancedLoadOverviewAccount;
    window.loadTradeParticipants = enhancedLoadTradeParticipants;
    window.loadIcebergAccount = enhancedLoadIcebergAccount;
    window.loadWalletAccount = enhancedLoadWalletAccount;
    window.loadRadarAddressDetails = loadRadarAddressDetails;
    window.trackRadarLeader = trackRadarLeader;
    const button = $('#loadHlOverview');
    if (button) button.onclick = () => { enhancedLoadHlOverview(); clearInterval(window.__hlStreamTimer); window.__hlStreamTimer=setInterval(() => { if (!document.hidden) enhancedLoadHlOverview(); },15000); };
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
