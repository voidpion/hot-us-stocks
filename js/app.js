(() => {
    "use strict";

    const INDEX_COLORS = [
        { line: "#3b82f6", bg: "rgba(59, 130, 246, 0.06)" },  // SPY - blue
        { line: "#f59e0b", bg: "rgba(245, 158, 11, 0.06)" },  // DIA - amber
        { line: "#8b5cf6", bg: "rgba(139, 92, 246, 0.06)" },  // QQQ - purple
    ];

    let stockData = null;
    let allStocks = [];
    let chart = null;
    let selectedStock = null;
    let selectedRange = "D5";
    let isIndexView = true;
    let activeCategory = "all";
    let activeSort = null;
    let sparklineMode = "intraday"; // "intraday" | "daily" | "monthly"

    // === Watchlist (localStorage) ===
    const WATCHLIST_KEY = "hot-us-stocks-watchlist";

    function getWatchlist() {
        try {
            return JSON.parse(localStorage.getItem(WATCHLIST_KEY)) || [];
        } catch { return []; }
    }

    function toggleWatchlist(symbol) {
        const list = getWatchlist();
        const idx = list.indexOf(symbol);
        if (idx >= 0) {
            list.splice(idx, 1);
        } else {
            list.push(symbol);
        }
        localStorage.setItem(WATCHLIST_KEY, JSON.stringify(list));
        applyFilter();
    }

    function isWatched(symbol) {
        return getWatchlist().includes(symbol);
    }

    function sortWithWatchlistFirst(stocks) {
        const watchlist = getWatchlist();
        if (!watchlist.length) return stocks;
        const watched = [];
        const rest = [];
        for (const s of stocks) {
            if (watchlist.includes(s.symbol)) {
                watched.push(s);
            } else {
                rest.push(s);
            }
        }
        return [...watched, ...rest];
    }

    window.__toggleWatch = toggleWatchlist;

    const CATEGORIES = {
        mag7: ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"],
        semi: ["AMD", "AVGO", "INTC", "QCOM", "MU"],
        software: ["CRM", "ORCL", "ADBE", "NOW"],
        internet: ["NFLX", "UBER", "ABNB", "SNAP"],
        fintech: ["V", "PYPL", "SQ", "COIN"],
    };

    // === Data Loading ===

    async function loadData() {
        const usGrid = document.getElementById("usStockGrid");
        usGrid.innerHTML = '<div class="loading">加载行情数据</div>';

        try {
            const resp = await fetch("data/stocks.json");
            if (!resp.ok) throw new Error("数据加载失败，请先运行 python scripts/fetch_data.py");
            stockData = await resp.json();
            allStocks = [
                ...(stockData.indices || []),
                ...(stockData.us_stocks || []),
                ...(stockData.cn_stocks || []),
            ];
            render();
        } catch (err) {
            usGrid.innerHTML = `<div class="error-message">${err.message}</div>`;
        }
    }

    // === Rendering ===

    function render() {
        renderHeader();
        renderInfoBar();
        renderStockGrid("usStockGrid", stockData.us_stocks || []);
        renderStockGrid("cnStockGrid", stockData.cn_stocks || []);
        renderStatsBar();
        // Default: show indices overview
        showIndicesChart();
    }

    function renderInfoBar() {
        // Market summary
        const summary = stockData.market_summary || "";
        document.getElementById("infoSummary").innerHTML = `<span class="summary-label">综述</span><span>${summary}</span>`;

        // Scrolling news
        const news = stockData.news || [];
        if (!news.length) {
            document.getElementById("infoBar").style.display = "none";
            return;
        }
        // Duplicate items for seamless infinite scroll
        const items = news.map((n) =>
            `<div class="news-item"><span class="news-time">${n.time}</span><span class="news-title">${n.title}</span></div>`
        ).join("");
        document.getElementById("newsScroll").innerHTML = items + items;
    }

    function renderHeader() {
        document.getElementById("updatedTime").textContent =
            `更新时间: ${stockData.updated_at}`;
        document.getElementById("marketDate").textContent =
            stockData.market_date;
    }

    function renderStockGrid(gridId, stocks) {
        const grid = document.getElementById(gridId);
        if (!stocks.length) {
            grid.innerHTML = '<div class="error-message">暂无数据</div>';
            return;
        }
        stocks = sortWithWatchlistFirst(stocks);
        grid.innerHTML = stocks.map((stock) => buildCardHTML(stock)).join("");
        renderSparklines(stocks, grid);
    }

    function getTrendTags(stock) {
        const h = stock.history;
        if (!h || h.length < 5) return [];
        const tags = [];
        const latest = h[h.length - 1];

        // 1. Consecutive up/down days
        let streak = 0;
        let dir = 0; // 1=up, -1=down
        for (let i = h.length - 1; i >= 1; i--) {
            const diff = h[i].close - h[i - 1].close;
            if (i === h.length - 1) {
                dir = diff > 0 ? 1 : diff < 0 ? -1 : 0;
                if (dir === 0) break;
                streak = 1;
            } else {
                if ((dir === 1 && diff > 0) || (dir === -1 && diff < 0)) {
                    streak++;
                } else {
                    break;
                }
            }
        }
        if (dir === 1 && streak >= 3) tags.push({ text: `连涨${streak}天`, type: "hot" });
        if (dir === -1 && streak >= 3) tags.push({ text: `连跌${streak}天`, type: "cold" });

        // 2. Big move (|change%| > 3%)
        const pct = Math.abs(stock.yesterday.change_percent);
        if (pct >= 5) {
            tags.push({ text: stock.yesterday.change >= 0 ? "暴涨" : "暴跌", type: stock.yesterday.change >= 0 ? "hot" : "cold" });
        } else if (pct >= 3) {
            tags.push({ text: stock.yesterday.change >= 0 ? "大涨" : "大跌", type: stock.yesterday.change >= 0 ? "hot" : "cold" });
        }

        // 3. 52-week high / low (using available history)
        const closes = h.map((d) => d.close);
        const maxClose = Math.max(...closes);
        const minClose = Math.min(...closes);
        if (latest.close >= maxClose * 0.99) tags.push({ text: "创新高", type: "hot" });
        else if (latest.close <= minClose * 1.01) tags.push({ text: "创新低", type: "cold" });

        // 4. Volume spike (> 1.8x 20-day avg)
        const recentVols = h.slice(-21, -1).map((d) => d.volume);
        if (recentVols.length >= 10) {
            const avgVol = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;
            if (latest.volume > avgVol * 1.8) tags.push({ text: "放量", type: "warn" });
        }

        // 5. MA20 crossover (price crossed above/below 20-day MA)
        if (h.length >= 21) {
            const ma20Today = h.slice(-20).reduce((s, d) => s + d.close, 0) / 20;
            const ma20Yesterday = h.slice(-21, -1).reduce((s, d) => s + d.close, 0) / 20;
            const prevClose = h[h.length - 2].close;
            if (prevClose < ma20Yesterday && latest.close > ma20Today) {
                tags.push({ text: "突破均线", type: "hot" });
            } else if (prevClose > ma20Yesterday && latest.close < ma20Today) {
                tags.push({ text: "跌破均线", type: "cold" });
            }
        }

        // 6. Reversal: bounce (was down 2+ days, now up) / pullback (was up 2+ days, now down)
        if (h.length >= 4 && streak <= 1) {
            let prevStreak = 0;
            let prevDir = 0;
            const startIdx = h.length - 2; // start from the day before latest
            for (let i = startIdx; i >= 1; i--) {
                const diff = h[i].close - h[i - 1].close;
                if (i === startIdx) {
                    prevDir = diff > 0 ? 1 : diff < 0 ? -1 : 0;
                    if (prevDir === 0) break;
                    prevStreak = 1;
                } else {
                    if ((prevDir === 1 && diff > 0) || (prevDir === -1 && diff < 0)) {
                        prevStreak++;
                    } else {
                        break;
                    }
                }
            }
            if (prevDir === -1 && prevStreak >= 2 && stock.yesterday.change > 0) {
                tags.push({ text: "反弹", type: "warn" });
            } else if (prevDir === 1 && prevStreak >= 2 && stock.yesterday.change < 0) {
                tags.push({ text: "回调", type: "warn" });
            }
        }

        return tags.slice(0, 3); // Max 3 tags per card
    }

    function buildCardHTML(stock) {
        const isPositive = stock.yesterday.change >= 0;
        const arrow = isPositive ? "\u25B2" : "\u25BC";
        const changeClass = isPositive ? "positive" : "negative";
        const sign = isPositive ? "+" : "";
        const volume = formatVolume(stock.yesterday.volume);
        const tags = getTrendTags(stock);
        const tagsHTML = tags.length
            ? `<div class="card-tags">${tags.map((t) => `<span class="tag tag-${t.type}">${t.text}</span>`).join("")}</div>`
            : "";

        const watched = isWatched(stock.symbol);

        return `
            <div class="stock-card ${watched ? "watched" : ""}" data-symbol="${stock.symbol}" onclick="window.__selectStock('${stock.symbol}')">
                <button class="watch-btn ${watched ? "active" : ""}" onclick="event.stopPropagation(); window.__toggleWatch('${stock.symbol}')" title="${watched ? "取消自选" : "加入自选"}">${watched ? "★" : "☆"}</button>
                <div class="card-top">
                    <div>
                        <div class="symbol">${stock.symbol}</div>
                        <div class="name">${stock.name}</div>
                    </div>
                    <div class="card-price-group">
                        <div class="price">$${stock.yesterday.close.toFixed(2)}</div>
                        <span class="change ${changeClass}">
                            ${arrow} ${sign}${stock.yesterday.change_percent.toFixed(2)}%
                        </span>
                    </div>
                </div>
                ${tagsHTML}
                <div class="sparkline-container">
                    <canvas class="sparkline" data-symbol="${stock.symbol}"></canvas>
                </div>
                <div class="volume">成交量: ${volume}</div>
            </div>
        `;
    }

    // === Sparkline Charts ===

    const sparklineCharts = {};

    function getSparklineData(stock) {
        if (sparklineMode === "intraday") {
            const intraday = stock.intraday || [];
            if (intraday.length > 0) {
                return { labels: intraday.map((d) => d.time), prices: intraday.map((d) => d.close) };
            }
            // Fallback to 30-day daily
            const history = stock.history.slice(-30);
            return { labels: history.map((d) => d.date), prices: history.map((d) => d.close) };
        } else if (sparklineMode === "daily") {
            const history = stock.history.slice(-30);
            return { labels: history.map((d) => d.date), prices: history.map((d) => d.close) };
        } else {
            // monthly: sample ~1 point per month from history (last 12 months)
            const history = stock.history;
            const monthly = [];
            let lastMonth = "";
            for (const d of history) {
                const month = d.date.slice(0, 7); // "YYYY-MM"
                if (month !== lastMonth) {
                    monthly.push(d);
                    lastMonth = month;
                }
            }
            // Take last 12 months
            const sliced = monthly.slice(-12);
            return { labels: sliced.map((d) => d.date), prices: sliced.map((d) => d.close) };
        }
    }

    function renderSparklines(stocks, container) {
        const root = container || document;
        stocks.forEach((stock) => {
            const canvas = root.querySelector(`.sparkline[data-symbol="${stock.symbol}"]`);
            if (!canvas) return;

            const { labels, prices } = getSparklineData(stock);

            const isUp = prices.length >= 2 && prices[prices.length - 1] >= prices[0];
            const lineColor = isUp ? "#059669" : "#dc2626";
            const bgColor = isUp ? "rgba(5, 150, 105, 0.1)" : "rgba(220, 38, 38, 0.08)";

            if (sparklineCharts[stock.symbol]) {
                sparklineCharts[stock.symbol].destroy();
            }

            sparklineCharts[stock.symbol] = new Chart(canvas, {
                type: "line",
                data: {
                    labels,
                    datasets: [{
                        data: prices,
                        borderColor: lineColor,
                        backgroundColor: bgColor,
                        borderWidth: 1.5,
                        pointRadius: 0,
                        fill: true,
                        tension: 0.3,
                    }],
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false }, tooltip: { enabled: false } },
                    scales: {
                        x: { display: false },
                        y: { display: false },
                    },
                    animation: { duration: 0 },
                },
            });
        });
    }

    // === Index Overview Chart ===

    function showIndicesChart() {
        isIndexView = true;
        selectedStock = null;

        // Hide back button
        document.getElementById("backToIndices").classList.remove("visible");

        // Clear active card
        document.querySelectorAll(".stock-card").forEach((c) => c.classList.remove("active"));

        // Update header
        document.getElementById("chartStockSymbol").textContent = "";
        document.getElementById("chartStockName").textContent = "美股三大指数";

        // Render index summary in details
        renderIndexDetails();

        // Draw chart
        updateIndexChart();
    }

    window.__showIndices = showIndicesChart;

    function renderIndexDetails() {
        const indices = stockData.indices || [];
        const html = indices.map((idx) => {
            const d = idx.yesterday;
            const sign = d.change >= 0 ? "+" : "";
            const cls = d.change >= 0 ? "positive" : "negative";
            return `<span class="idx-tag ${cls}"><b>${idx.name}</b> $${d.close.toFixed(2)} ${sign}${d.change_percent.toFixed(2)}%</span>`;
        }).join("");
        document.getElementById("chartDetails").innerHTML = html;
    }

    function getCutoffDate(range, refDate) {
        const cutoff = new Date(refDate);
        switch (range) {
            case "D5": cutoff.setDate(cutoff.getDate() - 90); break;
            case "1W": cutoff.setDate(cutoff.getDate() - 7); break;
            case "1M": cutoff.setMonth(cutoff.getMonth() - 1); break;
            case "3M": cutoff.setMonth(cutoff.getMonth() - 3); break;
            case "6M": cutoff.setMonth(cutoff.getMonth() - 6); break;
            case "1Y": cutoff.setFullYear(cutoff.getFullYear() - 1); break;
            default: cutoff.setMonth(cutoff.getMonth() - 3);
        }
        return cutoff;
    }

    function updateIndexChart() {
        const indices = stockData.indices || [];
        if (!indices.length) return;

        if (selectedRange === "1D") {
            updateIndexIntradayChart(indices);
        } else {
            updateIndexDailyChart(indices);
        }
    }

    function updateIndexIntradayChart(indices) {
        // Use intraday data — normalize to % change from prev_close
        const datasets = indices.map((idx, i) => {
            const intraday = idx.intraday || [];
            const base = idx.yesterday.prev_close;
            return {
                label: idx.name,
                data: intraday.map((d) => ((d.close - base) / base * 100)),
                borderColor: INDEX_COLORS[i].line,
                backgroundColor: INDEX_COLORS[i].bg,
                borderWidth: 2,
                pointRadius: 0,
                pointHoverRadius: 4,
                pointHoverBackgroundColor: INDEX_COLORS[i].line,
                fill: false,
                tension: 0.3,
            };
        });

        const labels = (indices[0].intraday || []).map((d) => d.time);
        drawIndexChart(labels, datasets, true);
    }

    function updateIndexDailyChart(indices) {
        const refHistory = indices[0].history;
        const refDate = new Date(refHistory[refHistory.length - 1].date);
        const cutoff = getCutoffDate(selectedRange, refDate);

        const datasets = indices.map((idx, i) => {
            const filtered = idx.history.filter((d) => new Date(d.date) >= cutoff);
            const basePrice = filtered.length > 0 ? filtered[0].close : 1;
            return {
                label: idx.name,
                data: filtered.map((d) => ((d.close - basePrice) / basePrice * 100)),
                borderColor: INDEX_COLORS[i].line,
                backgroundColor: INDEX_COLORS[i].bg,
                borderWidth: 2,
                pointRadius: 0,
                pointHoverRadius: 4,
                pointHoverBackgroundColor: INDEX_COLORS[i].line,
                fill: false,
                tension: 0.2,
            };
        });

        const filtered0 = indices[0].history.filter((d) => new Date(d.date) >= cutoff);
        const labels = filtered0.map((d) => d.date);
        drawIndexChart(labels, datasets, false);
    }

    function drawIndexChart(labels, datasets, isIntraday) {
        const ctx = document.getElementById("stockChart").getContext("2d");
        if (chart) chart.destroy();

        chart = new Chart(ctx, {
            type: "line",
            data: { labels, datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { intersect: false, mode: "index" },
                plugins: {
                    legend: {
                        display: true,
                        position: "top",
                        align: "end",
                        labels: {
                            color: "#4b5563",
                            font: { size: 12, weight: "600" },
                            boxWidth: 12,
                            boxHeight: 2,
                            padding: 16,
                        },
                    },
                    tooltip: {
                        backgroundColor: "#ffffff",
                        titleColor: "#111827",
                        bodyColor: "#111827",
                        borderColor: "#e2e5ea",
                        borderWidth: 1,
                        padding: 12,
                        callbacks: {
                            title: (items) => items[0].label,
                            label: (item) => {
                                const sign = item.parsed.y >= 0 ? "+" : "";
                                return `${item.dataset.label}: ${sign}${item.parsed.y.toFixed(2)}%`;
                            },
                        },
                    },
                },
                scales: {
                    x: {
                        grid: { color: "rgba(0,0,0,0.04)", drawBorder: false },
                        ticks: {
                            color: "#9ca3af",
                            maxTicksLimit: isIntraday ? 12 : 8,
                            maxRotation: 0,
                            callback: function (val) {
                                const lbl = this.getLabelForValue(val);
                                if (isIntraday) return lbl;
                                const parts = lbl.split("-");
                                return `${parts[1]}/${parts[2]}`;
                            },
                        },
                    },
                    y: {
                        grid: { color: "rgba(0,0,0,0.04)", drawBorder: false },
                        ticks: {
                            color: "#9ca3af",
                            callback: (val) => `${val >= 0 ? "+" : ""}${val.toFixed(2)}%`,
                        },
                        position: "right",
                    },
                },
            },
        });
    }

    // === Single Stock Selection ===

    function selectStock(symbol) {
        selectedStock = allStocks.find((s) => s.symbol === symbol);
        if (!selectedStock) return;

        isIndexView = false;

        // Show back button
        document.getElementById("backToIndices").classList.add("visible");

        // Update active card
        document.querySelectorAll(".stock-card").forEach((card) => {
            card.classList.toggle("active", card.dataset.symbol === symbol);
        });

        // Update chart header
        document.getElementById("chartStockSymbol").textContent = selectedStock.symbol;
        document.getElementById("chartStockName").textContent = selectedStock.name;

        updateSingleChart();
        renderDetails();

        // Scroll to chart if out of view
        const chartEl = document.querySelector(".chart-section");
        const rect = chartEl.getBoundingClientRect();
        if (rect.top < 0) {
            chartEl.scrollIntoView({ behavior: "smooth", block: "start" });
        }
    }

    window.__selectStock = selectStock;

    // === Single Stock Chart ===

    function getFilteredHistory(range) {
        if (!selectedStock) return [];
        const history = selectedStock.history;
        const now = new Date(history[history.length - 1].date);
        const cutoff = getCutoffDate(range, now);
        return history.filter((d) => new Date(d.date) >= cutoff);
    }

    // === Candlestick Plugin ===

    const candlestickWicks = {
        id: "candlestickWicks",
        afterDatasetsDraw(chart) {
            const meta = chart.getDatasetMeta(0);
            if (!meta || !chart._ohlcData) return;
            const ctx = chart.ctx;
            const data = chart._ohlcData;
            meta.data.forEach((bar, i) => {
                const d = data[i];
                if (!d) return;
                const x = bar.x;
                const yHigh = chart.scales.y.getPixelForValue(d.high);
                const yLow = chart.scales.y.getPixelForValue(d.low);
                ctx.save();
                ctx.beginPath();
                ctx.strokeStyle = d.close >= d.open ? "#059669" : "#dc2626";
                ctx.lineWidth = 1;
                ctx.moveTo(x, yHigh);
                ctx.lineTo(x, yLow);
                ctx.stroke();
                ctx.restore();
            });
        },
    };

    function drawCandlestickChart(data) {
        const labels = data.map((d) => d.date);
        const bodies = data.map((d) => [Math.min(d.open, d.close), Math.max(d.open, d.close)]);
        const bgColors = data.map((d) => d.close >= d.open ? "#059669" : "#dc2626");

        const allHighs = data.map((d) => d.high);
        const allLows = data.map((d) => d.low);
        const maxPrice = Math.max(...allHighs);
        const minPrice = Math.min(...allLows);
        const padding = (maxPrice - minPrice) * 0.08 || 1;
        const yMin = minPrice - padding;
        const yMax = maxPrice + padding;

        const ctx = document.getElementById("stockChart").getContext("2d");
        if (chart) chart.destroy();

        chart = new Chart(ctx, {
            type: "bar",
            data: {
                labels,
                datasets: [{
                    data: bodies,
                    backgroundColor: bgColors,
                    borderColor: bgColors,
                    borderWidth: 1,
                    barPercentage: 0.7,
                    categoryPercentage: 0.9,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { intersect: false, mode: "index" },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: "#ffffff",
                        titleColor: "#111827",
                        bodyColor: "#111827",
                        borderColor: "#e2e5ea",
                        borderWidth: 1,
                        padding: 12,
                        displayColors: false,
                        callbacks: {
                            title: (items) => {
                                const parts = items[0].label.split("-");
                                return `${parts[0]}-${parts[1]}-${parts[2]}`;
                            },
                            label: (item) => {
                                const d = data[item.dataIndex];
                                const sign = d.close >= d.open ? "+" : "";
                                const chg = ((d.close - d.open) / d.open * 100).toFixed(2);
                                return [
                                    `开: $${d.open.toFixed(2)}`,
                                    `高: $${d.high.toFixed(2)}`,
                                    `低: $${d.low.toFixed(2)}`,
                                    `收: $${d.close.toFixed(2)}`,
                                    `幅: ${sign}${chg}%`,
                                ];
                            },
                        },
                    },
                },
                scales: {
                    x: {
                        grid: { color: "rgba(0,0,0,0.04)", drawBorder: false },
                        ticks: {
                            color: "#9ca3af",
                            maxTicksLimit: 8,
                            maxRotation: 0,
                            callback: function (val) {
                                const lbl = this.getLabelForValue(val);
                                const parts = lbl.split("-");
                                return `${parts[1]}/${parts[2]}`;
                            },
                        },
                    },
                    y: {
                        min: yMin,
                        max: yMax,
                        grid: { color: "rgba(0,0,0,0.04)", drawBorder: false },
                        ticks: {
                            color: "#9ca3af",
                            callback: (val) => `$${val.toFixed(val >= 100 ? 0 : 2)}`,
                        },
                        position: "right",
                    },
                },
            },
            plugins: [candlestickWicks],
        });
        chart._ohlcData = data;
    }

    function updateSingleChart() {
        const isIntraday = selectedRange === "1D";

        if (!isIntraday) {
            const filtered = getFilteredHistory(selectedRange);
            if (filtered.length) {
                drawCandlestickChart(filtered);
                return;
            }
        }

        const intraday = selectedStock.intraday || [];
        const labels = intraday.map((d) => d.time);
        const prices = intraday.map((d) => d.close);

        const isUp = prices.length >= 2 && prices[prices.length - 1] >= prices[0];
        const lineColor = isUp ? "#059669" : "#dc2626";
        const bgColor = isUp ? "rgba(5, 150, 105, 0.06)" : "rgba(220, 38, 38, 0.04)";

        const ctx = document.getElementById("stockChart").getContext("2d");
        if (chart) chart.destroy();

        chart = new Chart(ctx, {
            type: "line",
            data: {
                labels,
                datasets: [{
                    label: selectedStock.symbol,
                    data: prices,
                    borderColor: lineColor,
                    backgroundColor: bgColor,
                    borderWidth: 2,
                    pointRadius: 0,
                    pointHoverRadius: 5,
                    pointHoverBackgroundColor: lineColor,
                    fill: true,
                    tension: 0.3,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { intersect: false, mode: "index" },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: "#ffffff",
                        titleColor: "#111827",
                        bodyColor: "#111827",
                        borderColor: "#e2e5ea",
                        borderWidth: 1,
                        padding: 12,
                        displayColors: false,
                        callbacks: {
                            title: (items) => items[0].label,
                            label: (item) => `$${item.parsed.y.toFixed(2)}`,
                        },
                    },
                },
                scales: {
                    x: {
                        grid: { color: "rgba(0,0,0,0.04)", drawBorder: false },
                        ticks: {
                            color: "#9ca3af",
                            maxTicksLimit: 12,
                            maxRotation: 0,
                        },
                    },
                    y: {
                        grid: { color: "rgba(0,0,0,0.04)", drawBorder: false },
                        ticks: {
                            color: "#9ca3af",
                            callback: (val) => `$${val.toFixed(2)}`,
                        },
                        position: "right",
                    },
                },
            },
        });
    }

    function renderDetails() {
        const d = selectedStock.yesterday;
        const changeClass = d.change >= 0 ? "positive" : "negative";
        const sign = d.change >= 0 ? "+" : "";

        document.getElementById("chartDetails").innerHTML = `
            <span class="detail-price">$${d.close.toFixed(2)}</span>
            <span class="detail-change ${changeClass}">${sign}${d.change.toFixed(2)} (${sign}${d.change_percent.toFixed(2)}%)</span>
            <span class="detail-sep"></span>
            <span class="detail-kv">开 <b>$${d.open.toFixed(2)}</b></span>
            <span class="detail-kv">高 <b>$${d.high.toFixed(2)}</b></span>
            <span class="detail-kv">低 <b>$${d.low.toFixed(2)}</b></span>
            <span class="detail-kv">量 <b>${formatVolume(d.volume)}</b></span>
        `;
    }

    // === Time Range Buttons ===

    function setupTimeRangeButtons() {
        document.getElementById("timeRangeButtons").addEventListener("click", (e) => {
            const btn = e.target.closest(".range-btn");
            if (!btn) return;

            selectedRange = btn.dataset.range;
            document.querySelectorAll(".range-btn").forEach((b) => b.classList.remove("active"));
            btn.classList.add("active");

            if (isIndexView) {
                updateIndexChart();
            } else {
                updateSingleChart();
            }
        });
    }

    // === Filter & Sort ===

    function setupFilterButtons() {
        document.getElementById("categoryFilters").addEventListener("click", (e) => {
            const btn = e.target.closest(".filter-btn");
            if (!btn) return;

            activeCategory = btn.dataset.category;
            document.querySelectorAll(".filter-btn").forEach((b) => b.classList.remove("active"));
            btn.classList.add("active");

            // Clear sort when switching category
            activeSort = null;
            document.querySelectorAll(".sort-btn").forEach((b) => b.classList.remove("active"));

            applyFilter();
        });

        document.getElementById("sortButtons").addEventListener("click", (e) => {
            const btn = e.target.closest(".sort-btn");
            if (!btn) return;

            const sort = btn.dataset.sort;
            if (activeSort === sort) {
                // Toggle off
                activeSort = null;
                btn.classList.remove("active");
            } else {
                activeSort = sort;
                document.querySelectorAll(".sort-btn").forEach((b) => b.classList.remove("active"));
                btn.classList.add("active");
            }

            applyFilter();
        });
    }

    function applyFilter() {
        const twoCol = document.getElementById("twoColSection");
        const rankedEl = document.getElementById("rankedSection");

        if (activeCategory === "watchlist" && !activeSort) {
            // Watchlist: single grid view
            twoCol.style.display = "none";
            rankedEl.style.display = "block";
            renderRankedView();
        } else if (activeCategory === "all" && !activeSort) {
            // Default two-column view
            twoCol.style.display = "";
            rankedEl.style.display = "none";
            renderStockGrid("usStockGrid", stockData.us_stocks || []);
            renderStockGrid("cnStockGrid", stockData.cn_stocks || []);
        } else {
            // Single grid for any filter/sort/category
            twoCol.style.display = "none";
            rankedEl.style.display = "block";
            renderRankedView();
        }

        renderStatsBar();
    }

    function getFilteredStocks() {
        let stocks;
        if (activeCategory === "watchlist") {
            const watchlist = getWatchlist();
            stocks = [...(stockData.us_stocks || []), ...(stockData.cn_stocks || [])].filter(
                (s) => watchlist.includes(s.symbol)
            );
        } else if (activeCategory === "all") {
            stocks = [...(stockData.us_stocks || []), ...(stockData.cn_stocks || [])];
        } else if (activeCategory === "cn") {
            stocks = [...(stockData.cn_stocks || [])];
        } else {
            const symbols = CATEGORIES[activeCategory] || [];
            stocks = (stockData.us_stocks || []).filter((s) => symbols.includes(s.symbol));
        }
        return stocks;
    }

    function renderStatsBar() {
        const stocks = getFilteredStocks();
        if (!stocks.length) {
            document.getElementById("statsContent").innerHTML = "";
            return;
        }

        const upCount = stocks.filter((s) => s.yesterday.change > 0).length;
        const downCount = stocks.filter((s) => s.yesterday.change < 0).length;
        const flatCount = stocks.length - upCount - downCount;
        const upPct = ((upCount / stocks.length) * 100).toFixed(0);
        const downPct = ((downCount / stocks.length) * 100).toFixed(0);

        const sorted = [...stocks].sort((a, b) => b.yesterday.change_percent - a.yesterday.change_percent);
        const best = sorted[0];
        const worst = sorted[sorted.length - 1];

        const avgChange = stocks.reduce((sum, s) => sum + s.yesterday.change_percent, 0) / stocks.length;

        const bestSign = best.yesterday.change_percent >= 0 ? "+" : "";
        const worstSign = worst.yesterday.change_percent >= 0 ? "+" : "";
        const avgSign = avgChange >= 0 ? "+" : "";

        document.getElementById("statsContent").innerHTML = `
            <div class="stat-item">
                <span class="stat-label">上涨</span>
                <span class="stat-value positive">${upCount}</span>
                <span class="stat-label">(${upPct}%)</span>
            </div>
            <div class="stat-bar-visual">
                <div class="bar-up" style="flex:${upCount}"></div>
                <div class="bar-flat" style="flex:${flatCount}"></div>
                <div class="bar-down" style="flex:${downCount}"></div>
            </div>
            <div class="stat-item">
                <span class="stat-label">下跌</span>
                <span class="stat-value negative">${downCount}</span>
                <span class="stat-label">(${downPct}%)</span>
            </div>
            <div class="stat-item">
                <span class="stat-label">平均涨幅</span>
                <span class="stat-value ${avgChange >= 0 ? "positive" : "negative"}">${avgSign}${avgChange.toFixed(2)}%</span>
            </div>
            <div class="stat-item">
                <span class="stat-label">最大涨幅</span>
                <span class="stat-value positive">${best.symbol} ${bestSign}${best.yesterday.change_percent.toFixed(2)}%</span>
            </div>
            <div class="stat-item">
                <span class="stat-label">最大跌幅</span>
                <span class="stat-value negative">${worst.symbol} ${worstSign}${worst.yesterday.change_percent.toFixed(2)}%</span>
            </div>
        `;
    }

    function renderRankedView() {
        let stocks = getFilteredStocks();

        const sortLabels = { top: "涨幅榜", bottom: "跌幅榜", up: "上涨", down: "下跌" };
        const catLabels = { watchlist: "自选", mag7: "七巨头", semi: "半导体", software: "软件云", internet: "互联网", fintech: "金融科技", cn: "中概股", all: "全部" };

        if (activeSort === "top") {
            stocks.sort((a, b) => b.yesterday.change_percent - a.yesterday.change_percent);
        } else if (activeSort === "bottom") {
            stocks.sort((a, b) => a.yesterday.change_percent - b.yesterday.change_percent);
        } else if (activeSort === "up") {
            stocks = stocks.filter((s) => s.yesterday.change > 0);
            stocks.sort((a, b) => b.yesterday.change_percent - a.yesterday.change_percent);
        } else if (activeSort === "down") {
            stocks = stocks.filter((s) => s.yesterday.change < 0);
            stocks.sort((a, b) => a.yesterday.change_percent - b.yesterday.change_percent);
        } else {
            stocks = sortWithWatchlistFirst(stocks);
        }

        const title = activeSort
            ? (sortLabels[activeSort] + (activeCategory !== "all" ? " · " + catLabels[activeCategory] : ""))
            : (catLabels[activeCategory] || "");

        const rankedEl = document.getElementById("rankedSection");
        rankedEl.innerHTML = `
            <h2 class="section-title">${title} <span class="market-date">${stocks.length} 只</span></h2>
            <div class="ranked-grid" id="rankedGrid"></div>
        `;

        const grid = document.getElementById("rankedGrid");
        grid.innerHTML = stocks.length
            ? stocks.map((stock) => buildCardHTML(stock)).join("")
            : '<div class="error-message">暂无符合条件的股票</div>';
        if (stocks.length) renderSparklines(stocks, grid);
    }

    // === Utils ===

    function formatVolume(vol) {
        if (vol >= 1e9) return (vol / 1e9).toFixed(2) + "B";
        if (vol >= 1e6) return (vol / 1e6).toFixed(2) + "M";
        if (vol >= 1e3) return (vol / 1e3).toFixed(1) + "K";
        return vol.toString();
    }

    // === Init ===

    function setupSparklineToggle() {
        document.getElementById("sparklineToggle").addEventListener("click", (e) => {
            const btn = e.target.closest(".spark-btn");
            if (!btn) return;

            sparklineMode = btn.dataset.spark;
            document.querySelectorAll(".spark-btn").forEach((b) => b.classList.remove("active"));
            btn.classList.add("active");

            // Re-render all visible sparklines
            applyFilter();
        });
    }

    function init() {
        setupTimeRangeButtons();
        setupFilterButtons();
        setupSparklineToggle();

        document.addEventListener("click", (e) => {
            if (!isIndexView && !e.target.closest(".stock-card") && !e.target.closest(".chart-section") && !e.target.closest(".filter-bar") && !e.target.closest(".stats-bar")) {
                showIndicesChart();
            }
        });

        loadData();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
