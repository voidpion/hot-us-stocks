#!/usr/bin/env python3
"""Fetch popular US stock data and save as JSON.

Uses akshare library which provides reliable access to US stock data.
"""

import json
import os
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

STOCKS = {
    "AAPL": "Apple",
    "MSFT": "Microsoft",
    "GOOGL": "Alphabet",
    "AMZN": "Amazon",
    "NVDA": "NVIDIA",
    "META": "Meta Platforms",
    "TSLA": "Tesla",
    "AMD": "AMD",
    "NFLX": "Netflix",
    "AVGO": "Broadcom",
    "CRM": "Salesforce",
    "COST": "Costco",
}

OUTPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")


def fetch_stock_data(symbol: str, name: str) -> dict | None:
    """Fetch historical data for a single US stock via akshare."""
    try:
        # akshare provides US stock daily data via stock_us_daily
        # The symbol format for akshare is the raw ticker (e.g., "AAPL")
        end_date = datetime.now().strftime("%Y%m%d")
        start_date = (datetime.now() - timedelta(days=400)).strftime("%Y%m%d")

        df = ak.stock_us_daily(symbol=symbol, adjust="qfq")

        if df is None or df.empty:
            print(f"  Warning: No data for {symbol}")
            return None

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
        }
    except Exception as e:
        print(f"  Error fetching {symbol}: {e}")
        return None


def main():
    print("Fetching US stock data via akshare...")
    all_stocks = []

    for symbol, name in STOCKS.items():
        print(f"  Fetching {symbol} ({name})...")
        data = fetch_stock_data(symbol, name)
        if data:
            all_stocks.append(data)

    if not all_stocks:
        print("Error: No stock data was fetched!")
        return

    result = {
        "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "market_date": all_stocks[0]["yesterday"]["date"] if all_stocks else "",
        "stocks": all_stocks,
    }

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    output_path = os.path.join(OUTPUT_DIR, "stocks.json")
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(f"\nDone! Data saved to {output_path}")
    print(f"  Stocks fetched: {len(all_stocks)}")
    print(f"  Market date: {result['market_date']}")


if __name__ == "__main__":
    main()
