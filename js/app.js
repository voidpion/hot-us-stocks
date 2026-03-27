(() => {
    "use strict";

    let stockData = null;
    let allStocks = [];
    let chart = null;
    let selectedStock = null;
    let selectedRange = "D5";
    let isIndexView = true;
    let activeCategory = "all";
    let activeSort = null;
    let activeTags = new Set(); // active tag filter texts
    let sparklineMode = "intraday"; // "intraday" | "daily" | "monthly"
    let activeIndexIdx = -1; // which index is selected (-1 = auto-detect QQQ)

    // === Color Mode ===
    const COLOR_MODE_KEY = "hot-us-stocks-color-mode";

    function getColors() {
        const style = getComputedStyle(document.documentElement);
        return {
            green: style.getPropertyValue("--green").trim(),
            red: style.getPropertyValue("--red").trim(),
        };
    }

    function setupColorMode() {
        // Restore saved preference
        if (localStorage.getItem(COLOR_MODE_KEY) === "cn") {
            document.documentElement.classList.add("cn-color");
        }

        document.getElementById("colorModeBtn").addEventListener("click", () => {
            document.documentElement.classList.toggle("cn-color");
            const isCN = document.documentElement.classList.contains("cn-color");
            localStorage.setItem(COLOR_MODE_KEY, isCN ? "cn" : "us");
            // Re-render everything that uses colors
            applyFilter();
            if (isIndexView) {
                showIndicesChart();
            } else if (selectedStock) {
                updateSingleChart();
            }
        });
    }

    // === Watchlist (localStorage) ===
    const WATCHLIST_KEY = "hot-us-stocks-watchlist";

    function getWatchlist() {
        try {
            return JSON.parse(localStorage.getItem(WATCHLIST_KEY)) || [];
        } catch { return []; }
    }

    let pendingReorder = null;

    function toggleWatchlist(symbol) {
        const list = getWatchlist();
        const idx = list.indexOf(symbol);
        if (idx >= 0) {
            list.splice(idx, 1);
        } else {
            list.push(symbol);
        }
        localStorage.setItem(WATCHLIST_KEY, JSON.stringify(list));

        // Update star UI in place
        document.querySelectorAll(`.stock-card[data-symbol="${symbol}"]`).forEach((card) => {
            const btn = card.querySelector(".watch-btn");
            const watched = idx < 0;
            card.classList.toggle("watched", watched);
            if (btn) {
                btn.classList.toggle("active", watched);
                btn.textContent = watched ? "★" : "☆";
                btn.title = watched ? "取消自选" : "加入自选";
            }

            // Schedule reorder on mouseleave
            if (pendingReorder) {
                card.removeEventListener("mouseleave", pendingReorder);
            }
            pendingReorder = function handler() {
                card.removeEventListener("mouseleave", handler);
                pendingReorder = null;
                card.classList.add("card-fly-out");
                card.addEventListener("animationend", () => {
                    applyFilter();
                    // Highlight the moved card at its new position
                    const target = document.querySelector(`.stock-card[data-symbol="${symbol}"]`);
                    if (target && watched) {
                        target.classList.add("card-spotlight");
                        target.addEventListener("animationend", () => target.classList.remove("card-spotlight"), { once: true });
                    }
                    // Animate all cards in
                    document.querySelectorAll(".stock-card").forEach((c) => {
                        c.classList.add("card-fly-in");
                        c.addEventListener("animationend", () => c.classList.remove("card-fly-in"), { once: true });
                    });
                }, { once: true });
            };
            card.addEventListener("mouseleave", pendingReorder);
        });
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

    // Populated from data/stocks.json at runtime, with fallback
    const DEFAULT_CATEGORIES = {
        mag7: ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"],
        semi: ["AMD", "AVGO", "INTC", "QCOM", "MU", "TSM", "ARM", "MRVL", "SMCI", "DELL", "WDC"],
        software: ["CRM", "ORCL", "ADBE", "NOW", "PLTR", "SNOW", "CRWD", "PANW"],
        internet: ["NFLX", "UBER", "ABNB", "SNAP", "SPOT", "SHOP", "RBLX", "RIVN"],
        fintech: ["V", "PYPL", "SQ", "COIN"],
    };
    let CATEGORIES = DEFAULT_CATEGORIES;

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
            // Build CATEGORIES from JSON data (fallback to defaults)
            const cats = stockData.categories;
            if (cats && Object.keys(cats).length) {
                CATEGORIES = {};
                for (const [key, val] of Object.entries(cats)) {
                    CATEGORIES[key] = val.symbols || [];
                }
            }
            render();
        } catch (err) {
            usGrid.innerHTML = `<div class="error-message">${err.message}</div>`;
        }
    }

    // === Rendering ===

    function render() {
        renderHeader();
        renderInfoBar();
        buildTagFilterBar();
        renderStockGrid("usStockGrid", stockData.us_stocks || []);
        renderStockGrid("cnStockGrid", stockData.cn_stocks || []);
        renderStatsBar();
        // Default: show indices overview
        showIndicesChart();
    }

    function renderInfoBar() {
        // Market summary
        const summary = stockData.market_summary || "";
        document.getElementById("infoSummary").innerHTML = `<span class="summary-label">综述</span><div class="summary-text">${summary}</div>`;

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

            const isUp = stock.yesterday.change >= 0;
            const c = getColors();
            const lineColor = isUp ? c.green : c.red;
            const bgColor = isUp ? c.green + "1a" : c.red + "14";

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

    const INDEX_ORDER = ["QQQ", ".IXIC", "DIA", ".DJI"];

    function renderIndexDetails() {
        const indices = stockData.indices || [];
        // Sort: NASDAQ first, then Dow, then rest
        indices.sort((a, b) => {
            const ai = INDEX_ORDER.indexOf(a.symbol);
            const bi = INDEX_ORDER.indexOf(b.symbol);
            return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
        });
        // Default to first (NASDAQ) if not set
        if (activeIndexIdx < 0) {
            activeIndexIdx = 0;
        }
        const html = indices.map((idx, i) => {
            const d = idx.yesterday;
            const sign = d.change >= 0 ? "+" : "";
            const cls = d.change >= 0 ? "positive" : "negative";
            const active = i === activeIndexIdx ? " active" : "";
            return `<span class="idx-tag ${cls}${active}" data-idx="${i}"><b>${idx.name}</b> ${sign}${d.change_percent.toFixed(2)}%</span>`;
        }).join("");
        document.getElementById("chartDetails").innerHTML = html;
    }

    function setupIndexToggle() {
        document.getElementById("chartDetails").addEventListener("click", (e) => {
            const tag = e.target.closest(".idx-tag");
            if (!tag || !isIndexView) return;
            activeIndexIdx = parseInt(tag.dataset.idx);
            const el = document.getElementById("chartDetails");
            el.querySelectorAll(".idx-tag").forEach((t, i) => t.classList.toggle("active", i === activeIndexIdx));
            updateIndexChart();
        });
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
        const idx = indices[activeIndexIdx] || indices[0];
        const intraday = idx.intraday || [];
        const base = idx.yesterday.prev_close;
        const prices = intraday.map((d) => d.close);
        const labels = intraday.map((d) => d.time);

        const isUp = idx.yesterday.change >= 0;
        const cc = getColors();
        const lineColor = isUp ? cc.green : cc.red;
        const bgColor = isUp ? cc.green + "0f" : cc.red + "0a";

        const ctx = document.getElementById("stockChart").getContext("2d");
        if (chart) chart.destroy();

        chart = new Chart(ctx, {
            type: "line",
            data: {
                labels,
                datasets: [{
                    label: idx.name,
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
                        callbacks: {
                            label: (item) => `$${item.parsed.y.toFixed(2)}`,
                        },
                    },
                },
                scales: {
                    x: {
                        grid: { color: "rgba(0,0,0,0.04)", drawBorder: false },
                        ticks: { color: "#9ca3af", maxTicksLimit: 12, maxRotation: 0 },
                    },
                    y: {
                        grid: { color: "rgba(0,0,0,0.04)", drawBorder: false },
                        ticks: {
                            color: "#9ca3af",
                            callback: (val) => `$${val.toFixed(val >= 100 ? 0 : 2)}`,
                        },
                        position: "right",
                    },
                },
            },
        });
    }

    function updateIndexDailyChart(indices) {
        const idx = indices[activeIndexIdx] || indices[0];
        const refDate = new Date(idx.history[idx.history.length - 1].date);
        const cutoff = getCutoffDate(selectedRange, refDate);
        const filtered = idx.history.filter((d) => new Date(d.date) >= cutoff);
        if (filtered.length) {
            drawCandlestickChart(filtered);
        }
    }

    // === Single Stock Selection ===

    function selectStock(symbol) {
        // Toggle: click again to deselect
        if (selectedStock && selectedStock.symbol === symbol) {
            showIndicesChart();
            collapseChart();
            return;
        }

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
        expandChart();
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
                const cc = getColors();
                ctx.strokeStyle = d.close >= d.open ? cc.green : cc.red;
                ctx.lineWidth = 1;
                ctx.moveTo(x, yHigh);
                ctx.lineTo(x, yLow);
                ctx.stroke();
                ctx.restore();
            });
        },
    };

    function createCandlestickChart(canvas, data) {
        const labels = data.map((d) => d.date);
        const bodies = data.map((d) => [Math.min(d.open, d.close), Math.max(d.open, d.close)]);
        const cc = getColors();
        const bgColors = data.map((d) => d.close >= d.open ? cc.green : cc.red);

        const allHighs = data.map((d) => d.high);
        const allLows = data.map((d) => d.low);
        const maxPrice = Math.max(...allHighs);
        const minPrice = Math.min(...allLows);
        const padding = (maxPrice - minPrice) * 0.08 || 1;
        const yMin = minPrice - padding;
        const yMax = maxPrice + padding;

        const ctx = canvas.getContext("2d");

        const c = new Chart(ctx, {
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
        c._ohlcData = data;
        return c;
    }

    function drawCandlestickChart(data) {
        const canvas = document.getElementById("stockChart");
        if (chart) chart.destroy();
        chart = createCandlestickChart(canvas, data);
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
        const cc = getColors();
        const lineColor = isUp ? cc.green : cc.red;
        const bgColor = isUp ? cc.green + "0f" : cc.red + "0a";

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

    // === Tag Filter ===

    // Cache: symbol → tags array
    let stockTagsCache = {};

    function buildTagFilterBar() {
        const allNonIndexStocks = [...(stockData.us_stocks || []), ...(stockData.cn_stocks || [])];
        // Collect all unique tags and their types
        const tagMap = new Map(); // text → type
        stockTagsCache = {};
        for (const stock of allNonIndexStocks) {
            const tags = getTrendTags(stock);
            stockTagsCache[stock.symbol] = tags;
            for (const t of tags) {
                // Normalize streak tags: "连涨3天" → "连涨"
                const key = t.text.replace(/\d+天$/, "");
                if (!tagMap.has(key)) tagMap.set(key, t.type);
            }
        }

        const bar = document.getElementById("tagFilterBar");
        const chips = document.getElementById("tagFilterChips");

        if (!tagMap.size) {
            bar.style.display = "none";
            return;
        }

        bar.style.display = "";
        chips.innerHTML = [...tagMap.entries()].map(([text, type]) =>
            `<span class="tag-chip type-${type}" data-tag="${text}">${text}</span>`
        ).join("");
    }

    function setupTagFilter() {
        document.getElementById("tagFilterChips").addEventListener("click", (e) => {
            const chip = e.target.closest(".tag-chip");
            if (!chip) return;
            const tag = chip.dataset.tag;
            if (activeTags.has(tag)) {
                activeTags.delete(tag);
                chip.classList.remove("active");
            } else {
                activeTags.add(tag);
                chip.classList.add("active");
            }
            updateActionBtns();
            applyFilter();
        });

        document.getElementById("tagFilterClear").addEventListener("click", () => {
            activeTags.clear();
            document.querySelectorAll(".tag-chip").forEach((c) => c.classList.remove("active"));
            updateActionBtns();
            applyFilter();
        });

        document.getElementById("tagFilterInvert").addEventListener("click", () => {
            const allTags = [...document.querySelectorAll(".tag-chip")].map((c) => c.dataset.tag);
            const newSet = new Set(allTags.filter((t) => !activeTags.has(t)));
            activeTags = newSet;
            document.querySelectorAll(".tag-chip").forEach((c) => c.classList.toggle("active", activeTags.has(c.dataset.tag)));
            updateActionBtns();
            applyFilter();
        });
    }

    function updateActionBtns() {
        const show = activeTags.size > 0;
        document.getElementById("tagFilterClear").classList.toggle("visible", show);
        document.getElementById("tagFilterInvert").classList.toggle("visible", show);
    }

    function filterByTags(stocks) {
        if (!activeTags.size) return stocks;
        return stocks.filter((s) => {
            const tags = stockTagsCache[s.symbol] || [];
            return tags.some((t) => {
                const key = t.text.replace(/\d+天$/, "");
                return activeTags.has(key);
            });
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
        } else if (activeCategory === "all" && !activeSort && !activeTags.size) {
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
        return filterByTags(stocks);
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

    function expandChart() {
        document.querySelector(".chart-section").classList.add("expanded");
    }

    function collapseChart() {
        document.querySelector(".chart-section").classList.remove("expanded");
    }

    function setupChartCollapse() {
        const section = document.querySelector(".chart-section");
        let collapseTimer = null;

        section.addEventListener("mouseenter", () => {
            clearTimeout(collapseTimer);
            expandChart();
        });

        section.addEventListener("mouseleave", () => {
            collapseTimer = setTimeout(() => {
                collapseChart();
            }, 400);
        });
    }

    function init() {
        setupTimeRangeButtons();
        setupFilterButtons();
        setupSparklineToggle();
        setupColorMode();
        setupIndexToggle();
        setupChartCollapse();
        setupTagFilter();

        document.addEventListener("click", (e) => {
            if (!isIndexView && !e.target.closest(".stock-card") && !e.target.closest(".chart-section") && !e.target.closest(".filter-bar") && !e.target.closest(".stats-bar")) {
                showIndicesChart();
                collapseChart();
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
