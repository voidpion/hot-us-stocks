(() => {
    "use strict";

    let stockData = null;
    let chart = null;
    let selectedStock = null;
    let selectedRange = "3M";

    // === Data Loading ===

    async function loadData() {
        const grid = document.getElementById("stockGrid");
        grid.innerHTML = '<div class="loading">Loading stock data</div>';

        try {
            const resp = await fetch("data/stocks.json");
            if (!resp.ok) throw new Error("Failed to load data. Run `python scripts/fetch_data.py` first.");
            stockData = await resp.json();
            render();
        } catch (err) {
            grid.innerHTML = `<div class="error-message">${err.message}</div>`;
        }
    }

    // === Rendering ===

    function render() {
        renderHeader();
        renderStockCards();
        if (stockData.stocks.length > 0) {
            selectStock(stockData.stocks[0].symbol);
        }
    }

    function renderHeader() {
        document.getElementById("updatedTime").textContent =
            `Last updated: ${stockData.updated_at}`;
        document.getElementById("marketDate").textContent =
            stockData.market_date;
    }

    function renderStockCards() {
        const grid = document.getElementById("stockGrid");
        grid.innerHTML = stockData.stocks.map((stock) => {
            const isPositive = stock.yesterday.change >= 0;
            const arrow = isPositive ? "\u25B2" : "\u25BC";
            const changeClass = isPositive ? "positive" : "negative";
            const volume = formatVolume(stock.yesterday.volume);

            return `
                <div class="stock-card" data-symbol="${stock.symbol}" onclick="window.__selectStock('${stock.symbol}')">
                    <div class="card-top">
                        <div>
                            <div class="symbol">${stock.symbol}</div>
                            <div class="name">${stock.name}</div>
                        </div>
                    </div>
                    <div class="price">$${stock.yesterday.close.toFixed(2)}</div>
                    <span class="change ${changeClass}">
                        ${arrow} ${Math.abs(stock.yesterday.change).toFixed(2)}
                        (${Math.abs(stock.yesterday.change_percent).toFixed(2)}%)
                    </span>
                    <div class="volume">Vol: ${volume}</div>
                </div>
            `;
        }).join("");
    }

    function selectStock(symbol) {
        selectedStock = stockData.stocks.find((s) => s.symbol === symbol);
        if (!selectedStock) return;

        // Update active card
        document.querySelectorAll(".stock-card").forEach((card) => {
            card.classList.toggle("active", card.dataset.symbol === symbol);
        });

        // Update chart header
        document.getElementById("chartStockName").textContent = selectedStock.name;
        document.getElementById("chartStockSymbol").textContent = selectedStock.symbol;

        // Update chart
        updateChart();

        // Update details
        renderDetails();

        // Scroll to chart on mobile
        if (window.innerWidth < 768) {
            document.querySelector(".chart-section").scrollIntoView({ behavior: "smooth", block: "start" });
        }
    }

    // Expose to onclick handlers
    window.__selectStock = selectStock;

    // === Chart ===

    function getFilteredHistory(range) {
        if (!selectedStock) return [];
        const history = selectedStock.history;
        const now = new Date(history[history.length - 1].date);
        let cutoff;

        switch (range) {
            case "1W":
                cutoff = new Date(now);
                cutoff.setDate(cutoff.getDate() - 7);
                break;
            case "1M":
                cutoff = new Date(now);
                cutoff.setMonth(cutoff.getMonth() - 1);
                break;
            case "3M":
                cutoff = new Date(now);
                cutoff.setMonth(cutoff.getMonth() - 3);
                break;
            case "6M":
                cutoff = new Date(now);
                cutoff.setMonth(cutoff.getMonth() - 6);
                break;
            case "1Y":
                cutoff = new Date(now);
                cutoff.setFullYear(cutoff.getFullYear() - 1);
                break;
            default:
                cutoff = new Date(now);
                cutoff.setMonth(cutoff.getMonth() - 3);
        }

        return history.filter((d) => new Date(d.date) >= cutoff);
    }

    function updateChart() {
        const filtered = getFilteredHistory(selectedRange);
        const labels = filtered.map((d) => d.date);
        const prices = filtered.map((d) => d.close);

        // Determine color based on trend
        const isUp = prices.length >= 2 && prices[prices.length - 1] >= prices[0];
        const lineColor = isUp ? "#3fb950" : "#f85149";
        const bgColor = isUp ? "rgba(63, 185, 80, 0.08)" : "rgba(248, 81, 73, 0.08)";

        const ctx = document.getElementById("stockChart").getContext("2d");

        if (chart) {
            chart.destroy();
        }

        chart = new Chart(ctx, {
            type: "line",
            data: {
                labels: labels,
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
                    tension: 0.1,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    intersect: false,
                    mode: "index",
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: "#1c2128",
                        titleColor: "#e6edf3",
                        bodyColor: "#e6edf3",
                        borderColor: "#30363d",
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
                        grid: { color: "rgba(48, 54, 61, 0.5)", drawBorder: false },
                        ticks: {
                            color: "#6e7681",
                            maxTicksLimit: 8,
                            maxRotation: 0,
                            callback: function (val, index) {
                                const label = this.getLabelForValue(val);
                                // Show month-day format
                                const parts = label.split("-");
                                return `${parts[1]}/${parts[2]}`;
                            },
                        },
                    },
                    y: {
                        grid: { color: "rgba(48, 54, 61, 0.5)", drawBorder: false },
                        ticks: {
                            color: "#6e7681",
                            callback: (val) => `$${val.toFixed(0)}`,
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
            <div class="detail-item">
                <div class="label">Open</div>
                <div class="value">$${d.open.toFixed(2)}</div>
            </div>
            <div class="detail-item">
                <div class="label">Close</div>
                <div class="value">$${d.close.toFixed(2)}</div>
            </div>
            <div class="detail-item">
                <div class="label">High</div>
                <div class="value">$${d.high.toFixed(2)}</div>
            </div>
            <div class="detail-item">
                <div class="label">Low</div>
                <div class="value">$${d.low.toFixed(2)}</div>
            </div>
            <div class="detail-item">
                <div class="label">Change</div>
                <div class="value ${changeClass}">${sign}${d.change.toFixed(2)} (${sign}${d.change_percent.toFixed(2)}%)</div>
            </div>
            <div class="detail-item">
                <div class="label">Volume</div>
                <div class="value">${formatVolume(d.volume)}</div>
            </div>
            <div class="detail-item">
                <div class="label">Prev Close</div>
                <div class="value">$${d.prev_close.toFixed(2)}</div>
            </div>
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

            updateChart();
        });
    }

    // === Utils ===

    function formatVolume(vol) {
        if (vol >= 1e9) return (vol / 1e9).toFixed(2) + "B";
        if (vol >= 1e6) return (vol / 1e6).toFixed(2) + "M";
        if (vol >= 1e3) return (vol / 1e3).toFixed(1) + "K";
        return vol.toString();
    }

    // === Init ===

    function init() {
        setupTimeRangeButtons();
        loadData();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
