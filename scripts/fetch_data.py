#!/usr/bin/env python3
"""Fetch popular US stock data and save as JSON.

Uses akshare library which provides reliable access to US stock data.
"""

import json
import os
import re
import ssl
from datetime import datetime, timedelta

import requests
import urllib3

# Disable SSL verification globally for environments with missing CA certificates
ssl._create_default_https_context = ssl._create_unverified_context
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# Monkey-patch requests to disable SSL verification
_original_request = requests.Session.request
def _patched_request(self, *args, **kwargs):
    kwargs.setdefault("verify", False)
    return _original_request(self, *args, **kwargs)
requests.Session.request = _patched_request

import akshare as ak

# US Major Indices (ETF proxies)
INDICES = {
    "SPY": "S&P 500",
    "DIA": "Dow Jones",
    "QQQ": "Nasdaq 100",
}

US_STOCKS = {
    # Magnificent 7
    "AAPL": "Apple",
    "MSFT": "Microsoft",
    "GOOGL": "Alphabet",
    "AMZN": "Amazon",
    "NVDA": "NVIDIA",
    "META": "Meta Platforms",
    "TSLA": "Tesla",
    # Semiconductor
    "AMD": "AMD",
    "AVGO": "Broadcom",
    "INTC": "Intel",
    "QCOM": "Qualcomm",
    "MU": "Micron",
    # Software & Cloud
    "CRM": "Salesforce",
    "ORCL": "Oracle",
    "ADBE": "Adobe",
    "NOW": "ServiceNow",
    # Internet & Media
    "NFLX": "Netflix",
    "UBER": "Uber",
    "ABNB": "Airbnb",
    "SNAP": "Snap",
    # Fintech & Payments
    "V": "Visa",
    "PYPL": "PayPal",
    "SQ": "Block",
    "COIN": "Coinbase",
}

CN_STOCKS = {
    "BABA": "阿里巴巴",
    "PDD": "拼多多",
    "JD": "京东",
    "BIDU": "百度",
    "NIO": "蔚来",
    "XPEV": "小鹏汽车",
    "LI": "理想汽车",
    "TME": "腾讯音乐",
    "BILI": "哔哩哔哩",
    "IQ": "爱奇艺",
    "ZH": "知乎",
    "FUTU": "富途控股",
}

OUTPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")


def fetch_stock_data(symbol: str, name: str) -> dict | None:
    """Fetch historical data for a single US stock via akshare."""
    try:
        # akshare provides US stock daily data via stock_us_daily
        # The symbol format for akshare is the raw ticker (e.g., "AAPL")
        end_date = datetime.now().strftime("%Y%m%d")
        start_date = (datetime.now() - timedelta(days=400)).strftime("%Y%m%d")

        try:
            df = ak.stock_us_daily(symbol=symbol, adjust="qfq")
        except Exception:
            # Fallback: fetch without adjustment if qfq fails
            df = ak.stock_us_daily(symbol=symbol, adjust="")

        if df is None or df.empty:
            print(f"  Warning: No data for {symbol}")
            return None

        # Make a writable copy to avoid read-only array issues
        df = df.copy()

        # akshare returns columns: date, open, high, low, close, volume
        # Filter to last ~365 days
        cutoff = datetime.now() - timedelta(days=365)
        df["date"] = df["date"].astype(str)
        df = df[df["date"] >= cutoff.strftime("%Y-%m-%d")]
        df = df.sort_values("date").reset_index(drop=True)

        if len(df) < 2:
            print(f"  Warning: Not enough data for {symbol}")
            return None

        # Build history list
        history = []
        for _, row in df.iterrows():
            history.append({
                "date": str(row["date"]),
                "open": round(float(row["open"]), 2),
                "high": round(float(row["high"]), 2),
                "low": round(float(row["low"]), 2),
                "close": round(float(row["close"]), 2),
                "volume": int(row["volume"]),
            })

        # Yesterday's data (last trading day)
        latest = history[-1]
        prev = history[-2]
        change = round(latest["close"] - prev["close"], 2)
        change_percent = round((change / prev["close"]) * 100, 2) if prev["close"] != 0 else 0

        # Fetch intraday data
        intraday = fetch_intraday(symbol)

        return {
            "symbol": symbol,
            "name": name,
            "yesterday": {
                "date": latest["date"],
                "open": latest["open"],
                "close": latest["close"],
                "high": latest["high"],
                "low": latest["low"],
                "volume": latest["volume"],
                "change": change,
                "change_percent": change_percent,
                "prev_close": prev["close"],
            },
            "history": history,
            "intraday": intraday,
        }
    except Exception as e:
        print(f"  Error fetching {symbol}: {e}")
        return None


def fetch_intraday(symbol: str) -> list[dict]:
    """Fetch 5-min intraday data for last trading day from Sina Finance."""
    try:
        url = (
            f"https://stock.finance.sina.com.cn/usstock/api/jsonp_v2.php/"
            f"var/US_MinKService.getMinK?symbol={symbol.lower()}&type=5"
        )
        r = requests.get(url, timeout=15)
        match = re.search(r"var\((.*)\)", r.text, re.DOTALL)
        if not match:
            return []
        data = json.loads(match.group(1))
        if not data:
            return []

        # Find the last complete trading day (the one before today if market is open)
        # Group by date
        dates = sorted(set(d["d"].split(" ")[0] for d in data))
        # Use the second-to-last date if there's more than one, to get a full day
        # If today has data, use the previous full day; otherwise use the last date
        if len(dates) >= 2:
            target_date = dates[-2] if len([d for d in data if d["d"].startswith(dates[-1])]) < 60 else dates[-1]
        else:
            target_date = dates[-1]

        day_data = [d for d in data if d["d"].startswith(target_date)]
        return [{
            "time": d["d"].split(" ")[1][:5],  # "09:35"
            "close": round(float(d["c"]), 2),
            "volume": int(d["v"]),
        } for d in day_data]
    except Exception as e:
        print(f"    Intraday error for {symbol}: {e}")
        return []


def fetch_group(stock_dict: dict, label: str) -> list[dict]:
    """Fetch data for a group of stocks."""
    print(f"\nFetching {label}...")
    results = []
    for symbol, name in stock_dict.items():
        print(f"  Fetching {symbol} ({name})...")
        data = fetch_stock_data(symbol, name)
        if data:
            results.append(data)
    return results


def main():
    indices = fetch_group(INDICES, "US Indices")
    us_stocks = fetch_group(US_STOCKS, "US Stocks")
    cn_stocks = fetch_group(CN_STOCKS, "Chinese ADRs")

    if not us_stocks and not cn_stocks:
        print("Error: No stock data was fetched!")
        return

    all_stocks = indices + us_stocks + cn_stocks
    result = {
        "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "market_date": all_stocks[0]["yesterday"]["date"] if all_stocks else "",
        "indices": indices,
        "us_stocks": us_stocks,
        "cn_stocks": cn_stocks,
    }

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    output_path = os.path.join(OUTPUT_DIR, "stocks.json")
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(f"\nDone! Data saved to {output_path}")
    print(f"  Indices: {len(indices)}, US stocks: {len(us_stocks)}, Chinese ADRs: {len(cn_stocks)}")
    print(f"  Market date: {result['market_date']}")


if __name__ == "__main__":
    main()
