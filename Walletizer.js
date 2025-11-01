// ==UserScript==
// @name         Walletizer
// @author       VIVA IT Group
// @version      1.1 Auto refresh countdown & filters
// @description  Balance colorized bar with auto refresh
// @match        https://www.arbitterminal.online/
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function(){
  const DETAILS_SELECTOR = 'details.exchange-discaimer-box';
  const TBODY_SELECTOR = `${DETAILS_SELECTOR} .table.table-pnl-history tbody`;
  const REFRESH_BTN_SELECTOR = `${DETAILS_SELECTOR} .refresh-btn`;
  const BAR_ID = 'wallets-bottom-bar';
  const CARD_GROUP_SELECTOR = '.trade-cards-group';

  const DONATION_ADDRESS_BEP20 = '0x3cd9bbd23798e87fab63c32262e4a910892effe2';
  const DEFAULT_THRESHOLDS = { minBalance: 900, minPNL: -250 };

  let stored = JSON.parse(localStorage.getItem('thresholdsPanelData')) || {};
  let thresholds = stored.thresholds || {
    MEXC: {...DEFAULT_THRESHOLDS},
    BYBIT: {...DEFAULT_THRESHOLDS},
    BINGX: {...DEFAULT_THRESHOLDS},
    GATEIO: {...DEFAULT_THRESHOLDS},
    BITGET: { minBalance: 850, minPNL: -200 },
  };
  let refreshInterval = stored.refreshInterval || 15;
  let countdown = refreshInterval;

  let blinkingState = {};
  let currentFilters = new Set();
  let cardLimitsData = {};

  (function injectStyles(){
    if (document.getElementById(BAR_ID+'-style')) return;
    const st = document.createElement('style');
    st.id = BAR_ID+'-style';
    st.textContent = `
      #${BAR_ID} {
        position: fixed; left: 0; right: 0; bottom: 0;
        z-index: 9999;
        background: rgba(240, 240, 240, 0.95);
        color: #1a1a1a;
        border-top: 1px solid rgba(0, 0, 80, 0.3);
        padding: 6px 12px;
        display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
        font: 500 16px/1.5 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        white-space: nowrap; overflow-x: auto; scrollbar-width: thin;
        box-shadow: 0 0 8px rgba(0, 0, 80, 0.15);
        height: 42px;
        user-select: none;
      }
      #${BAR_ID} .item {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 2px 10px;
        border-radius: 6px;
        background: rgba(255, 255, 255, 0.9);
        border: 2px solid #2563eb;
        color: #1a1a1a;
        font-weight: 600;
        cursor: pointer;
        user-select: none;
        transition: background-color 0.3s, color 0.3s;
        min-width: 110px;
        justify-content: space-between;
        font-variant-numeric: tabular-nums;
      }
      #${BAR_ID} .item.active {
        background-color: #2563eb;
        color: white;
      }
      #${BAR_ID} .exch {
        text-transform: uppercase;
        flex-grow: 1;
        white-space: nowrap;
      }
      #${BAR_ID} .count-limits {
        font-weight: 600;
        font-size: 16px;
        white-space: nowrap;
        user-select: none;
      }
      #${BAR_ID} .count-limits.overlimit {
        color: #dc2626;
        font-weight: 700;
      }
      #${BAR_ID} .balance, #${BAR_ID} .pnl {
        opacity: 0.95;
        font-weight: 500;
        cursor: default;
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
      }
      #${BAR_ID} .balance.low-balance { color: #dc2626; font-weight: 700;}
      #${BAR_ID} .balance.sufficient-balance { color: #16a34a; font-weight: 700;}
      #${BAR_ID} .pnl.positive { color: #16a34a; }
      #${BAR_ID} .pnl.negative { color: #dc2626; }
      #${BAR_ID} .pnl.invalid { color: gray; font-style: italic; }
      #${BAR_ID} .pnl.blinking {
        animation: blink-red 1.2s infinite;
        font-weight: 700;
      }
      @keyframes blink-red {
        0%,50%,100% { color: #dc2626; opacity: 1; }
        25%,75% { color: transparent; opacity: 0.5; }
      }
      #${BAR_ID} .refresh-bar-btn {
        margin-left: auto;
        padding: 4px 14px;
        border: none;
        background-color: transparent;
        color: #1a1a1a;
        cursor: pointer;
        font-weight: 600;
        font-size: 16px;
        user-select: none;
        transition: color 0.25s ease-in-out;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      #${BAR_ID} .refresh-bar-btn:hover {
        color: #2563eb;
      }
      #${BAR_ID} .refresh-bar-btn .seconds {
        font-variant-numeric: tabular-nums;
        font-weight: 500;
        border: 1px solid #ccc;
        padding: 0 6px;
        border-radius: 4px;
        background: #eee;
        user-select: none;
        min-width: 30px;
        text-align: center;
      }
      #${BAR_ID} .settings-toggle {
        margin-left: 10px;
        cursor: pointer;
        font-size: 20px;
        user-select: none;
        color: #2563eb;
        transition: color 0.3s;
      }
      #${BAR_ID} .settings-toggle:hover {
        color: #1e40af;
      }
      #${BAR_ID}-settings-panel {
        position: fixed;
        bottom: 48px;
        right: 12px;
        background: #f9fafb;
        border: 1.8px solid #3b82f6;
        border-radius: 12px;
        padding: 15px;
        box-shadow: 0 4px 12px rgba(59,130,246,0.25);
        width: 380px;
        z-index: 10000;
        display: none;
        flex-direction: column;
        gap: 14px;
        font-size: 14px;
        user-select: text;
      }
      #${BAR_ID}-settings-panel.visible {
        display: flex;
      }
      #${BAR_ID}-settings-panel .threshold-container {
        display: flex;
        flex-wrap: wrap;
        gap: 12px 10px;
      }
      #${BAR_ID}-settings-panel .threshold-block {
        border: 1px solid #2563eb;
        border-radius: 8px;
        padding: 10px 12px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        box-sizing: border-box;
        flex: 1 1 45%;
        min-width: 150px;
      }
      #${BAR_ID}-settings-panel .threshold-block label {
        font-weight: 700;
        margin-bottom: 6px;
        user-select: none;
        color: #1e40af;
      }
      #${BAR_ID}-settings-panel .threshold-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      #${BAR_ID}-settings-panel .threshold-row label {
        min-width: 55px;
        user-select: none;
        font-weight: 600;
      }
      #${BAR_ID}-settings-panel .threshold-row input {
        width: 60px;
        padding: 4px 6px;
        font-weight: 600;
        border-radius: 6px;
        border: 1px solid #cbd5e1;
        font-size: 14px;
        box-sizing: border-box;
      }
      #${BAR_ID}-settings-panel .bottom-row {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 12px;
        margin-top: 10px;
      }
      #${BAR_ID}-settings-panel button.close-btn, #donate-bep20-btn {
        padding: 8px 15px;
        border-radius: 4px;
        cursor: pointer;
        font-weight: bold;
        font-size: 14px;
        transition: background-color 0.2s;
        user-select: none;
        border: none;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 5px;
        min-width: 130px;
      }
      #${BAR_ID}-settings-panel button.close-btn {
        background-color: #2563eb;
        color: white;
      }
      #${BAR_ID}-settings-panel button.close-btn:hover {
        background-color: #1e40af;
      }
      #donate-bep20-btn {
        background-color: #f0b90b;
        color: #1e2329;
      }
      #donate-bep20-btn:hover {
        background-color: #d3a90a;
      }
    `;
    document.head.appendChild(st);
  })();

  function updateCardLimitsData() {
    cardLimitsData = {};
    document.querySelectorAll('span.bots-limit-info').forEach(el => {
      const txt = el.textContent || '';
      let parts = txt.split(':');
      if (parts.length < 2) return;
      let exch = parts[0].trim().toUpperCase();
      let counts = parts[1].trim();
      let countsMatch = counts.match(/(\d+)\/(\d+)/);
      if (!countsMatch) return;
      cardLimitsData[exch] = {used: Number(countsMatch[1]), limit: Number(countsMatch[2])};
    });
  }

  function parseWalletRows() {
    const tbody = document.querySelector(TBODY_SELECTOR);
    if (!tbody) return [];
    return Array.from(tbody.querySelectorAll('tr')).map(tr => {
      const tds = tr.querySelectorAll('td');
      if (tds.length < 3) return null;
      const exch = (tds[0].textContent || '').trim().toUpperCase();
      const balanceRaw = (tds[1].textContent || '').trim();
      const pnlRaw = (tds[2].textContent || '').trim();
      const balanceNum = parseFloat(balanceRaw.replace(/[^\d.-]/g, '')) || 0;
      const pnlNum = parseFloat(pnlRaw.replace(/[^\d.-]/g, ''));
      return { exch, balanceRaw, balanceNum, pnlRaw, pnlNum: isNaN(pnlNum) ? null : pnlNum };
    }).filter(Boolean);
  }

  function ensureBar() {
    let bar = document.getElementById(BAR_ID);
    if (!bar) {
      bar = document.createElement('div'); bar.id = BAR_ID; document.body.appendChild(bar);
    }
    return bar;
  }

  function cardHasExchange(card, exch) {
    if (!exch) return true;
    exch = exch.toUpperCase();
    let found = false;
    card.querySelectorAll('.arbitrage-info span').forEach(span => {
      const raw = (span.childNodes[0]?.nodeValue || '').trim().toUpperCase();
      if (raw === exch) found = true;
    });
    return found;
  }

  function applyFilter() {
    const group = document.querySelector(CARD_GROUP_SELECTOR);
    if (!group) return;
    const filters = [...currentFilters];
    group.querySelectorAll('.trade-card').forEach(card => {
      if (filters.length === 0) {
        card.dataset.hiddenByFilter = '0';
        card.style.removeProperty('display');
        return;
      }
      const show = filters.some(exch => cardHasExchange(card, exch));
      card.dataset.hiddenByFilter = show ? '0' : '1';
      card.style.display = show ? '' : 'none';
    });
    const bar = ensureBar();
    bar.querySelectorAll('.item.exch').forEach(el => {
      el.classList.toggle('active', currentFilters.has(el.dataset.exch));
    });
  }

  function saveThresholds() {
    localStorage.setItem('thresholdsPanelData', JSON.stringify({thresholds, refreshInterval}));
  }

  function formatSeconds(s) {
    return s < 10 ? '0'+s : s.toString();
  }

  function renderBar() {
    updateCardLimitsData();
    const data = parseWalletRows();
    const bar = ensureBar();

    bar.innerHTML = '';

    if (!data.length) {
      bar.textContent = 'Wallets: no data';
      return;
    }

    data.forEach(({exch,balanceRaw,balanceNum,pnlRaw,pnlNum}) => {
      if (bar.querySelector(`.item.exch[data-exch="${exch}"]`)) return;

      const item = document.createElement('div');
      item.className = 'item exch';
      item.dataset.exch = exch;
      if (currentFilters.has(exch)) item.classList.add('active');

      const elExch = document.createElement('span');
      elExch.className = 'exch';
      elExch.textContent = exch;

      const counts = cardLimitsData[exch];
      const elCount = document.createElement('span');
      elCount.className = 'count-limits';
      if (counts) {
        elCount.textContent = `${counts.used}/${counts.limit}`;
        if (counts.used >= counts.limit) elCount.classList.add('overlimit');
      } else {
        elCount.textContent = '';
      }

      const thresh = thresholds[exch] || DEFAULT_THRESHOLDS;

      const elBal = document.createElement('span');
      elBal.className = 'balance';
      elBal.textContent = `: ${balanceRaw}`;
      if (balanceNum >= thresh.minBalance) elBal.classList.add('sufficient-balance');
      else elBal.classList.add('low-balance');

      const elPnl = document.createElement('span');
      elPnl.className = 'pnl';
      elPnl.textContent = `PNL: ${pnlRaw}`;
      if (pnlNum === null) elPnl.classList.add('invalid');
      else if (pnlNum < thresh.minPNL) {
        elPnl.classList.remove('positive','negative','invalid');
        elPnl.classList.add('blinking');
        blinkingState[exch] = true;
      } else {
        elPnl.classList.remove('blinking','invalid');
        blinkingState[exch] = false;
        if (pnlNum > 0) elPnl.classList.add('positive');
        else if (pnlNum < 0) elPnl.classList.add('negative');
      }

      item.appendChild(elExch);
      item.appendChild(elCount);
      item.appendChild(elBal);
      item.appendChild(elPnl);

      // Натискання для фільтру
      item.onclick = () => {
        if (currentFilters.has(exch)) currentFilters.delete(exch);
        else currentFilters.add(exch);
        applyFilter();
        renderBar();
      };

      bar.appendChild(item);
    });

    // Кнопка налаштувань
    let settingsToggle = bar.querySelector('.settings-toggle');
    if (!settingsToggle) {
      settingsToggle = document.createElement('span');
      settingsToggle.className = 'settings-toggle';
      settingsToggle.title = 'Налаштування порогів і інтервалу оновлення';
      settingsToggle.textContent = '⚙️';
      bar.appendChild(settingsToggle);
    }
    settingsToggle.onclick = () => {
      const settingsPanel = document.getElementById(BAR_ID + '-settings-panel');
      if (settingsPanel) settingsPanel.classList.toggle('visible');
    };

    // Кнопка Refresh
    let refreshBtn = bar.querySelector('.refresh-bar-btn');
    if (!refreshBtn) {
      refreshBtn = document.createElement('button');
      refreshBtn.className = 'refresh-bar-btn';
      refreshBtn.title = 'Оновити баланси';

      const refreshText = document.createElement('span');
      refreshText.textContent = 'Refresh';
      refreshBtn.appendChild(refreshText);

      const refreshSeconds = document.createElement('span');
      refreshSeconds.className = 'seconds';
      refreshBtn.appendChild(refreshSeconds);

      bar.appendChild(refreshBtn);

      refreshBtn.addEventListener('click', () => {
        countdown = refreshInterval;
        document.querySelector(REFRESH_BTN_SELECTOR)?.click();
        updateRefreshButtonText();
      });
    }
    const refreshSecondsSpan = refreshBtn.querySelector('.seconds');
    if (refreshSecondsSpan) refreshSecondsSpan.textContent = `[${formatSeconds(countdown)}s]`;

    // Панель налаштувань
    let settingsPanel = document.getElementById(BAR_ID + '-settings-panel');
    if (!settingsPanel) {
      settingsPanel = document.createElement('div');
      settingsPanel.id = BAR_ID + '-settings-panel';
      bar.parentElement.appendChild(settingsPanel);
    }

    let activeInput = null;
    if(settingsPanel.querySelector('input:focus')){
      activeInput = settingsPanel.querySelector('input:focus');
      activeInput = {name:activeInput.name||null,value:activeInput.value};
    }

    settingsPanel.innerHTML = '';

    const thresholdContainer = document.createElement('div');
    thresholdContainer.className = 'threshold-container';

    const exchNames = Object.keys(thresholds);
    exchNames.forEach((exch, idx) => {
      const block = document.createElement('div');
      block.className = 'threshold-block';

      if (idx === exchNames.length - 1) {
        block.style.flex = '1 1 40%'; // Залишити ширину для біржі
      } else {
        block.style.flex = '1 1 45%';
      }

      const label = document.createElement('label');
      label.textContent = exch;
      block.appendChild(label);

      const rowDeposit = document.createElement('div');
      rowDeposit.className = 'threshold-row';
      const labelDeposit = document.createElement('label');
      labelDeposit.textContent = 'Deposit';
      const inputBal = document.createElement('input');
      inputBal.type = 'number';
      inputBal.min = '0';
      inputBal.value = thresholds[exch].minBalance;
      inputBal.title = `Min Balance для ${exch}`;
      inputBal.name = exch + '_balance';
      inputBal.style.marginBottom = '0';

      rowDeposit.appendChild(labelDeposit);
      rowDeposit.appendChild(inputBal);

      const rowPNL = document.createElement('div');
      rowPNL.className = 'threshold-row';
      const labelPNL = document.createElement('label');
      labelPNL.textContent = 'PNL';
      const inputPNL = document.createElement('input');
      inputPNL.type = 'number';
      inputPNL.step = 'any';
      inputPNL.value = thresholds[exch].minPNL;
      inputPNL.title = `Min PNL для ${exch}`;
      inputPNL.name = exch + '_pnl';
      inputPNL.style.marginBottom = '0';

      rowPNL.appendChild(labelPNL);
      rowPNL.appendChild(inputPNL);

      block.appendChild(rowDeposit);
      block.appendChild(rowPNL);

      thresholdContainer.appendChild(block);

      inputBal.addEventListener('change', () => {
        thresholds[exch].minBalance = Number(inputBal.value);
        saveThresholds();
        renderBar();
        applyFilter();
      });
      inputPNL.addEventListener('change', () => {
        thresholds[exch].minPNL = Number(inputPNL.value);
        saveThresholds();
        renderBar();
        applyFilter();
      });
    });

    // Окремий блок Refresh інтервалу зі своєю рамкою та відступом, наступний до останньої біржі
    const refreshBlock = document.createElement('div');
    refreshBlock.className = 'threshold-block';
    refreshBlock.style.flex = '1 1 45%';

    const refreshLabel = document.createElement('label');
    refreshLabel.textContent = 'Refresh (сек)';
    refreshBlock.appendChild(refreshLabel);

    const refreshInput = document.createElement('input');
    refreshInput.type = 'number';
    refreshInput.min = '1';
    refreshInput.value = refreshInterval;
    refreshInput.name = 'refresh_interval';
    refreshInput.style.marginBottom = '0';
    refreshInput.style.width = '60px';

    refreshInput.addEventListener('change', () => {
      let val = Number(refreshInput.value);
      if (val < 1) val = 1;
      refreshInput.value = val;
      refreshInterval = val;
      countdown = val;
      saveThresholds();
      updateRefreshButtonText();
    });

    refreshBlock.appendChild(refreshInput);

    thresholdContainer.appendChild(refreshBlock);

    settingsPanel.appendChild(thresholdContainer);

    // Контейнер для донату та кнопки закриття
    const donateCloseContainer = document.createElement('div');
    donateCloseContainer.className = 'bottom-row';

    const donateBtn = document.createElement('button');
    donateBtn.id = 'donate-bep20-btn';
    donateBtn.type = 'button';
    donateBtn.innerHTML = '<span style="font-size: 1.2em;">🟡</span> Донат (BEP20)';
    donateBtn.title = 'Копіювати адресу донату у буфер';

    donateBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(DONATION_ADDRESS_BEP20).then(() => {
        alert('Адреса донату скопійована!');
      }).catch(() => {
        alert('Не вдалося скопіювати адресу донату.');
      });
    });

    const closeBtn = document.createElement('button');
    closeBtn.className = 'close-btn';
    closeBtn.textContent = 'Закрити';
    closeBtn.style.padding = '6px 12px';
    closeBtn.style.cursor = 'pointer';
    closeBtn.style.backgroundColor = '#2563eb';
    closeBtn.style.color = 'white';
    closeBtn.style.border = 'none';
    closeBtn.style.borderRadius = '6px';
    closeBtn.style.fontSize = '14px';

    closeBtn.addEventListener('click', () => {
      settingsPanel.classList.remove('visible');
    });

    donateCloseContainer.appendChild(donateBtn);
    donateCloseContainer.appendChild(closeBtn);
    settingsPanel.appendChild(donateCloseContainer);

    if (activeInput) {
      const restoredInput = settingsPanel.querySelector(`input[name="${activeInput.name}"]`);
      if (restoredInput) restoredInput.focus();
    }
  }

  function refreshBalances() {
    document.querySelector(REFRESH_BTN_SELECTOR)?.click();
    setTimeout(() => {
      renderBar();
      applyFilter();
    }, 1000);
  }

  function updateRefreshButtonText() {
    const btn = document.querySelector(`#${BAR_ID} .refresh-bar-btn .seconds`);
    if (btn) btn.textContent = `[${countdown < 10 ? '0' + countdown : countdown}s]`;
  }

  setInterval(() => {
    countdown--;
    if (countdown <= 0) {
      countdown = refreshInterval;
      refreshBalances();
    }
    updateRefreshButtonText();
  }, 1000);

  const init = () => {
    renderBar();
    applyFilter();
  };

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', init);
  else init();

  const tbody = document.querySelector(TBODY_SELECTOR);
  if (tbody) {
    const mo = new MutationObserver(() => {
      renderBar();
      applyFilter();
    });
    mo.observe(tbody, { childList: true, subtree: true, characterData: true });
  }

  document.querySelector(DETAILS_SELECTOR)
    ?.addEventListener('toggle', () => {
      setTimeout(() => {
        renderBar();
        applyFilter();
      }, 50);
    });
})();
