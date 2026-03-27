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
import yaml

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

CONFIG_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config", "stocks.yaml")


def resolve_stock_name(symbol: str) -> str:
    """Fetch real company name from Sina Finance API."""
    try:
        url = f"https://hq.sinajs.cn/list=gb_{symbol.lower()}"
        r = requests.get(url, timeout=10)
        match = re.search(r'"(.+)"', r.text)
        if match:
            fields = match.group(1).split(",")
            return fields[0].strip() if fields else symbol
    except Exception:
        pass
    return symbol


def parse_stock_list(items: list) -> dict:
    """Parse a mixed list of strings and dicts into {symbol: name}.

    Supports:
      - "AAPL"           -> auto-fetch name
      - BABA: 阿里巴巴   -> use provided name
    """
    result = {}
    for item in items:
        if isinstance(item, str):
            result[item] = None  # name to be resolved
        elif isinstance(item, dict):
            for symbol, name in item.items():
                result[str(symbol)] = str(name)
    # Resolve missing names
    for symbol in result:
        if result[symbol] is None:
            result[symbol] = resolve_stock_name(symbol)
            print(f"    Resolved {symbol} -> {result[symbol]}")
    return result


def load_stock_config() -> tuple[dict, dict, dict]:
    """Load stock lists from config/stocks.yaml."""
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        config = yaml.safe_load(f)

    print("Resolving stock names...")
    indices = parse_stock_list(config.get("indices", []))
    us_stocks = parse_stock_list(config.get("us_stocks", []))
    cn_stocks = parse_stock_list(config.get("cn_stocks", []))
    return indices, us_stocks, cn_stocks

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


SECTOR_MAP = {
    "七巨头": ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"],
    "半导体": ["AMD", "AVGO", "INTC", "QCOM", "MU"],
    "软件云": ["CRM", "ORCL", "ADBE", "NOW"],
    "互联网": ["NFLX", "UBER", "ABNB", "SNAP"],
    "金融科技": ["V", "PYPL", "SQ", "COIN"],
}


def generate_market_summary(indices: list, us_stocks: list, cn_stocks: list) -> str:
    """Generate a template-based market summary from the data."""
    all_stocks = us_stocks + cn_stocks
    if not all_stocks:
        return "暂无市场数据。"

    # Index performance
    idx_parts = []
    for idx in indices:
        d = idx["yesterday"]
        sign = "+" if d["change_percent"] >= 0 else ""
        idx_parts.append(f"{idx['name']}{sign}{d['change_percent']:.2f}%")

    # Up/down stats
    up = [s for s in all_stocks if s["yesterday"]["change"] > 0]
    down = [s for s in all_stocks if s["yesterday"]["change"] < 0]
    total = len(all_stocks)

    # Weighted sentiment: consider magnitude, not just count
    avg_change = sum(s["yesterday"]["change_percent"] for s in all_stocks) / total
    big_drops = [s for s in all_stocks if s["yesterday"]["change_percent"] <= -3]
    big_gains = [s for s in all_stocks if s["yesterday"]["change_percent"] >= 3]

    if avg_change >= 1.5:
        mood = "市场大幅上涨，做多情绪强烈"
    elif avg_change >= 0.5:
        mood = "市场整体偏强"
    elif avg_change > -0.5:
        if big_drops and big_gains:
            mood = "市场分化明显，个股涨跌剧烈"
        elif big_drops:
            mood = "市场涨跌互现，但部分个股跌幅较深"
        else:
            mood = "市场整体表现平稳"
    elif avg_change > -1.5:
        mood = "市场整体偏弱"
    else:
        mood = "市场大幅下挫，避险情绪浓厚"

    # Sector highlights: find sectors with notable average moves
    sector_notes = []
    all_stock_map = {s["symbol"]: s for s in us_stocks}
    for sector_name, symbols in SECTOR_MAP.items():
        sector_stocks = [all_stock_map[sym] for sym in symbols if sym in all_stock_map]
        if not sector_stocks:
            continue
        sector_avg = sum(s["yesterday"]["change_percent"] for s in sector_stocks) / len(sector_stocks)
        if sector_avg <= -2:
            sector_notes.append(f"{sector_name}板块整体走弱(均跌{abs(sector_avg):.1f}%)")
        elif sector_avg >= 2:
            sector_notes.append(f"{sector_name}板块表现强劲(均涨{sector_avg:.1f}%)")

    # CN stocks
    if cn_stocks:
        cn_avg = sum(s["yesterday"]["change_percent"] for s in cn_stocks) / len(cn_stocks)
        if cn_avg <= -2:
            sector_notes.append(f"中概股集体承压(均跌{abs(cn_avg):.1f}%)")
        elif cn_avg >= 2:
            sector_notes.append(f"中概股集体走强(均涨{cn_avg:.1f}%)")

    # Top gainers and losers
    sorted_stocks = sorted(all_stocks, key=lambda s: s["yesterday"]["change_percent"], reverse=True)
    best = sorted_stocks[0]
    worst = sorted_stocks[-1]
    best_sign = "+" if best["yesterday"]["change_percent"] >= 0 else ""
    worst_sign = "+" if worst["yesterday"]["change_percent"] >= 0 else ""

    parts = [
        f"美股三大指数：{', '.join(idx_parts)}。",
        f"{mood}，上涨{len(up)}只、下跌{len(down)}只（共{total}只）。",
    ]
    if sector_notes:
        parts.append("；".join(sector_notes) + "。")
    parts.append(
        f"领涨：{best['name']}({best['symbol']}){best_sign}{best['yesterday']['change_percent']:.2f}%，"
        f"领跌：{worst['name']}({worst['symbol']}){worst_sign}{worst['yesterday']['change_percent']:.2f}%。"
    )
    return "".join(parts)


