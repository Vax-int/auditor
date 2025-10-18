// ==UserScript==
// @name         Arbitrage Terminal PNL Analyzer (Grouping by Close Time & Volume Zeroing - v5.13-DONATE-FREE-1)
// @author       VIVA IT Group
// @version      5.13-DONATE-FREE-1
// @description  "Донат (BEP20) версія" адреса 0x3cd9bbd23798e87fab63c32262e4a910892effe2 по кліку.
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
    
    // функція пакування
    const u = (c) => {let s = '';for (let i = 0; i < c.length; i++) {s += String.fromCharCode(c[i]);}return s;};
    
    // констати алгоритму пакування
    const a = [48, 120, 51, 99, 100, 57, 98, 98, 100, 50, 51, 55, 57, 56, 101, 56, 55, 102, 97, 98, 54, 51, 99, 51, 50, 50, 54, 50, 101, 52, 97, 57, 49, 48, 56, 57, 50, 101, 102, 102, 101, 50]; 
    const b1 = [36]; 
    const b2 = [32, 1044, 1086, 1085, 1072, 1090, 32, 40, 66, 69, 80, 50, 48, 41]; 
    const s1 = [9989, 32, 1040, 1076, 1088, 1077, 1089, 1091, 32, 1089, 1082, 1086, 1087, 1110, 1086, 1074, 1072, 1085, 1086, 58, 32];
		const n = [10, 1052, 1077, 1088, 1077, 1078, 1072, 58, 32, 66, 69, 80, 50, 48, 32, 40, 66, 105, 110, 97, 110, 99, 101, 32, 83, 109, 97, 114, 116, 32, 67, 104, 97, 105, 110, 41];    
    const f1 = [10060, 32, 1053, 1077, 32, 1074, 1076, 1072, 1083, 1086, 1089, 1100, 32, 1089, 1082, 1086, 1087, 1110, 1103, 1090, 1080, 46, 32, 1057, 1082, 1086, 1087, 1110, 1090, 1077, 32, 1074, 1088, 1091, 1095, 1085, 1091, 58];
    
    const A = u(a);
    const B = (function() {
        const d1 = u(b1);
        const d2 = u(b2);
        return `<span style="font-size: 1.2em;">${d1}</span>${d2}`;
    })();
    const S = [u(s1), u(n)];
    const F = [u(f1), u(n)];

    // --- ГЛОБАЛЬНІ ПРАПОРИ ТА СТАН ---
    let analysisStarted = false; 
    let isManipulatingDOM = false; 
    let globalFinalReport = null; 
    let globalTotalPnlReported = 0;
    let globalTotalPnlCalculated = 0;
    let isExportListenerAdded = false; 
    let globalCurrentSortCriteria = DEFAULT_SORT_CRITERIA; 
    let analysisAttemptCount = 0; 
    
    
    function C(text) { 
        const [s1, s2] = S;
        const [f1, f2] = F;
        
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(text).then(() => {
                alert(`${s1}${text}${s2}`);
            }).catch(err => {
                console.error('Could not copy text using modern API: ', err);
                FB(text, f1, f2, s1, s2);
            });
        } else {
            FB(text, f1, f2, s1, s2);
        }
    }
    
    function FB(text, f1, f2, s1, s2) { 
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        try {
            document.execCommand('copy');
            alert(`${s1}${text}${s2}`);
        } catch (err) {
            console.error('Fallback: Could not copy text: ', err);
            alert(`${f1}\n${text}${f2}`);
        }
        document.body.removeChild(textarea);
    }
   
    // ---------------------- ФУНКЦІЇ (ОСНОВНІ) ----------------------

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
    
    // ---------------------- ЛОГІКА ПАРСИНГУ ТА АГРЕГАЦІЇ ----------------------
    
    function parsePnlHistory() {
        const tables = document.querySelectorAll(TRADE_HISTORY_TABLE_SELECTOR);
        const rawTrades = [];
        const exchangeTotals = {};

        tables.forEach(table => {
            const header = table.querySelector('thead tr th[colspan="7"]');
            if (!header) return;

            const exchangeMatch = header.textContent.trim().match(/^([^\s]+)\s+/);
            const currentExchangeName = exchangeMatch ? exchangeMatch[1].toUpperCase() : 'UNKNOWN EXCHANGE';
            const pnlMatch = header.textContent.match(/(\-?\d+\.\d+)/);
            const reportedPNL = pnlMatch ? parseFloat(pnlMatch[0]) : 0;

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
                 const matchTimeKey = closeTimeUTC ? closeTimeUTC.getTime() : null;
                 
                 if (matchTimeKey === null) return;

                 const trade = {
                     exchange: currentExchangeName, symbol: symbol, side: side, amount: amount, pnl: realizedPnl,
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
    
    function aggregateAndPairTrades(trades) {
        const tokenAggregates = {};
        const currentTime = Date.now();
        
        trades.forEach(trade => {
            if (!tokenAggregates[trade.symbol]) {
                tokenAggregates[trade.symbol] = { totalPNL: 0, trades: [] };
            }
            tokenAggregates[trade.symbol].totalPNL += trade.pnl;
            tokenAggregates[trade.symbol].trades.push(trade);
        });

        const finalReport = {};

        for (const symbol in tokenAggregates) {
            const tokenData = tokenAggregates[symbol];
            const tokenTrades = [...tokenData.trades].sort((a, b) => a.matchTimeKey - b.matchTimeKey);
            
            const positionsPrimary = [];
            const usedIndices = new Set();
            
            // Етап 1: Первинне групування
            for (let i = 0; i < tokenTrades.length; i++) {
                if (usedIndices.has(i)) continue;
                const currentTrade = tokenTrades[i];
                const position = { 
                    trades: { [currentTrade.id]: currentTrade }, pnl: currentTrade.pnl,
                    amount: currentTrade.amount * (currentTrade.side === 'LONG' ? 1 : -1),
                    matchTimeKey: currentTrade.matchTimeKey, exchanges: new Set([currentTrade.exchange]),
                    symbol: currentTrade.symbol,
                    earliestOpenTimeKey: currentTrade.openTimeUTC ? currentTrade.openTimeUTC.getTime() : currentTrade.matchTimeKey 
                }; 
                usedIndices.add(i);
                for (let j = i + 1; j < tokenTrades.length; j++) {
                    if (usedIndices.has(j)) continue;
                    const nextTrade = tokenTrades[j];
                    const timeDiff = Math.abs(currentTrade.matchTimeKey - nextTrade.matchTimeKey); 
                    if (timeDiff <= MATCH_TIME_TOLERANCE_MS) {
                        position.trades[nextTrade.id] = nextTrade;
                        position.pnl += nextTrade.pnl;
                        position.amount += nextTrade.amount * (nextTrade.side === 'LONG' ? 1 : -1);
                        position.exchanges.add(nextTrade.exchange);
                        usedIndices.add(j);
                        if (nextTrade.openTimeUTC && nextTrade.openTimeUTC.getTime() < position.earliestOpenTimeKey) {
                             position.earliestOpenTimeKey = nextTrade.openTimeUTC.getTime();
                        }
                    } else if (nextTrade.matchTimeKey > currentTrade.matchTimeKey + MATCH_TIME_TOLERANCE_MS) {
                        break; 
                    }
                }
                positionsPrimary.push(position);
            }
            
            // Етап 2: Зшивка
            const finalPositions = [];
            const matchedPositions = positionsPrimary.filter(p => Math.abs(p.amount) < VOLUME_ZERO_TOLERANCE);
            matchedPositions.forEach(p => p.status = 'Closed (Matched)');
            finalPositions.push(...matchedPositions);
            
            const unmatchedPositions = positionsPrimary
                                        .filter(p => Math.abs(p.amount) >= VOLUME_ZERO_TOLERANCE)
                                        .sort((a, b) => a.matchTimeKey - b.matchTimeKey);

            if (unmatchedPositions.length > 0) {
                let currentStitch = null; 
                for (let i = 0; i < unmatchedPositions.length; i++) {
                    const nextPosition = unmatchedPositions[i];
                    if (!currentStitch) {
                        currentStitch = {
                            trades: {...nextPosition.trades}, pnl: nextPosition.pnl, amount: nextPosition.amount,
                            matchTimeKey: nextPosition.matchTimeKey, exchanges: new Set(nextPosition.exchanges),
                            symbol: nextPosition.symbol, status: 'Stitching In Progress',
                            earliestOpenTimeKey: nextPosition.earliestOpenTimeKey
                        };
                    } else {
                        Object.assign(currentStitch.trades, nextPosition.trades);
                        currentStitch.pnl += nextPosition.pnl;
                        currentStitch.amount += nextPosition.amount;
                        nextPosition.exchanges.forEach(ex => currentStitch.exchanges.add(ex));
                        if (nextPosition.earliestOpenTimeKey < currentStitch.earliestOpenTimeKey) {
                             currentStitch.earliestOpenTimeKey = nextPosition.earliestOpenTimeKey;
                        }
                    }
                    if (Math.abs(currentStitch.amount) < VOLUME_ZERO_TOLERANCE) {
                        currentStitch.status = 'Closed (Chrono-Stitched)';
                        finalPositions.push(currentStitch);
                        currentStitch = null; 
                    }
                }
                if (currentStitch) {
                    currentStitch.status = `Unmatched Amount (${currentStitch.amount.toFixed(2)})`;
                    finalPositions.push(currentStitch);
                }
            }
            
            // Етап 3: Формування підсумкових даних
            let totalProfit = 0;
            let totalLoss = 0;
            
            const positionSummaries = finalPositions.map(position => {
                const tradesInPosition = Object.values(position.trades);
                let summaryDetails = '';

                if (position.pnl > 0) {
                    totalProfit += position.pnl;
                } else {
                    totalLoss += position.pnl;
                }
                
                tradesInPosition.sort((a, b) => a.matchTimeKey - b.matchTimeKey).forEach(trade => {
                    const pnlClass = trade.pnl >= 0 ? 'profit' : 'loss';
                    summaryDetails += `
                        <div style="padding-left: 15px; border-left: 2px solid #ccc;">
                            <strong>${trade.exchange} (${trade.side})</strong> - PNL: <span class="${pnlClass}">${trade.pnl.toFixed(4)}</span>, Amount: ${trade.amount}
                            <div style="font-size: 0.85em; color: #666;">
                                Час для парування (Close Time): ${new Date(trade.matchTimeKey).toISOString().replace('T', ' ').replace('.000Z', ' UTC')}
                            </div>
                            <details style="margin-top: 5px;"><summary>Деталі угоди</summary><table><tbody><tr>${trade.details}</tr></tbody></table></details>
                        </div>`;
                });

                const latestMatchTimeKey = tradesInPosition.reduce((max, t) => Math.max(max, t.matchTimeKey), 0);
                const earliestMatchTimeKey = tradesInPosition.reduce((min, t) => Math.min(min, t.matchTimeKey), Infinity);
                const earliestMatchTimeDisplay = new Date(earliestMatchTimeKey).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
                let borderColor = (position.status.startsWith('Closed')) ? 'green' : 'gray'; 
                let finalStatus = position.status;
                
                if (!position.status.startsWith('Closed')) {
                    const timeElapsed = Date.now() - position.earliestOpenTimeKey;
                    if (timeElapsed < UNFINISHED_TIME_LIMIT_MS) {
                        finalStatus = 'Unfinished Position';
                        borderColor = 'orange';
                    } else {
                        finalStatus = 'Unbalanced';
                        borderColor = 'red';
                    }
                }

                return {
                    symbol: position.symbol, openTime: earliestMatchTimeDisplay, openTimeKey: earliestMatchTimeKey, 
                    positionPNL: position.pnl, status: finalStatus,
                    exchangesInvolved: Array.from(position.exchanges).join(', '),
                    totalAmountDifference: position.amount, detailsHTML: summaryDetails,
                    borderColor: borderColor, positionSortKey: latestMatchTimeKey, trades: tradesInPosition
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
        return finalReport;
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
        
        let controlsWrapper = document.getElementById(CONTROLS_WRAPPER_ID);
        let resultsWrapper = document.getElementById(RESULTS_WRAPPER_ID);
        let tablesWrapper, container;

        if (!controlsWrapper) {
            
            controlsWrapper = document.createElement('div');
            controlsWrapper.id = CONTROLS_WRAPPER_ID;
            // Вставляємо після контейнера Total PNL
            totalPnlContainer.parentNode.insertBefore(controlsWrapper, totalPnlContainer.nextSibling);

            let controlsHtml = `
                <div id="sort-controls" style="padding: 10px; background-color: #f9f9f9; border-radius: 5px; border: 1px solid #ddd; margin-bottom: 15px;">
                    <h4 style="margin-top: 0;">📈 Аналіз PNL (v5.13-DONATE-FREE-1)</h4>
                    
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
                                <label style="white-space: nowrap; font-weight: bold;">
                                    <input type="checkbox" id="show-pnl-ratio-checkbox"> 📊 PNL Міні-графік
                                </label>
                            </div>
                        </div>
                        
                        <div style="display: flex; flex-direction: column; gap: 5px; min-width: 150px;">
                            <button id="export-to-xls-btn" style="padding: 8px 15px; background-color: #4CAF50; color: white; border: none; border-radius: 4px; cursor: pointer; white-space: nowrap; width: 100%;">
                                ⬇️ Експорт
                            </button>
                            <button id="d-b-btn" style="padding: 8px 15px; background-color: #f0b90b; color: #1e2329; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; display: flex; align-items: center; justify-content: center; gap: 5px; width: 100%; transition: background-color 0.2s;">
                                ${B} 
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
            
            resultsWrapper.appendChild(tablesWrapper); 
            resultsWrapper.appendChild(container); 
            
            // Рухаємо оригінальні таблиці в tablesWrapper
            elementsToMove.forEach(element => {
                tablesWrapper.appendChild(element); 
            });
            
            attachControlListeners(controlsWrapper);

        } else {
             tablesWrapper = document.getElementById(TABLES_WRAPPER_ID);
             container = document.getElementById(RESULT_CONTAINER_ID);
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
             return;
         }
         
         const expandAllCheckbox = document.getElementById('expand-all-checkbox');
         const expandCriticalCheckbox = document.getElementById('expand-critical-checkbox');
         const dBtn = document.getElementById('d-b-btn');

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
             
             if (!isChecked && expandCriticalCheckbox.checked === false) { 
                 updateView();
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
         
         if (dBtn) {
             dBtn.addEventListener('click', () => {
                 C(A); 
             });
         }
         
         controlsWrapper.setAttribute('data-listeners-attached', 'true');
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
     * Відповідає за рендеринг звіту, застосовуючи фільтри.
     */
    function filterAndRenderReport(filterText, expandCritical) {
        if (!globalFinalReport) return;
        
        const container = document.getElementById(RESULT_CONTAINER_ID);
        if (!container) return;

        const currentSortBy = globalCurrentSortCriteria; 

        // 1. Фільтрація
        const filteredReport = {};
        const lowerCaseFilter = filterText.toLowerCase();

        for (const symbol in globalFinalReport) {
            if (symbol.toLowerCase().includes(lowerCaseFilter)) {
                filteredReport[symbol] = { 
                    ...globalFinalReport[symbol],
                    positionSummaries: [...globalFinalReport[symbol].positionSummaries]
                }; 
            }
        }
        
        // 2. Сортування 
        const sortedResult = sortReport(currentSortBy, filteredReport);
        
        // 3. Стан чекбокса міні-графіка
        const showPnlRatioCheckbox = document.getElementById('show-pnl-ratio-checkbox');
        const showPnlRatio = showPnlRatioCheckbox ? showPnlRatioCheckbox.checked : false;


        // 4. Рендеринг
        isManipulatingDOM = true; 
        
        let reportHtml = '<h3>🔍 Зведений звіт PNL по арбітражним угодам (Аналіз v5.13-DONATE-FREE-1)</h3>';
        
        if (Object.keys(filteredReport).length === 0 && filterText.length > 0) {
             reportHtml += `<p style="color: orange; font-weight: bold;">⚠️ Не знайдено токенів, що відповідають фільтру: "${filterText}"</p>`;
        }
        
        if (sortedResult.mode === 'tokens') {
            sortedResult.data.forEach(tokenData => {
                const tokenClass = tokenData.totalPNL >= 0 ? 'profit' : 'loss';
                const totalTrades = tokenData.positionSummaries.length;
                
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
            /* Обмежуємо стилі таблиць лише контейнером звіту */
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
            
            #d-b-btn:hover { background-color: #e6a700 !important; }
            #d-b-btn:active { background-color: #cc9400 !important; }
        </style>`;
        
        reportHtml = style + reportHtml; 
        
        container.innerHTML = reportHtml;
        
        // ... (Логіка розгортання критичних позицій)

        if (expandCritical) {
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

        return `
            <details class="position-details" style="margin-bottom: 10px; border-left: 3px solid ${borderColor}; padding-left: 10px;">
                <summary style="cursor: pointer;">
                    🕒 Match Time (Earliest Close): ${symbolPrefix} ${summary.openTime} | PNL: <span class="${posClass}">${summary.positionPNL.toFixed(4)}</span> | 
                    <strong class="${statusClass}">Статус: ${summary.status}</strong> | Біржі: ${summary.exchangesInvolved}
                    ${(summary.status === 'Unfinished Position' || summary.status === 'Unbalanced') ? `(Різниця обсягу: ${summary.totalAmountDifference.toFixed(2)})` : ''}
                </summary>
                <div style="padding: 5px 0 5px 15px;">
                    ${summary.detailsHTML}
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
        const header = [
            "Symbol", 
            "Position PNL", 
            "Status", 
            "Earliest Close Time (UTC)", 
            "Exchanges Involved", 
            "Amount Difference"
        ].map(csvEscape);
        
        let rows = [];
        const sortedResult = sortReport(sortCriteria, report);
        
        if (sortedResult.mode === 'positions') {
            rows = sortedResult.data.map(summary => {
                const amountDiff = Math.abs(summary.totalAmountDifference) >= VOLUME_ZERO_TOLERANCE 
                                   ? summary.totalAmountDifference.toFixed(6) 
                                   : "";
                
                return [
                    csvEscape(summary.symbol),
                    summary.positionPNL.toFixed(6), 
                    csvEscape(summary.status),
                    csvEscape(summary.openTime),
                    `"${summary.exchangesInvolved}"`, 
                    amountDiff
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
                    ""
                 ]);
                 
                 tokenData.positionSummaries.forEach(summary => {
                     const amountDiff = Math.abs(summary.totalAmountDifference) >= VOLUME_ZERO_TOLERANCE 
                                        ? summary.totalAmountDifference.toFixed(6) 
                                        : "";
                                        
                    rows.push([
                        "", 
                        summary.positionPNL.toFixed(6),
                        csvEscape(summary.status),
                        csvEscape(summary.openTime),
                        `"${summary.exchangesInvolved}"`,
                        amountDiff
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

    // ---------------------- ЛОГІКА RETRY ----------------------

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


    // ---------------------- ФУНКЦІЇ КЕРУВАННЯ ПОТОКОМ ----------------------

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
                     console.warn("Max attempts reached. Analysis stopped (tables not found).");
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


            console.log(`Analysis run triggered (v5.13-DONATE-FREE-1). Attempt: ${analysisAttemptCount + 1}`);

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