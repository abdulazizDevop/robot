/* Auto-trade panel: whale follower on top, manual desk underneath.
   Discovery reuses the endpoints that already exist; nothing here re-implements
   the radar or the 12h whale filter. */
(function () {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
  const fmt = (value, digits = 2) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return '—';
    return number.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  };
  const money = (value) => (value == null || !Number.isFinite(Number(value))
    ? '—' : `${Number(value) < 0 ? '-' : ''}$${fmt(Math.abs(Number(value)), 2)}`);
  const clock = (ms) => (ms ? new Date(Number(ms)).toLocaleTimeString('ru-RU') : '—');

  const state = { settings: null, timer: null, candidates: [], busy: false };

  async function api(path, options) {
    const response = await fetch(path, options);
    let data = {};
    try { data = await response.json(); } catch (error) { data = {}; }
    if (!response.ok) throw Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  const jsonPost = (body) => ({
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  });

  /* ------------------------------------------------------------- markup */

  function viewMarkup() {
    return `
<div class="panel">
  <h2>Авто-торговля по китам</h2>
  <p class="note">Радар сам ищет прибыльные адреса по встроенной логике, движок закрепляется за лучшим из них и следит за его входами. Как только кит открывает позицию и разница между его ценой входа и текущей ценой не превышает порога, ордер уходит немедленно — движок не ждёт следующего обновления кита.</p>
  <div class="toolbar">
    <button class="btn" id="atStart">Авто-торговля</button>
    <button class="pair" id="atStop">Стоп</button>
    <span id="atPhase" class="muted">Остановлено</span>
    <span id="atVenue" class="muted"></span>
  </div>
  <div class="toolbar">
    <span class="muted">Цель:</span>
    <input id="atTarget" class="input" style="flex:1;min-width:340px" placeholder="Адрес выбирается радаром автоматически. Можно закрепить свой 0x...">
    <button class="pair" id="atSetTarget">Закрепить</button>
    <button class="pair" id="atClearTarget">Авто-выбор</button>
  </div>
  <div class="toolbar" style="border-top:1px solid var(--line);padding-top:10px;margin-top:4px">
    <label class="pair"><input id="atOnlySaved" type="checkbox"> торговать только по сохранённым адресам</label>
    <span id="atOnlySavedState" class="muted"></span>
  </div>
  <div id="atSavedList"></div>
  <div id="atStats" class="wallet-stats"></div>
  <h4 style="margin:14px 0 6px;color:var(--muted);font-size:12px">Скопированные позиции и закрытие вместе с лидером</h4>
  <div class="toolbar">
    <span id="atCloseState" class="muted"></span>
    <button class="pair" id="atCloseAll">Закрыть все позиции</button>
  </div>
  <div id="atMirrors"><div class="empty">Скопированных позиций нет.</div></div>
  <h4 style="margin:14px 0 6px;color:var(--muted);font-size:12px">Активные ордера кита (openOrders)</h4>
  <div id="atWhaleOrders"><div class="empty">Цель не выбрана.</div></div>
</div>

<div class="panel" style="margin-top:16px">
  <h2>Настройки исполнения</h2>
  <p class="note">Торгуются только фьючерсы (деривативы): Bybit USDT-perpetual (category=linear) и Hyperliquid perps. Спот не используется. По умолчанию 1x и лимитный ордер, режим dry-run: ключи не нужны, ордера только записываются. Переключение на testnet или live требует ключей биржи.</p>
  <div class="toolbar">
    <label class="pair">Биржа <select id="setVenue"><option value="hyperliquid">Hyperliquid</option><option value="bybit">Bybit</option></select></label>
    <label class="pair">Режим <select id="setMode"><option value="dry-run">dry-run (без ключей)</option><option value="testnet">testnet</option><option value="live">LIVE — реальные деньги</option></select></label>
    <label class="pair">Плечо <input id="setLeverage" class="input" style="width:80px;min-width:80px" type="number" min="1" max="50" step="1"></label>
    <label class="pair">Тип ордера <select id="setOrderType"><option value="limit">Лимитный</option><option value="market">Рыночный</option></select></label>
  </div>
  <div class="toolbar">
    <label class="pair">Порог отклонения % <input id="setDeviation" class="input" style="width:100px;min-width:100px" type="number" min="0" max="100" step="0.1"></label>
    <label class="pair">Сумма ордера $ <input id="setOrderUsd" class="input" style="width:110px;min-width:110px" type="number" min="1" step="10"></label>
    <label class="pair">Смещение лимита % <input id="setOffset" class="input" style="width:110px;min-width:110px" type="number" min="-5" max="5" step="0.01"></label>
    <label class="pair">Опрос, сек <input id="setPoll" class="input" style="width:90px;min-width:90px" type="number" min="1" max="300" step="1"></label>
  </div>
  <div class="toolbar">
    <label class="pair"><input id="setAutoClose" type="checkbox"> закрывать вместе с лидером</label>
    <label class="pair">Подтверждений закрытия <input id="setCloseConfirmations" class="input" style="width:80px;min-width:80px" type="number" min="1" max="10" step="1"></label>
    <label class="pair">Тип закрытия <select id="setCloseOrderType"><option value="limit_chase">лимит с перевыставлением → рынок</option><option value="limit">только лимит</option><option value="market">рыночный</option></select></label>
    <label class="pair">Ждать исполнения, сек <input id="setCloseChaseSeconds" class="input" style="width:90px;min-width:90px" type="number" min="1" max="120" step="1"></label>
    <label class="pair">Попыток <input id="setCloseChaseAttempts" class="input" style="width:80px;min-width:80px" type="number" min="1" max="10" step="1"></label>
  </div>
  <div class="toolbar">
    <label class="pair">Цена лимита <select id="setLimitPricing"><option value="book">по стакану — исполнение сразу</option><option value="mid">по середине — ждать в стакане</option></select></label>
    <label class="pair">Макс. риск на ордер, % счёта <input id="setRiskPct" class="input" style="width:100px;min-width:100px" type="number" min="0" max="100" step="1"></label>
    <label class="pair">Мин. свободный баланс $ <input id="setMinFree" class="input" style="width:110px;min-width:110px" type="number" min="0" step="10"></label>
    <label class="pair"><input id="setVerifyFills" type="checkbox"> проверять исполнение ордера</label>
  </div>
  <div class="toolbar">
    <label class="pair">Стороны <select id="setDirection"><option value="both">Long и Short</option><option value="long_only">только Long</option><option value="short_only">только Short</option></select></label>
    <label class="pair">Макс. позиций <input id="setMaxPositions" class="input" style="width:90px;min-width:90px" type="number" min="1" max="50" step="1"></label>
    <label class="pair">Макс. ордеров в час <input id="setMaxOrders" class="input" style="width:100px;min-width:100px" type="number" min="1" max="1000" step="1"></label>
    <label class="pair"><input id="setMirrorExisting" type="checkbox"> копировать уже открытые позиции</label>
  </div>
  <div class="toolbar">
    <label class="pair" style="flex:1;min-width:320px">Монеты (пусто = все) <input id="setCoins" class="input" style="flex:1;min-width:220px" placeholder="BTC, ETH, SOL"></label>
    <button class="btn" id="atSaveSettings">Сохранить настройки</button>
    <span id="atSettingsMessage" class="muted"></span>
  </div>
</div>

<div class="panel" style="margin-top:16px">
  <h2>Ручная торговля</h2>
  <p class="note">«Анализировать» запускает ту же встроенную логику отбора китов с вашими фильтрами. Подходящие адреса и их открытые позиции появятся ниже; покупка идёт выбранным типом ордера.</p>
  <div class="toolbar">
    <label class="pair">Монета <input id="manCoin" class="input" style="width:110px;min-width:110px" placeholder="ALL"></label>
    <label class="pair">Порог сделки $ <input id="manMinUsd" class="input" style="width:110px;min-width:110px" type="number" min="0" step="100" value="500"></label>
    <label class="pair">Мин. PnL $ <input id="manMinPnl" class="input" style="width:110px;min-width:110px" type="number" min="0" step="100" value="1500"></label>
    <label class="pair">Возраст, дней <input id="manMinAge" class="input" style="width:100px;min-width:100px" type="number" min="0" step="10" value="120"></label>
  </div>
  <div class="toolbar">
    <label class="pair">Макс. аккаунтов <input id="manMaxAccounts" class="input" style="width:100px;min-width:100px" type="number" min="5" max="50" step="5" value="20"></label>
    <label class="pair"><input id="manWinRate" type="checkbox" checked> только с положительным win rate</label>
    <label class="pair"><input id="manToday" type="checkbox" checked> только торговавшие сегодня</label>
    <button class="btn" id="manAnalyze">Анализировать</button>
    <span id="manStatus" class="muted">Фильтры совпадают со встроенной логикой отбора.</span>
  </div>
  <div id="manResults"><div class="empty">Нажмите «Анализировать», чтобы найти подходящие адреса.</div></div>
</div>

<div class="panel" style="margin-top:16px">
  <h2>Журнал ордеров и решений</h2>
  <div class="toolbar"><button class="pair" id="atRefreshLog">Обновить журнал</button><span id="atLogStatus" class="muted"></span></div>
  <div id="atOrders"></div>
  <div id="atDecisions" style="margin-top:12px"></div>
</div>`;
  }

  function injectView() {
    if ($('#autoTrade')) return;
    const footer = document.querySelector('.footer');
    const tabs = document.querySelector('.tabs');
    if (!footer || !tabs) return;

    const view = document.createElement('section');
    view.id = 'autoTrade';
    view.className = 'view';
    view.innerHTML = viewMarkup();
    footer.before(view);

    const tab = document.createElement('button');
    tab.className = 'tab';
    tab.type = 'button';
    tab.dataset.view = 'autoTrade';
    tab.textContent = 'Авто-торговля';
    const more = document.querySelector('#extraTabsToggle');
    if (more) tabs.insertBefore(tab, more); else tabs.appendChild(tab);
    // The index page binds tabs once at load, so this late tab binds itself
    // with the same behaviour.
    tab.onclick = () => {
      document.querySelectorAll('.tab[data-view],.view').forEach((node) => node.classList.remove('active'));
      tab.classList.add('active');
      $('#autoTrade').classList.add('active');
      const extra = document.querySelector('#extraTabs');
      const toggle = document.querySelector('#extraTabsToggle');
      if (extra && toggle) { extra.hidden = true; toggle.setAttribute('aria-expanded', 'false'); toggle.classList.remove('active'); }
      refreshStatus();
      refreshLog();
    };
  }

  /* ----------------------------------------------------------- settings */

  function fillSettings(settings) {
    state.settings = settings;
    $('#setVenue').value = settings.venue;
    $('#setMode').value = settings.mode;
    $('#setLeverage').value = settings.leverage;
    $('#setOrderType').value = settings.order_type;
    $('#setDeviation').value = settings.max_deviation_pct;
    $('#setOrderUsd').value = settings.order_usd;
    $('#setOffset').value = settings.limit_offset_pct;
    $('#setPoll').value = settings.poll_interval_seconds;
    $('#setDirection').value = settings.follow_direction;
    $('#setMaxPositions').value = settings.max_open_positions;
    $('#setMaxOrders').value = settings.max_orders_per_hour;
    $('#setMirrorExisting').checked = !!settings.mirror_existing_positions;
    $('#setCoins').value = (settings.follow_coins || []).join(', ');
    $('#setLimitPricing').value = settings.limit_pricing;
    $('#setRiskPct').value = settings.max_account_risk_pct;
    $('#setMinFree').value = settings.min_free_balance_usd;
    $('#setVerifyFills').checked = !!settings.verify_fills;
    $('#setAutoClose').checked = !!settings.auto_close;
    $('#setCloseConfirmations').value = settings.close_confirmations;
    $('#setCloseOrderType').value = settings.close_order_type;
    $('#setCloseChaseSeconds').value = settings.close_chase_seconds;
    $('#setCloseChaseAttempts').value = settings.close_chase_attempts;
  }

  async function loadSettings() {
    try {
      const data = await api('/api/autotrade/settings');
      fillSettings(data.settings);
    } catch (error) {
      $('#atSettingsMessage').textContent = 'Не удалось загрузить настройки: ' + error.message;
    }
  }

  async function saveSettings() {
    const message = $('#atSettingsMessage');
    const mode = $('#setMode').value;
    if (mode === 'live' && !window.confirm(
      'Режим LIVE отправляет реальные ордера на биржу за реальные деньги.\n\nПродолжить?')) {
      $('#setMode').value = state.settings ? state.settings.mode : 'dry-run';
      return;
    }
    message.textContent = 'Сохраняю...';
    try {
      const data = await api('/api/autotrade/settings', jsonPost({
        venue: $('#setVenue').value,
        mode,
        leverage: Number($('#setLeverage').value),
        order_type: $('#setOrderType').value,
        max_deviation_pct: Number($('#setDeviation').value),
        order_usd: Number($('#setOrderUsd').value),
        limit_offset_pct: Number($('#setOffset').value),
        poll_interval_seconds: Number($('#setPoll').value),
        follow_direction: $('#setDirection').value,
        max_open_positions: Number($('#setMaxPositions').value),
        max_orders_per_hour: Number($('#setMaxOrders').value),
        mirror_existing_positions: $('#setMirrorExisting').checked,
        follow_coins: $('#setCoins').value,
        limit_pricing: $('#setLimitPricing').value,
        max_account_risk_pct: Number($('#setRiskPct').value),
        min_free_balance_usd: Number($('#setMinFree').value),
        verify_fills: $('#setVerifyFills').checked,
        auto_close: $('#setAutoClose').checked,
        close_confirmations: Number($('#setCloseConfirmations').value),
        close_order_type: $('#setCloseOrderType').value,
        close_chase_seconds: Number($('#setCloseChaseSeconds').value),
        close_chase_attempts: Number($('#setCloseChaseAttempts').value),
      }));
      fillSettings(data.settings);
      const venue = data.venue_status || {};
      message.textContent = `Сохранено. ${venue.ready ? '' : 'Внимание: '}${venue.reason || ''}`;
      message.className = 'muted ' + (venue.ready ? 'green' : 'yellow');
      refreshStatus();
    } catch (error) {
      message.textContent = 'Ошибка: ' + error.message;
      message.className = 'muted yellow';
    }
  }

  /* ------------------------------------------------------------- status */

  function renderStatus(data) {
    const settings = data.settings || {};
    const venue = data.venue_status || {};
    const phase = { idle: 'Остановлено', searching: 'Ищу адрес...', watching: 'Слежу за китом' }[data.phase] || data.phase;
    $('#atPhase').textContent = data.running ? phase : 'Остановлено';
    $('#atPhase').className = 'muted ' + (data.running ? 'green' : '');
    const modeLabel = { 'dry-run': 'dry-run (ордера не отправляются)', testnet: 'testnet', live: 'LIVE' }[settings.mode] || settings.mode;
    $('#atVenue').textContent = `${venue.venue || settings.venue} · ${modeLabel} · ${settings.leverage}x · ${settings.order_type === 'limit' ? 'лимитный' : 'рыночный'}`;
    $('#atVenue').className = 'muted ' + (settings.mode === 'live' ? 'yellow' : '');
    if (data.target && $('#atTarget') !== document.activeElement) $('#atTarget').value = data.target;

    $('#atStats').innerHTML = `
      <div class="wallet-stat"><h4>Цель</h4>${data.target ? `<span class="address">${esc(data.target)}</span>` : 'радар ещё не подтвердил адрес'}</div>
      <div class="wallet-stat"><h4>Проверено сигналов</h4>${data.checked_signals || 0}</div>
      <div class="wallet-stat"><h4>Ордеров отправлено</h4><span class="green">${data.orders_sent || 0}</span> · пропущено: ${data.orders_skipped || 0}</div>
      <div class="wallet-stat"><h4>Открытых копий</h4>${data.open_mirrors || 0} из ${settings.max_open_positions} · за час: ${data.orders_last_hour || 0}/${settings.max_orders_per_hour}</div>
      <div class="wallet-stat"><h4>Последний опрос</h4>${clock(data.last_poll_at)}</div>
      <div class="wallet-stat"><h4>Подключение</h4><span class="${venue.ready ? 'green' : 'yellow'}">${esc(venue.reason || '—')}</span></div>
      ${data.last_error ? `<div class="wallet-stat"><h4>Ошибка</h4><span class="yellow">${esc(data.last_error)}</span></div>` : ''}`;
  }

  async function refreshStatus() {
    try {
      const data = await api('/api/autotrade/status');
      renderStatus(data);
      renderSavedOnly(data);
      renderMirrors(data);
      refreshWhaleOrders(data.target);
    } catch (error) {
      $('#atPhase').textContent = 'Статус недоступен: ' + error.message;
    }
  }

  function renderSavedOnly(data) {
    const toggle = $('#atOnlySaved');
    const label = $('#atOnlySavedState');
    const list = $('#atSavedList');
    if (!toggle || !label || !list) return;
    const on = !!data.only_saved_addresses;
    const saved = data.saved_addresses || [];
    if (document.activeElement !== toggle) toggle.checked = on;
    const target = String(data.target || '').toLowerCase();

    if (!on) {
      label.textContent = 'Выключено — цель выбирает радар из всех найденных адресов.';
      label.className = 'muted';
      list.innerHTML = '';
      return;
    }
    if (!saved.length) {
      label.textContent = 'Включено, но список пуст — сохраните адреса, иначе движок не найдёт цель.';
      label.className = 'muted yellow';
      list.innerHTML = '';
      return;
    }
    label.textContent = `Включено · адресов в списке: ${saved.length} · вход только по ним`;
    label.className = 'muted green';
    list.innerHTML = `<table><thead><tr><th>Сохранённый адрес</th><th>Статус</th></tr></thead><tbody>${saved.map((address) => `<tr>
      <td class="mono">${esc(address)}</td>
      <td class="${address.toLowerCase() === target ? 'green' : ''}">${address.toLowerCase() === target ? 'слежу сейчас' : 'в очереди'}</td>
    </tr>`).join('')}</tbody></table>`;
  }

  async function toggleSavedOnly(event) {
    const on = event.target.checked;
    try {
      await api('/api/autotrade/settings', jsonPost({ only_saved_addresses: on }));
      refreshStatus();
    } catch (error) {
      event.target.checked = !on;
      window.alert('Не удалось переключить: ' + error.message);
    }
  }

  function renderMirrors(data) {
    const box = $('#atMirrors');
    const label = $('#atCloseState');
    if (!box || !label) return;
    const rows = data.mirrors || [];
    const settings = data.settings || {};
    const needed = data.close_confirmations_required || 2;
    const style = {
      limit_chase: 'лимит с перевыставлением, затем рынок',
      limit: 'только лимит',
      market: 'рыночный',
    }[settings.close_order_type] || settings.close_order_type;
    label.textContent = settings.auto_close
      ? `Автозакрытие активно · подтверждений: ${needed} · закрытие: ${style}`
      : 'Автозакрытие выключено — позиции придётся закрывать вручную';
    label.className = 'muted ' + (settings.auto_close ? 'green' : 'yellow');

    if (!rows.length) {
      box.innerHTML = '<div class="empty">Скопированных позиций нет.</div>';
      return;
    }
    box.innerHTML = `<table><thead><tr><th>Монета</th><th>Сторона</th><th>Наш объём</th><th>Наш вход</th><th>Позиция лидера</th><th>PnL лидера</th><th>Проверок закрытия</th><th>Закрытие</th><th></th></tr></thead><tbody>${rows.map((row) => `<tr>
      <td>${esc(row.coin)}</td>
      <td class="${row.side === 'BUY' ? 'green' : 'red'}">${row.side === 'BUY' ? 'LONG' : 'SHORT'}</td>
      <td>${fmt(row.qty, 6)}</td>
      <td>${fmt(row.entry_price, 6)}</td>
      <td class="${row.leader_still_open ? 'green' : 'yellow'}">${row.leader_still_open ? money(row.leader_position_value) : 'закрыта'}</td>
      <td class="${Number(row.leader_unrealized_pnl) >= 0 ? 'green' : 'red'}">${money(row.leader_unrealized_pnl)}</td>
      <td>${row.leader_still_open ? '—' : `${row.close_checks}/${needed}`}</td>
      <td>${row.closing_order_id ? `ордер ${esc(String(row.closing_order_id).slice(0, 12))} · попытка ${row.close_attempts + 1}` : '—'}</td>
      <td><button class="pair" data-close-coin="${esc(row.coin)}" data-close-side="${esc(row.side)}">Закрыть</button></td>
    </tr>`).join('')}</tbody></table>`;

    box.querySelectorAll('[data-close-coin]').forEach((button) => {
      button.onclick = () => closeOne(button.dataset.closeCoin, button.dataset.closeSide, button);
    });
  }

  async function closeOne(coin, side, button) {
    const settings = state.settings || {};
    if (settings.mode === 'live' && !window.confirm(
      `LIVE: закрыть позицию ${coin} ${side === 'BUY' ? 'LONG' : 'SHORT'} реальным ордером?`)) return;
    button.disabled = true;
    const original = button.textContent;
    button.textContent = 'Закрываю...';
    try {
      const data = await api('/api/autotrade/close', jsonPost({ coin, side }));
      const result = data.closed || {};
      button.textContent = result.filled ? 'Закрыто' : 'Ордер выставлен';
      refreshStatus();
      refreshLog();
    } catch (error) {
      button.disabled = false;
      button.textContent = original;
      window.alert('Не удалось закрыть: ' + error.message);
    }
  }

  async function closeAll() {
    const settings = state.settings || {};
    if (!window.confirm(settings.mode === 'live'
      ? 'LIVE: закрыть ВСЕ скопированные позиции реальными ордерами?'
      : 'Закрыть все скопированные позиции?')) return;
    const button = $('#atCloseAll');
    button.disabled = true;
    try {
      const data = await api('/api/autotrade/close-all', jsonPost({}));
      const closed = data.closed || [];
      const failed = closed.filter((row) => row.ok === false);
      window.alert(failed.length
        ? `Закрыто: ${closed.length - failed.length}. Ошибки:\n` + failed.map((r) => `${r.coin} ${r.side}: ${r.error}`).join('\n')
        : `Закрыто позиций: ${closed.length}`);
      refreshStatus();
      refreshLog();
    } catch (error) {
      window.alert('Не удалось закрыть: ' + error.message);
    } finally { button.disabled = false; }
  }

  async function refreshWhaleOrders(address) {
    const box = $('#atWhaleOrders');
    if (!box) return;
    if (!address) { box.innerHTML = '<div class="empty">Цель не выбрана.</div>'; return; }
    try {
      const data = await api('/api/autotrade/whale-orders?address=' + encodeURIComponent(address));
      const orders = data.orders || [];
      box.innerHTML = orders.length
        ? `<table><thead><tr><th>Монета</th><th>Сторона</th><th>Цена</th><th>Размер</th><th>Поставлен</th></tr></thead><tbody>${orders.map((row) => `<tr>
            <td>${esc(row.coin)}</td>
            <td class="${row.side === 'BUY' ? 'green' : 'red'}">${esc(row.side)}</td>
            <td>${fmt(row.price, 6)}</td>
            <td>${fmt(row.size, 6)}</td>
            <td>${clock(row.time)}</td>
          </tr>`).join('')}</tbody></table>`
        : '<div class="empty">У кита нет активных лимитных ордеров.</div>';
    } catch (error) {
      box.innerHTML = '<div class="empty">Ордера кита недоступны: ' + esc(error.message) + '</div>';
    }
  }

  async function startAuto() {
    const button = $('#atStart');
    button.disabled = true;
    try {
      const target = $('#atTarget').value.trim();
      renderStatus(await api('/api/autotrade/start', jsonPost(target ? { address: target } : {})));
    } catch (error) {
      $('#atPhase').textContent = 'Не удалось запустить: ' + error.message;
      $('#atPhase').className = 'muted yellow';
    } finally { button.disabled = false; }
  }

  async function stopAuto() {
    try { renderStatus(await api('/api/autotrade/stop', jsonPost({}))); }
    catch (error) { $('#atPhase').textContent = 'Ошибка остановки: ' + error.message; }
  }

  async function setTarget(address) {
    try { renderStatus(await api('/api/autotrade/target', jsonPost({ address }))); }
    catch (error) { $('#atPhase').textContent = 'Ошибка цели: ' + error.message; }
  }

  /* --------------------------------------------------------------- log */

  function renderLog(data) {
    const orders = data.orders || [];
    const decisions = data.decisions || [];
    $('#atOrders').innerHTML = orders.length ? `<table><thead><tr><th>Время</th><th>Адрес</th><th>Монета</th><th>Сторона</th><th>Цена кита</th><th>Рынок</th><th>Откл.</th><th>Объём</th><th>Цена ордера</th><th>Режим</th><th>Статус</th></tr></thead><tbody>${orders.map((row) => `<tr>
      <td>${clock(row.created_at)}</td>
      <td class="address">${esc(String(row.address || '').slice(0, 10))}…</td>
      <td>${esc(row.coin)}</td>
      <td class="${row.side === 'BUY' ? 'green' : 'red'}">${esc(row.side)}</td>
      <td>${fmt(row.whale_price, 6)}</td>
      <td>${fmt(row.market_price, 6)}</td>
      <td>${fmt(row.deviation_pct, 3)}%</td>
      <td>${fmt(row.qty, 6)} (${money(row.usd)})</td>
      <td>${fmt(row.price, 6)}</td>
      <td>${esc(row.venue)} · ${esc(row.mode)}</td>
      <td class="${row.status === 'failed' ? 'red' : 'green'}">${esc(row.status)}${row.error ? ' · ' + esc(row.error) : ''}</td>
    </tr>`).join('')}</tbody></table>` : '<div class="empty">Ордеров пока нет.</div>';

    $('#atDecisions').innerHTML = decisions.length ? `<table><thead><tr><th>Время</th><th>Монета</th><th>Сторона</th><th>Цена кита</th><th>Рынок</th><th>Отклонение</th><th>Решение</th><th>Причина</th></tr></thead><tbody>${decisions.map((row) => `<tr>
      <td>${clock(row.created_at)}</td>
      <td>${esc(row.coin)}</td>
      <td>${esc(row.side)}</td>
      <td>${row.whale_price == null ? '—' : fmt(row.whale_price, 6)}</td>
      <td>${row.market_price == null ? '—' : fmt(row.market_price, 6)}</td>
      <td>${row.deviation_pct == null ? '—' : fmt(row.deviation_pct, 3) + '%'}</td>
      <td class="${row.decision === 'executed' ? 'green' : (row.decision === 'failed' ? 'red' : '')}">${esc(row.decision)}</td>
      <td class="muted">${esc(row.reason)}</td>
    </tr>`).join('')}</tbody></table>` : '<div class="empty">Решений пока нет.</div>';
    $('#atLogStatus').textContent = `Ордеров: ${orders.length} · решений: ${decisions.length}`;
  }

  async function refreshLog() {
    try { renderLog(await api('/api/autotrade/orders?limit=100')); }
    catch (error) { $('#atLogStatus').textContent = 'Журнал недоступен: ' + error.message; }
  }

  /* ----------------------------------------------------- manual trading */

  function renderCandidates(whales) {
    state.candidates = whales;
    const box = $('#manResults');
    if (!whales.length) {
      box.innerHTML = '<div class="empty">Ни один адрес не прошёл фильтры. Ослабьте пороги и попробуйте снова.</div>';
      return;
    }
    box.innerHTML = whales.map((row, index) => {
      const positions = row.positions || [];
      const rows = positions.length ? positions.map((position) => `<tr>
        <td>${esc(position.coin)}</td>
        <td class="${position.side === 'LONG' ? 'green' : 'red'}">${esc(position.side)}</td>
        <td>${fmt(position.entry_price, 6)}</td>
        <td>${money(position.position_value)}</td>
        <td class="${Number(position.unrealized_pnl) >= 0 ? 'green' : 'red'}">${money(position.unrealized_pnl)}</td>
        <td><button class="pair" data-buy-index="${index}" data-buy-coin="${esc(position.coin)}" data-buy-side="${position.side === 'LONG' ? 'BUY' : 'SELL'}">Купить</button></td>
      </tr>`).join('') : '<tr><td colspan="6" class="muted">Открытых позиций нет</td></tr>';
      return `<div class="panel" style="margin-top:10px">
        <div class="toolbar">
          <span class="address">${esc(row.address)}</span>
          <span class="muted">итог PnL: <span class="${Number(row.total_pnl_including_open) >= 0 ? 'green' : 'red'}">${money(row.total_pnl_including_open)}</span></span>
          <span class="muted">win rate: ${row.profitable_close_rate_pct == null ? '—' : fmt(row.profitable_close_rate_pct, 1) + '%'}</span>
          <span class="muted">возраст: ${fmt(row.first_profitable_close_age_days, 0)} дн.</span>
          <span class="muted">баланс: ${money(row.account_value)}</span>
          <button class="pair" data-follow="${esc(row.address)}">Следить в авто-режиме</button>
        </div>
        <table><thead><tr><th>Монета</th><th>Сторона</th><th>Вход кита</th><th>Объём</th><th>Нереализ. PnL</th><th>Действие</th></tr></thead><tbody>${rows}</tbody></table>
      </div>`;
    }).join('');

    box.querySelectorAll('[data-buy-coin]').forEach((button) => {
      button.onclick = () => manualBuy(
        whales[Number(button.dataset.buyIndex)].address,
        button.dataset.buyCoin,
        button.dataset.buySide,
        button);
    });
    box.querySelectorAll('[data-follow]').forEach((button) => {
      button.onclick = () => {
        $('#atTarget').value = button.dataset.follow;
        setTarget(button.dataset.follow);
        button.textContent = 'Цель закреплена';
      };
    });
  }

  async function manualAnalyze() {
    const button = $('#manAnalyze');
    const status = $('#manStatus');
    button.disabled = true;
    status.textContent = 'Ищу адреса по встроенной логике, это может занять до минуты...';
    $('#manResults').innerHTML = '<div class="empty">Анализ выполняется...</div>';
    try {
      const params = new URLSearchParams({
        coin: ($('#manCoin').value || 'ALL').trim().toUpperCase() || 'ALL',
        minUsd: $('#manMinUsd').value || '500',
        minPnl: $('#manMinPnl').value || '0',
        minAgeDays: $('#manMinAge').value || '120',
        maxAccounts: $('#manMaxAccounts').value || '20',
        requirePositiveWinRate: $('#manWinRate').checked ? '1' : '0',
        requireLastTradeToday: $('#manToday').checked ? '1' : '0',
      });
      const data = await api('/api/hyperliquid/12h-whales?' + params);
      status.textContent = `Кандидатов: ${data.candidate_count} · проверено: ${data.valid_count} · прошло фильтры: ${data.qualified_count}${data.cached ? ' · из кэша' : ''}`;
      renderCandidates(data.whales || []);
    } catch (error) {
      status.textContent = 'Анализ недоступен: ' + error.message;
      $('#manResults').innerHTML = '<div class="empty">Ошибка анализа.</div>';
    } finally { button.disabled = false; }
  }

  async function manualBuy(address, coin, side, button) {
    const settings = state.settings || {};
    const raw = window.prompt(
      `Сумма покупки в USD для ${coin} (${side}).\n` +
      `Биржа: ${settings.venue} · режим: ${settings.mode} · плечо ${settings.leverage}x · ` +
      `${settings.order_type === 'limit' ? 'лимитный ордер' : 'рыночный ордер'}`,
      String(settings.order_usd || 100));
    if (raw == null) return;
    const usd = Number(raw);
    if (!Number.isFinite(usd) || usd <= 0) { window.alert('Некорректная сумма'); return; }
    if (settings.mode === 'live' && !window.confirm(
      `LIVE: реальный ордер ${side} ${coin} на $${usd}. Продолжить?`)) return;
    button.disabled = true;
    const original = button.textContent;
    button.textContent = 'Отправляю...';
    try {
      const data = await api('/api/autotrade/buy', jsonPost({ address, coin, usd, side }));
      const order = data.order || {};
      button.textContent = order.dry_run ? 'dry-run записан' : 'Ордер отправлен';
      button.classList.add('saved');
      window.alert(
        `${order.dry_run ? 'DRY-RUN (ордер не отправлен)' : 'Ордер отправлен'}\n` +
        `${order.side} ${order.coin} · ${fmt(order.qty, 6)} по ${fmt(order.price, 6)}\n` +
        `Объём: ${money(order.usd)} · плечо ${order.leverage}x · ${order.venue}\n` +
        `ID: ${order.order_id || '—'}${order.warning ? '\n\n' + order.warning : ''}`);
      refreshLog();
    } catch (error) {
      button.disabled = false;
      button.textContent = original;
      window.alert('Ошибка ордера: ' + error.message);
    }
  }

  /* ------------------------------------------------------------- start */

  function start() {
    injectView();
    if (!$('#autoTrade')) return;
    $('#atStart').onclick = startAuto;
    $('#atStop').onclick = stopAuto;
    $('#atSetTarget').onclick = () => setTarget($('#atTarget').value.trim());
    $('#atClearTarget').onclick = () => { $('#atTarget').value = ''; setTarget(null); };
    $('#atSaveSettings').onclick = saveSettings;
    $('#manAnalyze').onclick = manualAnalyze;
    $('#atRefreshLog').onclick = refreshLog;
    $('#atCloseAll').onclick = closeAll;
    $('#atOnlySaved').onchange = toggleSavedOnly;
    loadSettings().then(refreshStatus).then(refreshLog);
    state.timer = setInterval(() => {
      if ($('#autoTrade').classList.contains('active')) { refreshStatus(); refreshLog(); }
    }, 5000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
}());
