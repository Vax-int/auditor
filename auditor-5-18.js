// ==UserScript==
// @name         Arbitrage Terminal PNL Analyzer (Grouping by Close Time & Volume Zeroing - v5.18-BINANCE-FIX)
// @author       VIVA IT Group
// @version      5.18-BINANCE-FIX
// @description  ФІКС: Враховано специфіку статистики по Binance
// @match        https://www.arbitterminal.online/history*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    // ---------------------- КОНСТАНТИ ----------------------
    const TRADE_HISTORY_TABLE_SELECTOR = 'table.table-pnl-history';
    const TOTAL_PNL_SELECTOR = 'div.total-pnl > span.profit, div.total-pnl > span.loss'; 
    const TOTAL_PNL_CONTAINER_SELECTOR = 'div.total-pnl'; 
    const DETAIL_CHECKBOX_SELECTOR = 'input[type="checkbox"]'; 
    
    // ID контейнерів для нового макету
    const RESULT_CONTAINER_ID = 'pnl-analysis-report-container';
    const TABLES_WRAPPER_ID = 'original-tables-wrapper'; 
    const CONTROLS_WRAPPER_ID = 'pnl-controls-summary-wrapper'; 
    const RESULTS_WRAPPER_ID = 'pnl-results-flex-wrapper'; 
    
    // Коректний батьківський елемент для всього контенту
    const CONTENT_PARENT_SELECTOR = '#root > div:last-child'; 

    const MATCH_TIME_TOLERANCE_MS = 15000; 
    const VOLUME_ZERO_TOLERANCE = 1e-6; 
    const ANALYSIS_START_DELAY_MS = 1000; 
    
    const PNL_MATCH_TOLERANCE = 1e-4; 
    
    // --- КОНСТАНТИ RETRY ---
    const MAX_RETRY_ATTEMPTS = 5; 
    const RETRY_DELAY_MS = 2000; 
    
    const UNFINISHED_TIME_LIMIT_MS = 24 * 60 * 60 * 1000; 
    const DEFAULT_SORT_CRITERIA = 'position_time_desc'; 
    const TOKEN_ICON_SYMBOL = '💰'; 
    
    // --- КОНСТАНТИ ЧАСОВОГО ПОЯСУ ---
    const TIME_ZONE_KEY = 'pnl_analysis_time_zone';
    const TIME_ZONE_UTC = 'UTC';
    const TIME_ZONE_KYIV = 'Kyiv'; 
    
    // --- КОНСТАНТИ ДОНАТУ ---
    const DONATION_ADDRESS_BEP20 = '0x3cd9bbd23798e87fab63c32262e4a910892effe2';
    
    // --- ГЛОБАЛЬНІ ПРАПОРИ ТА СТАН ---
    let analysisStarted = false; 
    let isManipulatingDOM = false; 
    let globalFinalReport = null; 
    let globalTotalPnlReported = 0;
    let globalTotalPnlCalculated = 0;
    let isExportListenerAdded = false; 
    let globalCurrentSortCriteria = DEFAULT_SORT_CRITERIA; 
    let analysisAttemptCount = 0; 
    
    /** @type {Set<string>} */
    let globalExchanges = new Set();
    
    // --- ЗМІННА ДЛЯ ЗБЕРЕЖЕННЯ СТАНУ ЧЕКБОКСІВ ФІЛЬТРА БІРЖ ---
    const EXCHANGE_FILTER_STATE_KEY = 'pnl_exchange_filter_state';
    
    // ---------------------- ДОПОМІЖНІ ФУНКЦІЇ ----------------------

    function copyToClipboard(text) {
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(text).then(() => {
                alert(`✅ Адресу скопійовано: ${text}\nМережа: BEP20 (Binance Smart Chain)`);
            }).catch(err => {
                console.error('Could not copy text using modern API: ', err);
                fallbackCopy(text);
            });
        } else {
            fallbackCopy(text);
        }
    }
    
    function fallbackCopy(text) {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        try {
            document.execCommand('copy');
            alert(`✅ Адресу скопійовано: ${text}\nМережа: BEP20 (Binance Smart Chain)`);
        } catch (err) {
            console.error('Fallback: Could not copy text: ', err);
            alert(`❌ Не вдалося скопіювати. Скопіюйте вручну:\n${text}\nМережа: BEP20 (Binance Smart Chain)`);
        }
        document.body.removeChild(textarea);
    }
    
    function getCurrentTimeZone() {
        return localStorage.getItem(TIME_ZONE_KEY) || TIME_ZONE_UTC;
    }

    function saveTimeZone(timeZone) {
        localStorage.setItem(TIME_ZONE_KEY, timeZone);
    }

    function formatTime(dateObj, timeZone) {
        if (!dateObj || isNaN(dateObj.getTime())) return '';
        
        const options = {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: false,
            timeZone: (timeZone === TIME_ZONE_KYIV) ? 'Europe/Kyiv' : 'UTC'
        };
        
        try {
             const formatter = new Intl.DateTimeFormat('uk-UA', options);
             const parts = formatter.formatToParts(dateObj);
             
             const year = parts.find(p => p.type === 'year').value;
             const month = parts.find(p => p.type === 'month').value;
             const day = parts.find(p => p.type === 'day').value;
             const hour = parts.find(p => p.type === 'hour').value;
             const minute = parts.find(p => p.type === 'minute').value;
             const second = parts.find(p => p.type === 'second').value;
             
             return `${day}.${month}.${year} ${hour}:${minute}:${second} ${timeZone}`;
             
        } catch (e) {
            return dateObj.toISOString().replace('T', ' ').substring(0, 19) + ' UTC (Fallback)';
        }
    }

    function parseDate(textContent) {
        const utcMatch = textContent.match(/UTC: ([\d\.\s:]+)/);
        if (utcMatch) {
            const utcDateStr = utcMatch[1].trim();
            const parts = utcDateStr.split(/[\.\s:]/);
            return new Date(Date.UTC(parts[2], parts[1] - 1, parts[0], parts[3], parts[4], parts[5]));
        }
        return null;
    }

    function parsePNL(pnlCell) {
        const realizedPnlSpan = pnlCell.querySelector('.realized-pnl');
        if (!realizedPnlSpan) return { pnl: 0 };
        const pnlText = realizedPnlSpan.textContent.replace('Realized PNL: ', '').trim();
        const pnl = parseFloat(pnlText);
        return { pnl: pnl };
    }

    function parseReportedTotalPnl() {
         const totalPnlReportedEl = document.querySelector(TOTAL_PNL_SELECTOR);
         if (totalPnlReportedEl) {
             const pnlText = totalPnlReportedEl.textContent.trim();
             return parseFloat(pnlText);
         }
         return 0;
    }

    /**
     * Конвертує мілісекунди у читабельний формат "Xd Yh Zm As".
     */
    function formatDuration(ms) {
        if (ms < 0) return 'N/A';
        const seconds = Math.floor(ms / 1000);
        const days = Math.floor(seconds / (3600 * 24));
        const hours = Math.floor((seconds % (3600 * 24)) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;
        
        let parts = [];
        if (days > 0) parts.push(`${days}d`);
        if (hours > 0) parts.push(`${hours}h`);
        if (minutes > 0) parts.push(`${minutes}m`);
        if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);
        
        return parts.join(' ');
    }
    
    // ---------------------- ЛОГІКА ЗБЕРЕЖЕННЯ/ВІДНОВЛЕННЯ СТАНУ ----------------------
    
    function getOpenStates(container) {
        const states = { 
            tokenGroups: {}, 
            positions: {},
            isHistogramOpen: true // Default
        };
        
        if (!container) return states;

        container.querySelectorAll('.token-group-details').forEach((details) => {
            const key = details.getAttribute('data-symbol');
            if (key) {
                states.tokenGroups[key] = details.open;
            }
        });

        container.querySelectorAll('.position-details').forEach((details) => {
            const key = details.getAttribute('data-key'); 
            if (key) {
                states.positions[key] = details.open;
            }
        });
        
        // *** ЗБЕРЕЖЕННЯ СТАНУ ГІСТОГРАМИ ***
        const histogramDetails = document.querySelector('#pnl-histogram-container details');
        if (histogramDetails) {
            states.isHistogramOpen = histogramDetails.open;
        }

        return states;
    }
    
    function restoreOpenStates(container, openStates) {
        let stateRestored = false;
        
        container.querySelectorAll('.token-group-details').forEach((details) => {
            const key = details.getAttribute('data-symbol');
            if (openStates.tokenGroups[key] === true) {
                details.open = true;
                stateRestored = true;
            } else if (openStates.tokenGroups[key] === false) { 
                 details.open = false; 
                 stateRestored = true;
            }
        });

        container.querySelectorAll('.position-details').forEach((details) => {
            const key = details.getAttribute('data-key');
            if (openStates.positions[key] === true) {
                details.open = true;
                stateRestored = true;
                
                const parentTokenGroup = details.closest('.token-group-details');
                if (parentTokenGroup) { 
                    parentTokenGroup.open = true; 
                }
                
            } else if (openStates.positions[key] === false) {
                 details.open = false;
                 stateRestored = true;
            }
        });
        
        // *** ВІДНОВЛЕННЯ СТАНУ ГІСТОГРАМИ ***
        const histogramDetails = document.querySelector('#pnl-histogram-container details');
        if (histogramDetails && openStates.isHistogramOpen !== undefined) {
            histogramDetails.open = openStates.isHistogramOpen;
        }
        
        return stateRestored;
    }
    
    /**
     * Зберігає стан чекбоксів фільтра бірж у LocalStorage.
     */
    function saveExchangeFilterState() {
        const state = {};
        document.querySelectorAll('#pnl-exchange-filter-checkboxes input[type="checkbox"]').forEach(checkbox => {
            state[checkbox.value] = checkbox.checked;
        });
        localStorage.setItem(EXCHANGE_FILTER_STATE_KEY, JSON.stringify(state));
    }

    /**
     * Завантажує стан чекбоксів фільтра бірж з LocalStorage.
     */
    function loadExchangeFilterState() {
        try {
            const state = localStorage.getItem(EXCHANGE_FILTER_STATE_KEY);
            return state ? JSON.parse(state) : {};
        } catch (e) {
            console.error("Failed to load exchange filter state:", e);
            return {};
        }
    }
    
    // ---------------------- ЛОГІКА ПАРСИНГУ ТА АГРЕГАЦІЇ ----------------------
    
    function parsePnlHistory() {
        const tables = document.querySelectorAll(TRADE_HISTORY_TABLE_SELECTOR);
        const rawTrades = [];
        const exchangeTotals = {};
        
        globalExchanges.clear();

        tables.forEach(table => {
            const header = table.querySelector('thead tr th[colspan="7"]');
            if (!header) return;

            const exchangeMatch = header.textContent.trim().match(/^([^\s]+)\s+/);
            const currentExchangeName = exchangeMatch ? exchangeMatch[1].toUpperCase() : 'UNKNOWN EXCHANGE';
            const pnlMatch = header.textContent.match(/(\-?\d+\.\d+)/);
            const reportedPNL = pnlMatch ? parseFloat(pnlMatch[0]) : 0;
            
            globalExchanges.add(currentExchangeName);

            if (!exchangeTotals[currentExchangeName]) {
                exchangeTotals[currentExchangeName] = { calculatedPNL: 0, reportedPNL: reportedPNL, trades: [] };
            } else {
                exchangeTotals[currentExchangeName].reportedPNL = reportedPNL;
            }

            const rows = table.querySelectorAll('tbody tr');
            rows.forEach((row, index) => {
                 const cells = row.querySelectorAll('td');
                 if (cells.length < 6) return; 

                 const symbol = cells[0].textContent.trim();
                 const side = cells[1].textContent.trim();
                 const amount = parseFloat(cells[2].textContent.trim());
                 const { pnl: realizedPnl } = parsePNL(cells[3]);
                 
                 const openTimeUTC = parseDate(cells[4].textContent);
                 const closeTimeUTC = parseDate(cells[5].textContent);
                 const matchTimeKey = closeTimeUTC ? closeTimeUTC.getTime() : openTimeUTC.getTime();

                 const binanceFee = openTimeUTC && currentExchangeName === 'BINANCE' ? true : false

                 if (matchTimeKey === null) return;
                 
                 const amountReal = binanceFee ? 0 : amount

                 const trade = {
                     exchange: currentExchangeName, symbol: symbol, side: side, amount: amountReal, pnl: realizedPnl,
                     openTimeUTC: openTimeUTC, closeTimeUTC: closeTimeUTC, matchTimeKey: matchTimeKey, 
                     details: row.innerHTML, id: `${currentExchangeName}_${symbol}_${index}`
                 };

                 rawTrades.push(trade);
                 exchangeTotals[currentExchangeName].calculatedPNL += realizedPnl;
                 exchangeTotals[currentExchangeName].trades.push(trade);
            });
        });

        return { rawTrades, exchangeTotals };
    }
    
		/**
		 * Агрегує розрізнені ордери в цілісні арбітражні позиції.
		 * Використовує глобальні константи: MATCH_TIME_TOLERANCE_MS, VOLUME_ZERO_TOLERANCE, UNFINISHED_TIME_LIMIT_MS.
		 */

		function aggregateAndPairTrades(trades) {
		    // ЗАХИСТ: Якщо даних немає, повертаємо порожній об'єкт, як очікує скрипт
		    if (!trades || !Array.isArray(trades) || trades.length === 0) {
		        return {};
		    }
		
		    const tokenAggregates = {};
		    
		    // --- ЕТАП 1: ГРУПУВАННЯ ЗА СИМВОЛОМ ---
		    trades.forEach(trade => {
		        if (!tokenAggregates[trade.symbol]) {
		            tokenAggregates[trade.symbol] = { totalPNL: 0, trades: [] };
		        }
		        tokenAggregates[trade.symbol].totalPNL += trade.pnl || 0;
		        tokenAggregates[trade.symbol].trades.push(trade);
		    });
		
		    const finalReport = {};
		
		    for (const symbol in tokenAggregates) {
		        const tokenData = tokenAggregates[symbol];
		        // Сортуємо трейди за часом для коректної зшивки
		        const tokenTrades = [...tokenData.trades].sort((a, b) => a.matchTimeKey - b.matchTimeKey);
		        
		        const positionsPrimary = [];
		        const usedIndices = new Set();
		        
		        // --- ЕТАП 2: ПЕРВИННЕ ГРУПУВАННЯ (ЗА ЧАСОМ 15с) ---
		        for (let i = 0; i < tokenTrades.length; i++) {
		            if (usedIndices.has(i)) continue;
		            const currentTrade = tokenTrades[i];
		            
		            const isLong = currentTrade.side && currentTrade.side.toUpperCase().includes('LONG');
		            const amountVal = parseFloat(currentTrade.amount) || 0;
		            
		            const position = { 
		                trades: { [currentTrade.id]: currentTrade }, 
		                pnl: currentTrade.pnl || 0,
		                amount: amountVal * (isLong ? 1 : -1),
		                matchTimeKey: currentTrade.matchTimeKey, 
		                exchanges: new Set([currentTrade.exchange]),
		                symbol: currentTrade.symbol,
		                earliestOpenTimeKey: currentTrade.openTimeUTC ? currentTrade.openTimeUTC.getTime() : currentTrade.matchTimeKey,
		                totalLongAmount: isLong ? amountVal : 0,
		                totalShortAmount: !isLong ? amountVal : 0,
		                hasAttachedFees: false
		            }; 
		            usedIndices.add(i);
		            
		            for (let j = i + 1; j < tokenTrades.length; j++) {
		                if (usedIndices.has(j)) continue;
		                const nextTrade = tokenTrades[j];
		                const timeDiff = Math.abs(currentTrade.matchTimeKey - nextTrade.matchTimeKey); 
		                
		                if (timeDiff <= MATCH_TIME_TOLERANCE_MS) {
		                    const nextIsLong = nextTrade.side && nextTrade.side.toUpperCase().includes('LONG');
		                    const nextAmount = parseFloat(nextTrade.amount) || 0;
		                    
		                    position.trades[nextTrade.id] = nextTrade;
		                    position.pnl += (nextTrade.pnl || 0);
		                    position.amount += nextAmount * (nextIsLong ? 1 : -1);
		                    position.exchanges.add(nextTrade.exchange);
		                    usedIndices.add(j);
		                    
		                    if (nextTrade.openTimeUTC && nextTrade.openTimeUTC.getTime() < position.earliestOpenTimeKey) {
		                         position.earliestOpenTimeKey = nextTrade.openTimeUTC.getTime();
		                    }
		                    
		                    position.totalLongAmount += nextIsLong ? nextAmount : 0;
		                    position.totalShortAmount += !nextIsLong ? nextAmount : 0;
		                } else {
		                    break; 
		                }
		            }
		            positionsPrimary.push(position);
		        }
		        
		        // --- ЕТАП 3: ЗШИВКА (CHRONO-STITCHING) ТА ВИДІЛЕННЯ КОМІСІЙ ---
		        const finalPositions = [];
		        const ghostPositions = []; // Тут будуть фандинги/комісії (сумарний об'єм 0)
		
		        // Спочатку відокремлюємо "привиди" (комісії)
		        const realCandidatePositions = [];
		        positionsPrimary.forEach(p => {
		            const totalVol = p.totalLongAmount + p.totalShortAmount;
		            if (totalVol < VOLUME_ZERO_TOLERANCE) {
		                ghostPositions.push(p);
		            } else {
		                realCandidatePositions.push(p);
		            }
		        });
		
		        // Логіка зшивки для реальних позицій
		        let currentStitch = null; 
		        realCandidatePositions.forEach(nextPos => {
		            if (!currentStitch) {
		                currentStitch = nextPos;
		            } else {
		                const isVolumeNotZero = Math.abs(currentStitch.amount) > VOLUME_ZERO_TOLERANCE;
		                if (isVolumeNotZero) {
		                    Object.assign(currentStitch.trades, nextPos.trades);
		                    currentStitch.pnl += nextPos.pnl;
		                    currentStitch.amount += nextPos.amount;
		                    nextPos.exchanges.forEach(ex => currentStitch.exchanges.add(ex));
		                    currentStitch.totalLongAmount += nextPos.totalLongAmount;
		                    currentStitch.totalShortAmount += nextPos.totalShortAmount;
		                    if (nextPos.earliestOpenTimeKey < currentStitch.earliestOpenTimeKey) {
		                        currentStitch.earliestOpenTimeKey = nextPos.earliestOpenTimeKey;
		                    }
		                } else {
		                    finalPositions.push(currentStitch);
		                    currentStitch = nextPos;
		                }
		            }
		        });
		        if (currentStitch) finalPositions.push(currentStitch);
		
		        // --- ЕТАП 4: ПІДШИВКА КОМІСІЙ (GHOSTS) В СЕРЕДИНУ УГОД ---
		        const unattachedGhosts = [];
		        ghostPositions.forEach(ghost => {
		            let wasAttached = false;
		            const ghostTime = ghost.matchTimeKey;
		
		            for (let realPos of finalPositions) {
		                const latestTradeTime = Object.values(realPos.trades).reduce((max, t) => Math.max(max, t.matchTimeKey), 0);
										// ФІКС: додаємо зазор MATCH_TIME_TOLERANCE_MS з обох боків
		                const isInsideInterval = (
		                    ghostTime >= (realPos.earliestOpenTimeKey - MATCH_TIME_TOLERANCE_MS) && 
		                    ghostTime <= (latestTradeTime + MATCH_TIME_TOLERANCE_MS)
		                );
		
		                if ((realPos.symbol === ghost.symbol || ghost.symbol === 'ALL') && isInsideInterval) {
		                    Object.assign(realPos.trades, ghost.trades);
		                    realPos.pnl += ghost.pnl;
		                    realPos.hasAttachedFees = true;
		                    wasAttached = true;
		                    break;
		                }
		            }
		            if (!wasAttached) unattachedGhosts.push(ghost);
		        });
		
		        const allSymbolPositions = [...finalPositions, ...unattachedGhosts];
		
		        // --- ЕТАП 5: ФОРМУВАННЯ ПІДСУМКОВИХ ДАНИХ (PositionSummaries) ---
		        let totalProfit = 0;
		        let totalLoss = 0;
		        
		        const positionSummaries = allSymbolPositions.map(position => {
		            const tradesInPosition = Object.values(position.trades);
		            if (position.pnl > 0) totalProfit += position.pnl; else totalLoss += position.pnl;
		            
		            const latestMatchTimeKey = tradesInPosition.reduce((max, t) => Math.max(max, t.matchTimeKey), 0);
		            const holdingTimeMs = latestMatchTimeKey - position.earliestOpenTimeKey;
		            
		            // Визначення статусу
		            const isClosed = Math.abs(position.amount) < VOLUME_ZERO_TOLERANCE;
		            let finalStatus = isClosed ? "Closed (Matched)" : "Unfinished Position";
		            let borderColor = isClosed ? "green" : "orange";
		
		            if (!isClosed) {
		                const timeElapsed = Date.now() - latestMatchTimeKey;
		                if (timeElapsed > UNFINISHED_TIME_LIMIT_MS) {
		                    finalStatus = "Unbalanced";
		                    borderColor = "red";
		                }
		            }
		            if (position.hasAttachedFees) finalStatus += " (+Fees)";
		
		            // ПОВЕРТАЄМО ОБ'ЄКТ У ВАШОМУ ОРИГІНАЛЬНОМУ ФОРМАТІ
		            return {
		                symbol: position.symbol, 
		                openTimeKey: position.earliestOpenTimeKey, 
		                positionPNL: position.pnl, 
		                status: finalStatus,
		                exchangesInvolved: Array.from(position.exchanges).join(', '),
		                totalAmountDifference: position.amount, 
		                borderColor: borderColor, 
		                positionSortKey: latestMatchTimeKey, 
		                trades: tradesInPosition,
		                holdingTimeMs: holdingTimeMs,
		                totalLongAmount: position.totalLongAmount,
		                totalShortAmount: position.totalShortAmount
		            };
		        });
		
		        positionSummaries.sort((a, b) => b.positionSortKey - a.positionSortKey);
		
		        finalReport[symbol] = {
		            symbol: symbol,
		            totalPNL: tokenData.totalPNL,
		            positionSummaries: positionSummaries,
		            totalProfit: totalProfit,
		            totalLoss: totalLoss
		        };
		    }
		
		    return finalReport; // ПОВЕРТАЄМО ОБ'ЄКТ, ЯК І РАНІШЕ
		}

    // ---------------------- ФУНКЦІЇ КЕРУВАННЯ МАКЕТОМ ----------------------

    /**
     * Створює або оновлює (без перестворення) контрольний блок та структуру контейнерів.
     */
    function setupControlsAndContentLayout(totalPnlReported, totalPnlCalculated, sortBy) {
        
        const totalPnlContainer = document.querySelector(TOTAL_PNL_CONTAINER_SELECTOR);
        if (!totalPnlContainer) return { container: null };
        
        const contentParent = document.querySelector(CONTENT_PARENT_SELECTOR); 
        if (!contentParent) return { container: null };
        
        const totalPnlReportedEl = document.querySelector(TOTAL_PNL_SELECTOR);
        const totalPnlReportedText = totalPnlReportedEl ? totalPnlReportedEl.textContent.trim() : '0.000000';
        
        const currentTimeZone = getCurrentTimeZone();
        
        let controlsWrapper = document.getElementById(CONTROLS_WRAPPER_ID);
        let resultsWrapper = document.getElementById(RESULTS_WRAPPER_ID);
        let tablesWrapper, container;
        
        // --- ДИНАМІЧНА ГЕНЕРАЦІЯ ФІЛЬТРУ БІРЖ (ЧЕКБОКСИ) ---
        const exchangesArray = Array.from(globalExchanges).sort();
        const savedExchangeState = loadExchangeFilterState();
        
        const exchangeCheckboxesHtml = exchangesArray.map(ex => {
            const isChecked = savedExchangeState[ex] === true; // true, false, або undefined
            return `
                <label style="margin-right: 15px; white-space: nowrap;">
                    <input type="checkbox" name="exchange-filter-checkbox" value="${ex}" ${isChecked ? 'checked' : ''} data-exchange="${ex}"> ${ex}
                </label>
            `;
        }).join('');
        
        const isFilterActive = Object.values(savedExchangeState).some(state => state === true);

        if (!controlsWrapper) {
            
            controlsWrapper = document.createElement('div');
            controlsWrapper.id = CONTROLS_WRAPPER_ID;
            totalPnlContainer.parentNode.insertBefore(controlsWrapper, totalPnlContainer.nextSibling);

            let controlsHtml = `
                <div id="sort-controls" style="padding: 10px; background-color: #f9f9f9; border-radius: 5px; border: 1px solid #ddd; margin-bottom: 15px;">
                    <h4 style="margin-top: 0;">📈 Аналіз PNL (v5.18-BINANCE-FIX)</h4>
                    
                    <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 10px; margin-bottom: 10px;">
                        
                        <div style="display: flex; flex-direction: column; gap: 10px;">
                            
                            <div style="display: flex; align-items: center; flex-wrap: wrap; gap: 10px;">
                                <strong style="white-space: nowrap;">🛠️ Управління:</strong>
                                
                                <select id="pnl-sort-select" style="padding: 5px; min-width: 150px;">
                                    <optgroup label="Групування по Токену">
                                        <option value="pnl" ${sortBy === 'pnl' ? 'selected' : ''}>Сорт. по PNL</option>
                                        <option value="symbol" ${sortBy === 'symbol' ? 'selected' : ''}>Сорт. по Токену (А-Я)</option>
                                    </optgroup>
                                    <optgroup label="Хронологія Позицій (Без групування)">
                                        <option value="position_time_desc" ${sortBy === 'position_time_desc' ? 'selected' : ''}>Сорт. по Часу (Новіші позиції)</option>
                                        <option value="position_time_asc" ${sortBy === 'position_time_asc' ? 'selected' : ''}>Сорт. по Часу (Старіші позиції)</option>
                                    </optgroup>
                                </select>
                                
                                <div style="display: flex; gap: 5px; align-items: center;">
                                    <input type="text" id="pnl-filter-input" placeholder="Фільтр Токенів (наприклад, BTC)" style="padding: 5px; min-width: 150px;">
                                    <button id="clear-filter-btn" style="padding: 5px 10px; background-color: #dc3545; color: white; border: none; border-radius: 4px; cursor: pointer; white-space: nowrap;">
                                        Очистити
                                    </button>
                                </div>
                            </div>

                            <div style="display: flex; align-items: center; flex-wrap: wrap; gap: 20px;">
                                <label style="white-space: nowrap;">
                                    <input type="checkbox" id="expand-all-checkbox"> Розгорнути/Згорнути **все**
                                </label>
                                <label style="white-space: nowrap;">
                                    <input type="checkbox" id="expand-critical-checkbox"> Розгорнути **критичні** (<span style="color: red;">Unbalanced</span>/<span style="color: orange;">Unfinished</span>)
                                </label>
                                
                                <div id="timezone-controls" style="display: flex; align-items: center; gap: 10px; white-space: nowrap;">
                                    <strong style="margin-right: 5px;">⏰ Час:</strong>
                                    <label>
                                        <input type="radio" name="time-zone-radio" value="${TIME_ZONE_UTC}" ${currentTimeZone === TIME_ZONE_UTC ? 'checked' : ''}> UTC
                                    </label>
                                    <label>
                                        <input type="radio" name="time-zone-radio" value="${TIME_ZONE_KYIV}" ${currentTimeZone === TIME_ZONE_KYIV ? 'checked' : ''}> Kyiv
                                    </label>
                                </div>

                                <label style="white-space: nowrap; font-weight: bold;">
                                    <input type="checkbox" id="show-pnl-ratio-checkbox"> 📊 PNL Міні-графік
                                </label>
                            </div>
                            
                            <div style="display: flex; flex-direction: column; gap: 5px; margin-top: 10px; border: 1px solid #ccc; padding: 10px; border-radius: 4px; background-color: ${isFilterActive ? '#fffae0' : 'white'};">
                                <strong style="white-space: nowrap;">🗺️ Фільтр Бірж: <button id="clear-exchange-filter-btn" style="margin-left: 10px; padding: 3px 8px; background-color: #6c757d; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.8em; opacity: ${isFilterActive ? 1 : 0.5};" ${isFilterActive ? '' : 'disabled'}>Скинути</button></strong>
                                <div id="pnl-exchange-filter-checkboxes" style="display: flex; flex-wrap: wrap; gap: 5px 10px; max-height: 80px; overflow-y: auto;">
                                    ${exchangeCheckboxesHtml}
                                </div>
                                <small style="color: #666; margin-top: 5px; font-size: 0.8em;">* Позиція відображається, якщо вона містить **хоча б одну** вибрану біржу. Якщо не вибрано жодної, показуються всі.</small>
                            </div>
                            </div>
                        
                        <div style="display: flex; flex-direction: column; gap: 5px; min-width: 150px;">
                            <button id="export-to-xls-btn" style="padding: 8px 15px; background-color: #4CAF50; color: white; border: none; border-radius: 4px; cursor: pointer; white-space: nowrap; width: 100%;">
                                ⬇️ Експорт
                            </button>
                            <button id="donate-bep20-btn" style="padding: 8px 15px; background-color: #f0b90b; color: #1e2329; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; display: flex; align-items: center; justify-content: center; gap: 5px; width: 100%; transition: background-color 0.2s;">
                                <span style="font-size: 1.2em;">🟡</span> Донат (BEP20)
                            </button>
                        </div>
                    </div>
                    
                    <div class="total-pnl-summary-calculated" style="border-top: 1px solid #eee; padding-top: 10px; font-size: 0.9em; text-align: left; margin-top: 10px;">
                        </div>
                </div>
            `;
            controlsWrapper.innerHTML = controlsHtml;
            
            resultsWrapper = document.createElement('div');
            resultsWrapper.id = RESULTS_WRAPPER_ID;
            resultsWrapper.style.cssText = `
                display: flex; 
                flex-wrap: wrap; 
                justify-content: space-between;
                gap: 20px; 
                width: 100%;
                align-items: flex-start;
                margin-top: 15px; 
            `;
            
            // *** КОНТЕЙНЕР ДЛЯ ГІСТОГРАМИ ***
            let histogramContainer = document.createElement('div');
            histogramContainer.id = 'pnl-histogram-container';
            histogramContainer.style.flex = '1 1 100%'; 
            
            tablesWrapper = document.createElement('div');
            tablesWrapper.id = TABLES_WRAPPER_ID;
            tablesWrapper.style.flex = '1 1 45%'; 
            
            container = document.createElement('div');
            container.id = RESULT_CONTAINER_ID; 
            container.style.flex = '1 1 50%'; 
            container.style.cssText += ' min-height: 200px; padding: 10px; box-sizing: border-box; background-color: #e0f7fa; border-left: 2px solid #00bcd4; overflow: auto;';

            
            // Переміщення оригінальних таблиць
            const elementsToMove = [];
            let startCollecting = false; 

            Array.from(contentParent.children).forEach(child => {
                if (child === totalPnlContainer) {
                    startCollecting = true;
                    return;
                }
                
                if (startCollecting && child.nodeType === 1) { 
                    if (child.id !== CONTROLS_WRAPPER_ID && child.id !== RESULTS_WRAPPER_ID) {
                         if (child.classList.contains('disclaimer-box') || 
                            child.classList.contains('table-pnl-history') ||
                            child.matches('div') 
                         ) {
                              elementsToMove.push(child);
                         }
                    }
                }
            });
            
            // Вставляємо resultsWrapper після controlsWrapper
            contentParent.insertBefore(resultsWrapper, controlsWrapper.nextSibling); 
            
            resultsWrapper.appendChild(histogramContainer); // Додаємо гістограму першою
            resultsWrapper.appendChild(tablesWrapper); 
            resultsWrapper.appendChild(container); 
            
            elementsToMove.forEach(element => {
                tablesWrapper.appendChild(element); 
            });
            
            attachControlListeners(controlsWrapper);

        } else {
             tablesWrapper = document.getElementById(TABLES_WRAPPER_ID);
             container = document.getElementById(RESULT_CONTAINER_ID);
             
             // --- Оновлення стану радіо-кнопок при перерендерингу ---
             const utcRadio = document.querySelector(`input[name="time-zone-radio"][value="${TIME_ZONE_UTC}"]`);
             const kyivRadio = document.querySelector(`input[name="time-zone-radio"][value="${TIME_ZONE_KYIV}"]`);
             
             if (utcRadio) utcRadio.checked = (currentTimeZone === TIME_ZONE_UTC);
             if (kyivRadio) kyivRadio.checked = (currentTimeZone === TIME_ZONE_KYIV);
             
             // --- Оновлення чекбоксів фільтра бірж ---
             const exchangeCheckboxesContainer = document.getElementById('pnl-exchange-filter-checkboxes');
             if (exchangeCheckboxesContainer) {
                 exchangeCheckboxesContainer.innerHTML = exchangeCheckboxesHtml;
                 
                 // Оновлення стану кнопки "Скинути"
                 const clearExchangeBtn = document.getElementById('clear-exchange-filter-btn');
                 const filterBox = clearExchangeBtn.closest('div');
                 
                 if (clearExchangeBtn) {
                     if (isFilterActive) {
                         clearExchangeBtn.disabled = false;
                         clearExchangeBtn.style.opacity = 1;
                         filterBox.style.backgroundColor = '#fffae0';
                     } else {
                         clearExchangeBtn.disabled = true;
                         clearExchangeBtn.style.opacity = 0.5;
                         filterBox.style.backgroundColor = 'white';
                     }
                 }
             }
        }
        
        // --- ОНОВЛЕННЯ СТАТУСУ PNL ---
        const summaryDiv = controlsWrapper.querySelector('.total-pnl-summary-calculated');
        if (summaryDiv) {
            const pnlDiff = totalPnlCalculated - totalPnlReported;
            const pnlMatchStatus = Math.abs(pnlDiff) < PNL_MATCH_TOLERANCE ? 'Співпадає' : `Різниця: ${pnlDiff.toFixed(6)}`;
            const pnlStatusClass = Math.abs(pnlDiff) < PNL_MATCH_TOLERANCE ? 'profit' : 'loss';
            
            const totalPnlReportedTextUpdated = document.querySelector(TOTAL_PNL_SELECTOR)?.textContent.trim() || '0.000000';

            summaryDiv.innerHTML = `
                <strong>📊 Звірка Total PNL:</strong> (Звіт: <span class="pnl-value ${totalPnlReported >= 0 ? 'profit' : 'loss'}">${totalPnlReportedTextUpdated}</span>)
                | Розрахунок: <span class="pnl-value ${totalPnlCalculated >= 0 ? 'profit' : 'loss'}">${totalPnlCalculated.toFixed(6)}</span> 
                | Статус: <strong class="${pnlStatusClass}">${pnlMatchStatus}</strong>
                ${analysisAttemptCount > 0 ? `(Спроба: ${analysisAttemptCount}/${MAX_RETRY_ATTEMPTS})` : ''}
            `;
        }
        
        const sortSelect = document.getElementById('pnl-sort-select');
        if (sortSelect) {
            sortSelect.value = sortBy;
        }


        return { container, tablesWrapper, contentParent, controlsWrapper };
    }
    
    /**
     * Прикріплює обробники подій до контролів. Викликається лише один раз.
     */
    function attachControlListeners(controlsWrapper) {
         if (controlsWrapper.getAttribute('data-listeners-attached')) {
             // Переатачюємо обробники для нових чекбоксів бірж
             attachExchangeFilterListeners();
             return;
         }
         
         const expandAllCheckbox = document.getElementById('expand-all-checkbox');
         const expandCriticalCheckbox = document.getElementById('expand-critical-checkbox');
         const donateBtn = document.getElementById('donate-bep20-btn');

         const updateView = () => {
             const currentFilterText = document.getElementById('pnl-filter-input').value;
             const currentExpandCritical = expandCriticalCheckbox ? expandCriticalCheckbox.checked : false;
             
             filterAndRenderReport(currentFilterText, currentExpandCritical);
         };

         document.getElementById('pnl-sort-select')?.addEventListener('change', (e) => {
             globalCurrentSortCriteria = e.target.value; 
             updateView();
         });
         
         document.getElementById('pnl-filter-input')?.addEventListener('input', updateView);
         
         document.getElementById('clear-filter-btn')?.addEventListener('click', () => {
             const filterInput = document.getElementById('pnl-filter-input');
             if (filterInput) {
                 filterInput.value = '';
                 updateView();
             }
         });
         
         document.getElementById('show-pnl-ratio-checkbox')?.addEventListener('change', updateView);
         
         controlsWrapper.querySelectorAll('input[name="time-zone-radio"]').forEach(radio => {
             radio.addEventListener('change', (e) => {
                 saveTimeZone(e.target.value);
                 updateView(); 
             });
         });
         
         attachExchangeFilterListeners(updateView);

         expandCriticalCheckbox?.addEventListener('change', (e) => {
             const isChecked = e.target.checked;
             if (isChecked && expandAllCheckbox) {
                 expandAllCheckbox.checked = false; 
             }
             updateView();
         });
         
         expandAllCheckbox?.addEventListener('change', (e) => {
             const isChecked = e.target.checked;
             
             if (isChecked && expandCriticalCheckbox) {
                 expandCriticalCheckbox.checked = false;
             }
             
             document.querySelectorAll(`#${RESULT_CONTAINER_ID} details`).forEach(details => {
                 details.open = isChecked;
             });
             
             // Також застосовуємо до гістограми
             const histogramDetails = document.querySelector('#pnl-histogram-container details');
             if (histogramDetails) {
                 histogramDetails.open = isChecked;
             }
         });


         const exportBtn = document.getElementById('export-to-xls-btn');
         if (exportBtn && !isExportListenerAdded) {
             exportBtn.addEventListener('click', () => {
                  const selectedSort = document.getElementById('pnl-sort-select').value;
                  if (globalFinalReport) {
                       exportToCSV(globalFinalReport, selectedSort, globalTotalPnlReported, globalTotalPnlCalculated);
                  }
             });
             isExportListenerAdded = true; 
         }
         
         if (donateBtn) {
             donateBtn.addEventListener('click', () => {
                 copyToClipboard(DONATION_ADDRESS_BEP20);
             });
         }
         
         controlsWrapper.setAttribute('data-listeners-attached', 'true');
    }
    
    /**
     * Прикріплює обробники подій до чекбоксів фільтра бірж та кнопки "Скинути".
     */
    function attachExchangeFilterListeners(updateView = null) {
        const exchangeCheckboxesContainer = document.getElementById('pnl-exchange-filter-checkboxes');
        const clearExchangeBtn = document.getElementById('clear-exchange-filter-btn');

        if (!exchangeCheckboxesContainer) return;

        // *** ВИПРАВЛЕННЯ: ОГОЛОШЕННЯ ФУНКЦІЙ ПЕРЕД ЇХ ВИКОРИСТАННЯМ У removeEventListener ***
        
        const handleExchangeCheckboxChange = (e) => {
            if (e.target.matches('input[name="exchange-filter-checkbox"]')) {
                saveExchangeFilterState(); // Зберігаємо стан
                const isFilterActive = document.querySelectorAll('#pnl-exchange-filter-checkboxes input[type="checkbox"]:checked').length > 0;
                
                // Оновлення стану кнопки "Скинути" та контейнера
                if (clearExchangeBtn) {
                    const filterBox = clearExchangeBtn.closest('div');
                    clearExchangeBtn.disabled = !isFilterActive;
                    clearExchangeBtn.style.opacity = isFilterActive ? 1 : 0.5;
                    if (filterBox) filterBox.style.backgroundColor = isFilterActive ? '#fffae0' : 'white';
                }
                
                if (updateView) updateView();
            }
        };

        const handleClearExchangeFilter = () => {
            document.querySelectorAll('#pnl-exchange-filter-checkboxes input[type="checkbox"]').forEach(checkbox => {
                checkbox.checked = false;
            });
            saveExchangeFilterState();
            
            // Оновлення стану кнопки "Скинути" та контейнера
            if (clearExchangeBtn) {
                const filterBox = clearExchangeBtn.closest('div');
                clearExchangeBtn.disabled = true;
                clearExchangeBtn.style.opacity = 0.5;
                if (filterBox) filterBox.style.backgroundColor = 'white';
            }
            
            if (updateView) updateView();
        };
        // *** КІНЕЦЬ ВИПРАВЛЕННЯ ОГОЛОШЕННЯ ФУНКЦІЙ ***

        // Видалення старих обробників
        // Для коректного видалення необхідно, щоб обробник, який видаляється, був оголошений
        // як окрема змінна (що ми зробили вище).
        exchangeCheckboxesContainer.removeEventListener('change', handleExchangeCheckboxChange);
        clearExchangeBtn?.removeEventListener('click', handleClearExchangeFilter);


        // Додавання нових обробників
        exchangeCheckboxesContainer.addEventListener('change', handleExchangeCheckboxChange);
        clearExchangeBtn?.addEventListener('click', handleClearExchangeFilter);
    }
    
    /**
     * Генерує HTML для міні-графіка співвідношення прибутків/збитків.
     */
    function generatePnlRatioBarHtml(totalProfit, totalLoss) {
        const absLoss = Math.abs(totalLoss);
        const totalAbsolute = totalProfit + absLoss;
        
        if (totalAbsolute < VOLUME_ZERO_TOLERANCE) {
            return '';
        }
        
        const profitRatio = (totalProfit / totalAbsolute) * 100;
        const lossRatio = (absLoss / totalAbsolute) * 100;

        return `
            <div class="pnl-ratio-bar" 
                 title="Profit/Loss Ratio: ${profitRatio.toFixed(1)}% Profit / ${lossRatio.toFixed(1)}% Loss" 
                 style="width: 120px; height: 12px; background-color: #e0e0e0; margin-left: 15px; border-radius: 3px; overflow: hidden; display: flex; flex-shrink: 0;">
                <div style="width: ${profitRatio}%; background-color: #28a745; height: 100%;"></div>
                <div style="width: ${lossRatio}%; background-color: #dc3545; height: 100%;"></div>
            </div>
        `;
    }
    
    /**
     * Генерує HTML для міні-графіка співвідношення LONG/SHORT обсягів.
     */
    function generateVolumeRatioBarHtml(long, short) {
        const totalVolume = long + short;
        if (totalVolume < VOLUME_ZERO_TOLERANCE) {
            return '';
        }
        
        const longRatio = (long / totalVolume) * 100;
        const shortRatio = (short / totalVolume) * 100;

        return `
            <div class="volume-ratio-bar" 
                 title="Volume Ratio: ${long.toFixed(2)} LONG / ${short.toFixed(2)} SHORT" 
                 style="width: 80px; height: 10px; background-color: #e0e0e0; margin-left: 10px; border-radius: 3px; overflow: hidden; display: flex; flex-shrink: 0;">
                <div style="width: ${longRatio}%; background-color: #3399FF; height: 100%;" title="LONG Volume: ${long.toFixed(4)}"></div>
                <div style="width: ${shortRatio}%; background-color: #FF6633; height: 100%;" title="SHORT Volume: ${short.toFixed(4)}"></div>
            </div>
        `;
    }
    
    /**
     * Генерує HTML для гістограми PNL по токенах.
     * @param {Object} report Звіт PNL.
     * @param {boolean} isOpen Стан: розгорнута чи згорнута.
     */
    function renderPnlHistogram(report, isOpen = true) {
        const tokens = Object.values(report).sort((a, b) => b.totalPNL - a.totalPNL);
        if (tokens.length === 0) return '';

        const maxPnl = Math.max(...tokens.map(t => Math.abs(t.totalPNL)));
        if (maxPnl < VOLUME_ZERO_TOLERANCE) return '';
        
        const openAttribute = isOpen ? 'open' : '';

        let html = `
            <details ${openAttribute} style="margin-bottom: 15px; border: 1px solid #ddd; padding: 10px; border-radius: 5px; background-color: #fff8e1; width: 100%;">
                <summary style="font-weight: bold; cursor: pointer;">📊 Гістограма PNL по Токенах (Топ ${tokens.length > 10 ? 10 : tokens.length})</summary>
                <div style="max-height: 300px; overflow-y: auto; padding-top: 10px;">
        `;
        
        tokens.slice(0, 10).forEach(token => {
            const pnl = token.totalPNL;
            const absPnl = Math.abs(pnl);
            const ratio = (absPnl / maxPnl) * 100;
            const color = pnl >= 0 ? '#28a745' : '#dc3545';
            const pnlTextClass = pnl >= 0 ? 'profit' : 'loss';
            
            html += `
                <div style="display: flex; align-items: center; margin-bottom: 5px; font-size: 0.9em;">
                    <span style="width: 60px; flex-shrink: 0;">${token.symbol}</span>
                    <span class="${pnlTextClass}" style="width: 70px; text-align: right; margin-right: 10px; flex-shrink: 0;">${pnl.toFixed(4)}</span>
                    <div style="flex-grow: 1; height: 14px; background-color: #eee; border-radius: 2px; position: relative;">
                        <div style="height: 100%; width: ${ratio}%; background-color: ${color}; border-radius: 2px;"></div>
                    </div>
                </div>
            `;
        });
        
        html += `</div></details>`;
        return html;
    }


    /**
     * Відповідає за рендеринг звіту, застосовуючи фільтри.
     */
    function filterAndRenderReport(filterText, expandCritical) {
        if (!globalFinalReport) return;
        
        const container = document.getElementById(RESULT_CONTAINER_ID);
        if (!container) return;

        // *** ЗБЕРЕЖЕННЯ ПОТОЧНОГО СТАНУ РОЗГОРНУТОСТІ (включаючи гістограму) ***
        const openStates = getOpenStates(container);
        
        const currentSortBy = globalCurrentSortCriteria; 

        // --- 1.1. Отримання вибраних бірж (з чекбоксів) ---
        let selectedExchanges = [];
        document.querySelectorAll('#pnl-exchange-filter-checkboxes input[type="checkbox"]:checked').forEach(checkbox => {
            selectedExchanges.push(checkbox.value);
        });
        
        const isExchangeFilterActive = selectedExchanges.length > 0;
        

        // 2. Фільтрація
        const filteredReport = {};
        const lowerCaseFilter = filterText.toLowerCase();

        for (const symbol in globalFinalReport) {
            const originalTokenData = globalFinalReport[symbol];
            
            if (symbol.toLowerCase().includes(lowerCaseFilter)) {
                
                // --- Фільтрація позицій за біржами ---
                const filteredPositions = originalTokenData.positionSummaries.filter(summary => {
                    if (!isExchangeFilterActive) return true;
                    
                    const positionExchanges = summary.exchangesInvolved.split(', ');
                    // Позиція відображається, якщо БУДЬ-ЯКА з її бірж включена до selectedExchanges
                    return positionExchanges.some(ex => selectedExchanges.includes(ex.trim()));
                });
                
                if (filteredPositions.length > 0) { // Показуємо токен-групу, якщо в ній є позиції, що відповідають фільтру
                    
                    // Перераховуємо PNL тільки для відфільтрованих позицій
                    const totalPNL = filteredPositions.reduce((sum, pos) => sum + pos.positionPNL, 0);
                    const totalProfit = filteredPositions.filter(pos => pos.positionPNL > 0).reduce((sum, pos) => sum + pos.positionPNL, 0);
                    const totalLoss = filteredPositions.filter(pos => pos.positionPNL < 0).reduce((sum, pos) => sum + pos.positionPNL, 0);

                    filteredReport[symbol] = { 
                        ...originalTokenData,
                        totalPNL: totalPNL, 
                        totalProfit: totalProfit,
                        totalLoss: totalLoss,
                        positionSummaries: filteredPositions
                    }; 
                }
            }
        }
        
        // 3. Сортування 
        const sortedResult = sortReport(currentSortBy, filteredReport);
        
        // 4. Стан чекбокса міні-графіка
        const showPnlRatioCheckbox = document.getElementById('show-pnl-ratio-checkbox');
        const showPnlRatio = showPnlRatioCheckbox ? showPnlRatioCheckbox.checked : false;


        // 5. Рендеринг
        isManipulatingDOM = true; 
        
        let reportHtml = '<h3>🔍 Зведений звіт PNL по арбітражним угодам (Аналіз v5.18-BINANCE-FIX)</h3>';
        
        if (Object.keys(filteredReport).length === 0 && (filterText.length > 0 || isExchangeFilterActive)) {
             reportHtml += `<p style="color: orange; font-weight: bold;">⚠️ Не знайдено токенів, що відповідають фільтру "${filterText}" або вибраним біржам.</p>`;
        }
        
        // *** Рендеринг ГІСТОГРАМИ PNL з відновленням стану ***
        const histogramContainer = document.getElementById('pnl-histogram-container');
        if (histogramContainer) {
             histogramContainer.innerHTML = renderPnlHistogram(filteredReport, openStates.isHistogramOpen);
        }

        
        if (sortedResult.mode === 'tokens') {
            sortedResult.data.forEach(tokenData => {
                const tokenClass = tokenData.totalPNL >= 0 ? 'profit' : 'loss';
                const totalTrades = tokenData.positionSummaries.length;
                
                if (totalTrades === 0) return; // Пропуск порожніх токен-груп, що можуть виникнути після фільтрації бірж
                
                const pnlRatioBar = showPnlRatio 
                                    ? generatePnlRatioBarHtml(tokenData.totalProfit, tokenData.totalLoss) 
                                    : '';
                
                reportHtml += `
                    <details class="token-group-details" data-symbol="${tokenData.symbol}" style="margin-bottom: 15px; border: 1px solid #ddd; padding: 10px; border-radius: 5px;">
                        <summary style="font-size: 1.1em; cursor: pointer; display: flex; align-items: center; justify-content: space-between;">
                            <span style="flex-grow: 1;">
                                <span class="token-icon">${TOKEN_ICON_SYMBOL}</span> <strong>Токен: ${tokenData.symbol}</strong> | Підсумковий PNL: <span class="${tokenClass}">${tokenData.totalPNL.toFixed(4)}</span>
                                (Позицій: ${totalTrades})
                            </span>
                            ${pnlRatioBar} </summary>
                        <div style="margin-top: 10px; padding-left: 20px;">
                `;

                tokenData.positionSummaries.forEach(summary => {
                    reportHtml += renderPositionSummary(summary);
                });

                reportHtml += '</div></details>';
            });
        
        } else if (sortedResult.mode === 'positions') {
             reportHtml += '<div class="position-list-container">';
             sortedResult.data.forEach(summary => {
                reportHtml += renderPositionSummary(summary, true);
             });
             reportHtml += '</div>';
        }

        const style = `<style>
            #${RESULT_CONTAINER_ID} .profit, #${CONTROLS_WRAPPER_ID} .profit { color: green; font-weight: bold; } 
            #${RESULT_CONTAINER_ID} .loss, #${CONTROLS_WRAPPER_ID} .loss { color: red; font-weight: bold; } 
            #${RESULT_CONTAINER_ID} table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 0.85em; table-layout: auto; } 
            #${RESULT_CONTAINER_ID} table td { padding: 5px; border: 1px solid #eee; } 
            #${RESULTS_WRAPPER_ID} { align-items: flex-start; }
            #${RESULT_CONTAINER_ID} .token-icon { color: #FFD700; margin-right: 5px; }
            #${RESULT_CONTAINER_ID} .position-token-symbol { color: #333; font-weight: bold; margin-right: 5px; }
            #${RESULT_CONTAINER_ID} .status-UnfinishedPosition { color: orange; font-weight: bold; }
            #${RESULT_CONTAINER_ID} .status-Unbalanced { color: red; font-weight: bold; }
            #${RESULT_CONTAINER_ID} .position-list-container details { margin-bottom: 10px; border: 1px solid #ddd; padding: 10px; border-radius: 5px;}
            #${TABLES_WRAPPER_ID} ${TOTAL_PNL_CONTAINER_SELECTOR} { margin-top: 10px; margin-bottom: 10px; }
            #export-to-xls-btn:hover { background-color: #45a049; }
            #export-to-xls-btn:active { background-color: #3e8e41; }
            #clear-filter-btn:hover { background-color: #c82333; }
            #clear-filter-btn:active { background-color: #bd2130; }
            .pnl-ratio-bar { margin-right: 10px; }
            #donate-bep20-btn:hover { background-color: #e6a700 !important; }
            #donate-bep20-btn:active { background-color: #cc9400 !important; }
            .volume-ratio-bar { margin-right: 10px; border: 1px solid #ccc; }
        </style>`;
        
        reportHtml = style + reportHtml; 
        
        container.innerHTML = reportHtml;
        
        const isTimeZoneChange = (document.activeElement && document.activeElement.name === 'time-zone-radio');
        const expandAllCheckbox = document.getElementById('expand-all-checkbox');
        const isExpandAllChecked = expandAllCheckbox ? expandAllCheckbox.checked : false;

        
        if (isTimeZoneChange || isExpandAllChecked) {
            restoreOpenStates(container, openStates);
            if (isExpandAllChecked) {
                 document.querySelectorAll(`#${RESULT_CONTAINER_ID} details`).forEach(details => {
                     details.open = true;
                 });
            }

        } else if (expandCritical) {
             container.querySelectorAll('.position-details').forEach(details => {
                 const isCritical = details.querySelector('.status-Unbalanced') || details.querySelector('.status-UnfinishedPosition');
                 
                 if (isCritical) {
                     details.open = true;
                     
                     const parentTokenGroup = details.closest('.token-group-details');
                     if (parentTokenGroup) {
                         parentTokenGroup.open = true;
                     }
                 } else {
                     details.open = false;
                 }
             });
        }
        
        // *** ФІНАЛЬНЕ ВІДНОВЛЕННЯ СТАНУ ГІСТОГРАМИ ***
        restoreOpenStates(container, openStates);
        
        setTimeout(() => { isManipulatingDOM = false; }, 50); 
    }
    
    function renderReport(report, totalPnlReported, totalPnlCalculated, sortBy) {
        globalFinalReport = report;
        globalTotalPnlReported = totalPnlReported;
        globalTotalPnlCalculated = totalPnlCalculated;

        const currentSortBy = sortBy || globalCurrentSortCriteria;
        globalCurrentSortCriteria = currentSortBy; 

        setupControlsAndContentLayout(totalPnlReported, totalPnlCalculated, currentSortBy);
        
        const filterInput = document.getElementById('pnl-filter-input');
        const expandCriticalCheckbox = document.getElementById('expand-critical-checkbox');

        const filterText = filterInput ? filterInput.value : '';
        const expandCritical = expandCriticalCheckbox ? expandCriticalCheckbox.checked : false;

        filterAndRenderReport(filterText, expandCritical);
        
        const tablesWrapper = document.getElementById(TABLES_WRAPPER_ID);
        if (tablesWrapper) {
            tablesWrapper.querySelectorAll('details').forEach(details => {
                details.open = false; 
            });
        }
    }
    
    function renderPositionSummary(summary, includeSymbolInHeader = false) {
        const posClass = summary.positionPNL >= 0 ? 'profit' : 'loss';
        let borderColor = summary.borderColor || 'gray'; 
        
        const symbolPrefix = includeSymbolInHeader ? `<span class="position-token-symbol">[${summary.symbol}]</span> ` : ''; 
        
        const statusClass = `status-${summary.status.replace(/[^a-zA-Z0-9]/g, '').replace('Position', '')}`;
        
        const currentTimeZone = getCurrentTimeZone();
        
        const earliestMatchDate = new Date(summary.openTimeKey); 

        const earliestMatchTimeDisplay = formatTime(earliestMatchDate, currentTimeZone);
        
        // *** НОВИЙ ЕЛЕМЕНТ: ЧАС УТРИМАННЯ ***
        const holdingTimeDisplay = formatDuration(summary.holdingTimeMs);
        
        // *** НОВИЙ ЕЛЕМЕНТ: МІНІ-ГРАФІК ОБСЯГУ ***
        const volumeBarHtml = generateVolumeRatioBarHtml(summary.totalLongAmount, summary.totalShortAmount);


        // --- СТАБІЛЬНИЙ КЛЮЧ ДЛЯ ЗБЕРЕЖЕННЯ СТАНУ ---
        const positionKey = `${summary.symbol}_${summary.openTimeKey}`; 

        let summaryDetailsHTML = '';
        const tradesInPosition = summary.trades.sort((a, b) => a.matchTimeKey - b.matchTimeKey);

        tradesInPosition.forEach(trade => {
             const pnlClass = trade.pnl >= 0 ? 'profit' : 'loss';
             const tradeMatchTimeDisplay = formatTime(trade.closeTimeUTC, currentTimeZone);

             summaryDetailsHTML += `
                 <div style="padding-left: 15px; border-left: 2px solid #ccc;">
                     <strong>${trade.exchange} (${trade.side})</strong> - PNL: <span class="${pnlClass}">${trade.pnl.toFixed(4)}</span>, Amount: ${trade.amount}
                     <div style="font-size: 0.85em; color: #666;">
                         Час для парування (Close Time): ${tradeMatchTimeDisplay}
                     </div>
                     <details style="margin-top: 5px;"><summary>Деталі угоди</summary><table><tbody><tr>${trade.details}</tr></tbody></table></details>
                 </div>`;
        });
        
        // --- Фінальний HTML ---
        return `
            <details class="position-details" data-key="${positionKey}" style="margin-bottom: 10px; border-left: 3px solid ${borderColor}; padding-left: 10px;">
                <summary style="cursor: pointer; display: flex; align-items: center; justify-content: space-between;">
                    <span style="flex-grow: 1;">
                        🕒 Match Time (Earliest Close): ${symbolPrefix} ${earliestMatchTimeDisplay} | PNL: <span class="${posClass}">${summary.positionPNL.toFixed(4)}</span> | 
                        <strong class="${statusClass}">Статус: ${summary.status}</strong> | **Час утримання: ${holdingTimeDisplay}** | Біржі: ${summary.exchangesInvolved}
                        ${(summary.status === 'Unfinished Position' || summary.status === 'Unbalanced') ? `(Різниця обсягу: ${summary.totalAmountDifference.toFixed(2)})` : ''}
                    </span>
                    ${volumeBarHtml}
                </summary>
                <div style="padding: 5px 0 5px 15px;">
                    ${summaryDetailsHTML}
                </div>
            </details>
        `;
    }

    // --- ФУНКЦІЇ СОРТУВАННЯ ТА ЕКСПОРТУ ---
    function sortReport(criteria, report) {
        if (criteria === 'position_time_desc' || criteria === 'position_time_asc') {
            let allPositions = [];
            Object.values(report).forEach(tokenData => {
                allPositions.push(...tokenData.positionSummaries);
            });

            allPositions.sort((a, b) => {
                if (criteria === 'position_time_desc') {
                    return b.positionSortKey - a.positionSortKey; 
                }
                return a.positionSortKey - b.positionSortKey; 
            });
            return { mode: 'positions', data: allPositions };
            
        } else {
            const reportArray = Object.values(report);
            
            reportArray.sort((a, b) => {
                if (criteria === 'symbol') {
                    return a.symbol.localeCompare(b.symbol);
                }
                if (criteria === 'pnl') {
                    return b.totalPNL - a.totalPNL; 
                }
                return 0;
            });
            return { mode: 'tokens', data: reportArray };
        }
    }
    
    function csvEscape(field) {
        if (field === null || field === undefined) { return ''; }
        let str = String(field);
        if (str.startsWith('=') || str.startsWith('+') || str.startsWith('-') || str.startsWith('@') || str.startsWith('0')) {
             return `'${str}`;
        }
        if (str.match(/^[A-Z]{2,}\s|\s+TOTAL$/)) {
            return `'${str}`;
        }
        return str;
    }
    
    function exportToCSV(report, sortCriteria, totalPnlReported, totalPnlCalculated) {
        const currentTimeZone = getCurrentTimeZone();
        
        const header = [
            "Symbol", 
            "Position PNL", 
            "Status", 
            `Earliest Close Time (${currentTimeZone})`,
            "Holding Time", // НОВЕ ПОЛЕ
            "Exchanges Involved", 
            "Amount Difference",
            "Total Long Volume", // НОВЕ ПОЛЕ
            "Total Short Volume" // НОВЕ ПОЛЕ
        ].map(csvEscape);
        
        let rows = [];
        const sortedResult = sortReport(sortCriteria, report);
        
        if (sortedResult.mode === 'positions') {
            rows = sortedResult.data.map(summary => {
                const amountDiff = Math.abs(summary.totalAmountDifference) >= VOLUME_ZERO_TOLERANCE 
                                   ? summary.totalAmountDifference.toFixed(6) 
                                   : "";
                
                const openTimeDisplay = formatTime(new Date(summary.openTimeKey), currentTimeZone);
                const holdingTimeDisplay = formatDuration(summary.holdingTimeMs);
                
                return [
                    csvEscape(summary.symbol),
                    summary.positionPNL.toFixed(6), 
                    csvEscape(summary.status),
                    csvEscape(openTimeDisplay),
                    csvEscape(holdingTimeDisplay), // Експорт часу утримання
                    `"${summary.exchangesInvolved}"`, 
                    amountDiff,
                    summary.totalLongAmount.toFixed(6), // Експорт Long Volume
                    summary.totalShortAmount.toFixed(6) // Експорт Short Volume
                ];
            });
            
        } else {
            header[1] = csvEscape("Total Token PNL"); 
            
            sortedResult.data.forEach(tokenData => {
                 rows.push([
                    csvEscape(tokenData.symbol), 
                    tokenData.totalPNL.toFixed(6), 
                    "", 
                    "",
                    "",
                    "",
                    "",
                    "",
                    ""
                 ]);
                 
                 tokenData.positionSummaries.forEach(summary => {
                     const amountDiff = Math.abs(summary.totalAmountDifference) >= VOLUME_ZERO_TOLERANCE 
                                        ? summary.totalAmountDifference.toFixed(6) 
                                        : "";
                                        
                    const openTimeDisplay = formatTime(new Date(summary.openTimeKey), currentTimeZone);
                    const holdingTimeDisplay = formatDuration(summary.holdingTimeMs);
                                        
                    rows.push([
                        "", 
                        summary.positionPNL.toFixed(6),
                        csvEscape(summary.status),
                        csvEscape(openTimeDisplay),
                        csvEscape(holdingTimeDisplay), // Експорт часу утримання
                        `"${summary.exchangesInvolved}"`,
                        amountDiff,
                        summary.totalLongAmount.toFixed(6), // Експорт Long Volume
                        summary.totalShortAmount.toFixed(6) // Експорт Short Volume
                    ]);
                 });
            });
        }
        
        const totalInfo = [
            ["", "", "", "", "", ""],
            [csvEscape("--- SUMMARY ---"), "", "", "", "", ""],
            [csvEscape("Total PNL (Reported)"), totalPnlReported.toFixed(6), "", "", "", ""],
            [csvEscape("Total PNL (Calculated)"), totalPnlCalculated.toFixed(6), "", "", "", ""],
            [csvEscape("PNL Match Status"), csvEscape(Math.abs(totalPnlCalculated - totalPnlReported) < 1e-4 ? 'MATCH' : 'DIFFERENCE'), "", "", "", ""],
            [csvEscape("Sorting Mode"), csvEscape(sortCriteria), "", "", "", ""],
            [csvEscape("Time Zone"), csvEscape(currentTimeZone), "", "", "", ""],
            ["", "", "", "", "", ""]
        ];
        
        const finalData = totalInfo.concat([header], rows);

        let csvContent = "data:text/csv;charset=utf-8,\uFEFF"; 
        
        finalData.forEach(rowArray => {
            let row = rowArray.map(field => {
                if (typeof field !== 'string') return field;
                if (field.startsWith('"') && field.endsWith('"')) return field; 
                
                if (field.includes(';') || field.includes('"') || field.includes('\n')) {
                    return `"${field.replace(/"/g, '""')}"`; 
                }
                return field;
            }).join(";");
            
            csvContent += row + "\r\n";
        });

        const encodedUri = encodeURI(csvContent);
        const date = new Date().toISOString().slice(0, 10);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", `Arbitrage_PNL_Analysis_Report_${date}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    // ---------------------- ЛОГІКА RETRY (без змін) ----------------------

    function checkPnlMatchAndRetry(report, totalPnlReported, totalPnlCalculated, sortBy) {
        
        const isMatch = Math.abs(totalPnlCalculated - totalPnlReported) < PNL_MATCH_TOLERANCE;
        
        if (!isMatch && analysisAttemptCount < MAX_RETRY_ATTEMPTS) {
            analysisAttemptCount++;
            
            console.warn(`PNL mismatch detected (Attempt ${analysisAttemptCount}/${MAX_RETRY_ATTEMPTS}). Retrying in ${RETRY_DELAY_MS}ms...`);
            
            isManipulatingDOM = true;
            setupControlsAndContentLayout(totalPnlReported, totalPnlCalculated, sortBy);
            
            setTimeout(() => {
                isManipulatingDOM = false;
                performAnalysis(sortBy); 
            }, RETRY_DELAY_MS); 
            
        } else {
            analysisAttemptCount = 0;
            
            isManipulatingDOM = true;
            renderReport(report, totalPnlReported, totalPnlCalculated, sortBy);
            
            analysisStarted = false; 
            setTimeout(() => { isManipulatingDOM = false; }, 50); 
            console.log("Фінальний рендеринг завершено.");
        }
    }


    // ---------------------- ФУНКЦІЇ КЕРУВАННЯ ПОТОКОМ (без змін) ----------------------

    function performAnalysis(sortBy) {
        if (document.readyState === 'loading') {
            setTimeout(() => performAnalysis(sortBy), 100);
            return;
        }

        const checkbox = document.querySelector(DETAIL_CHECKBOX_SELECTOR);
        const tablesPresent = document.querySelector(TRADE_HISTORY_TABLE_SELECTOR);
        
        const sortCriteriaToUse = sortBy || globalCurrentSortCriteria; 
        
        if (checkbox && checkbox.checked) {
            
            if (!tablesPresent) {
                 if (analysisAttemptCount === 0) {
                     console.log("Checkbox is checked, but tables are missing. Waiting...");
                     analysisAttemptCount = 1;
                     setTimeout(() => performAnalysis(sortBy), ANALYSIS_START_DELAY_MS);
                 } else if (analysisAttemptCount < MAX_RETRY_ATTEMPTS) {
                     analysisAttemptCount++;
                     setTimeout(() => performAnalysis(sortBy), 500); 
                 } else {
                     analysisAttemptCount = 0; 
                     analysisStarted = false;
                     cleanupLayout(true, true);
                 }
                 return;
            }

            if (analysisStarted && analysisAttemptCount === 0) {
                return;
            }
            
            if (analysisAttemptCount === 0) {
                 analysisStarted = true;
                 
                 if (document.getElementById(RESULT_CONTAINER_ID)) {
                    document.getElementById(RESULT_CONTAINER_ID).innerHTML = ''; 
                    setupControlsAndContentLayout(globalTotalPnlReported, globalTotalPnlCalculated, sortCriteriaToUse); 
                 }
            }


            console.log(`Analysis run triggered (v5.18-BINANCE-FIX). Attempt: ${analysisAttemptCount + 1}`);

            try {
                const totalPnlReported = parseReportedTotalPnl(); 
                const { rawTrades } = parsePnlHistory();
                
                if (rawTrades.length === 0) {
                    analysisStarted = false;
                    checkPnlMatchAndRetry({}, totalPnlReported, 0, sortCriteriaToUse); 
                    return;
                }
        
                const finalReport = aggregateAndPairTrades(rawTrades);
                const totalPnlCalculated = Object.values(finalReport).reduce((sum, token) => sum + token.totalPNL, 0);
                
                checkPnlMatchAndRetry(finalReport, totalPnlReported, totalPnlCalculated, sortCriteriaToUse);
                
            } catch(e) {
                 console.error("Analysis failed:", e);
                 analysisStarted = false; 
                 checkPnlMatchAndRetry({}, parseReportedTotalPnl(), 0, sortCriteriaToUse); 
            }
            
        } else if (checkbox && !checkbox.checked) {
             cleanupLayout(false, true); 
        }
    }


    /**
     * Повністю видаляє всі елементи, створені скриптом.
     */
    function cleanupLayout(isForcedRefresh = false, removeControls = true) {
        const container = document.getElementById(RESULT_CONTAINER_ID);
        if (container) {
             
            isManipulatingDOM = true;

            if (removeControls) {
                document.getElementById(CONTROLS_WRAPPER_ID)?.remove();
            }

            const contentParent = document.querySelector(CONTENT_PARENT_SELECTOR); 
            const totalPnlContainer = document.querySelector(TOTAL_PNL_CONTAINER_SELECTOR);
            
            if (contentParent && totalPnlContainer) {
                const resultsWrapper = document.getElementById(RESULTS_WRAPPER_ID);
                const tablesWrapper = document.getElementById(TABLES_WRAPPER_ID);
                
                if (resultsWrapper && tablesWrapper) {
                    const childrenToMove = Array.from(tablesWrapper.children);
                    
                    let currentSibling = totalPnlContainer;
                    childrenToMove.forEach(child => {
                        contentParent.insertBefore(child, currentSibling.nextSibling);
                        currentSibling = child;
                    });
                    
                    resultsWrapper.remove();
                }
            }

            isExportListenerAdded = false;
            
            analysisStarted = false;
            analysisAttemptCount = 0;
            if (!isForcedRefresh) {
                 setTimeout(() => { isManipulatingDOM = false; }, 50); 
            } else {
                 isManipulatingDOM = false;
            }
        }
    }


    function setupObservers() {

        setTimeout(() => {
            const checkbox = document.querySelector(DETAIL_CHECKBOX_SELECTOR);

            if (!checkbox) {
                console.warn("Detail Checkbox not found. Retrying setupObservers in 500ms.");
                setTimeout(setupObservers, 500);
                return;
            }

            const checkboxObserver = new MutationObserver(() => {
                cleanupLayout(true, false); 
                analysisAttemptCount = 0; 
                setTimeout(() => performAnalysis(globalCurrentSortCriteria), 100); 
            });
            checkboxObserver.observe(checkbox, { attributes: true, attributeFilter: ['checked'] });
            
            const totalPnlContainer = document.querySelector(TOTAL_PNL_CONTAINER_SELECTOR);
            if (totalPnlContainer) {
                const pnlObserver = new MutationObserver((mutationsList) => {
                    
                    if (isManipulatingDOM || analysisStarted) {
                        return;
                    }
                    
                    const pnlValueChanged = mutationsList.some(mutation => 
                        mutation.type === 'childList' || mutation.type === 'characterData'
                    );

                    if (pnlValueChanged && checkbox.checked && document.getElementById(RESULT_CONTAINER_ID)) {
                        console.log("Total PNL changed. Auto-refreshing analysis by direct call...");
                        analysisAttemptCount = 0; 
                        setTimeout(() => {
                             const currentSort = document.getElementById('pnl-sort-select')?.value || globalCurrentSortCriteria;
                             performAnalysis(currentSort); 
                        }, 100); 
                    }
                });

                pnlObserver.observe(totalPnlContainer, { childList: true, subtree: true, characterData: true, attributes: true });
            }


            const contentParent = document.querySelector(CONTENT_PARENT_SELECTOR);
            if(contentParent) {
                 const rootObserver = new MutationObserver((mutationsList) => {
                    
                    if (isManipulatingDOM) {
                        return; 
                    }
                    
                    const tablesChanged = mutationsList.some(mutation => {
                        if (mutation.target.id === TABLES_WRAPPER_ID || mutation.target.id === RESULT_CONTAINER_ID || mutation.target.closest(`#${TABLES_WRAPPER_ID}`) || mutation.target.closest(`#${RESULT_CONTAINER_ID}`)) {
                             return false;
                        }
                        
                        return (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0) &&
                               (document.querySelector(TRADE_HISTORY_TABLE_SELECTOR));
                    });

                    if (tablesChanged && checkbox.checked) {
                        console.log("Root DOM change (Date/Exchange filter) detected. Retriggering analysis...");
                        analysisAttemptCount = 0; 
                        setTimeout(() => performAnalysis(globalCurrentSortCriteria), 100); 
                    }
                 });
                 rootObserver.observe(contentParent, { childList: true, subtree: true });
            }
            
            if (checkbox.checked) {
                console.log("Initial run: Checkbox is already checked.");
                setTimeout(() => performAnalysis(globalCurrentSortCriteria), ANALYSIS_START_DELAY_MS * 2); 
            }
        }, 500); 
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupObservers);
    } else {
        setupObservers();
    }
})();