def generate_ai_summary(template_summary: str, indices: list, us_stocks: list, cn_stocks: list) -> str | None:
    """Try to generate an AI-powered market summary using DeepSeek or OpenAI."""
    api_key = os.environ.get("DEEPSEEK_API_KEY") or os.environ.get("OPENAI_API_KEY")
    if not api_key:
        return None

    base_url = "https://api.deepseek.com" if os.environ.get("DEEPSEEK_API_KEY") else "https://api.openai.com"
    model = "deepseek-chat" if os.environ.get("DEEPSEEK_API_KEY") else "gpt-4o-mini"

    # Build concise data for the prompt
    idx_info = ", ".join(
        f"{i['name']} {'+' if i['yesterday']['change_percent'] >= 0 else ''}{i['yesterday']['change_percent']:.2f}%"
        for i in indices
    )
    top5 = sorted(us_stocks + cn_stocks, key=lambda s: s["yesterday"]["change_percent"], reverse=True)[:5]
    bottom5 = sorted(us_stocks + cn_stocks, key=lambda s: s["yesterday"]["change_percent"])[:5]
    top_info = ", ".join(f"{s['symbol']}{'+' if s['yesterday']['change_percent'] >= 0 else ''}{s['yesterday']['change_percent']:.2f}%" for s in top5)
    bot_info = ", ".join(f"{s['symbol']}{'+' if s['yesterday']['change_percent'] >= 0 else ''}{s['yesterday']['change_percent']:.2f}%" for s in bottom5)

    prompt = (
        f"你是美股市场分析师，请用中文写一段简短的昨日美股市场综述（80-120字），风格专业简洁。\n"
        f"三大指数：{idx_info}\n"
        f"涨幅前5：{top_info}\n"
        f"跌幅前5：{bot_info}\n"
        f"请直接输出综述文字，不要加标题或标点以外的格式。"
    )

    try:
        resp = requests.post(
            f"{base_url}/v1/chat/completions",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={"model": model, "messages": [{"role": "user", "content": prompt}], "max_tokens": 300},
            timeout=30,
        )
        if resp.ok:
            text = resp.json()["choices"][0]["message"]["content"].strip()
            print(f"  AI summary generated ({len(text)} chars)")
            return text
    except Exception as e:
        print(f"  AI summary failed: {e}")
    return None


def fetch_news() -> list[dict]:
    """Fetch latest US stock news from Sina Finance."""
    try:
        url = "https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2514&num=30&page=1"
        r = requests.get(url, timeout=15)
        data = r.json()
        items = data.get("result", {}).get("data", [])
        news = []
        for item in items[:20]:
            title = item.get("title", "").strip()
            # Clean HTML tags
            title = re.sub(r"<[^>]+>", "", title)
            if not title:
                continue
            ts = int(item.get("ctime", 0))
            time_str = datetime.fromtimestamp(ts).strftime("%H:%M") if ts else ""
            news.append({"title": title, "time": time_str})
        print(f"  Fetched {len(news)} news items")
        return news
    except Exception as e:
        print(f"  News fetch error: {e}")
        return []


def main():
    INDICES, US_STOCKS, CN_STOCKS = load_stock_config()

    indices = fetch_group(INDICES, "US Indices")
    us_stocks = fetch_group(US_STOCKS, "US Stocks")
    cn_stocks = fetch_group(CN_STOCKS, "Chinese ADRs")

    if not us_stocks and not cn_stocks:
        print("Error: No stock data was fetched!")
        return

    # Generate market summary
    print("\nGenerating market summary...")
    template_summary = generate_market_summary(indices, us_stocks, cn_stocks)
    ai_summary = generate_ai_summary(template_summary, indices, us_stocks, cn_stocks)
    summary = ai_summary or template_summary

    # Fetch news
    print("Fetching news...")
    news = fetch_news()

    all_stocks = indices + us_stocks + cn_stocks
    result = {
        "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "market_date": all_stocks[0]["yesterday"]["date"] if all_stocks else "",
        "market_summary": summary,
        "news": news,
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
