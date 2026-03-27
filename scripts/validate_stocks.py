#!/usr/bin/env python3
"""Validate that all stock symbols in config/stocks.yaml are real US-listed stocks."""

import ssl
import sys

import requests
import urllib3
import yaml

ssl._create_default_https_context = ssl._create_unverified_context
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

CONFIG_PATH = "config/stocks.yaml"


def check_symbol(symbol: str) -> bool:
    """Check if a symbol exists via Sina Finance API (fast, no auth needed)."""
    try:
        url = f"https://hq.sinajs.cn/list=gb_{symbol.lower()}"
        r = requests.get(url, timeout=10, verify=False)
        # Sina returns an empty var for invalid symbols
        return '=""' not in r.text and len(r.text.strip()) > 20
    except Exception:
        return False


def main():
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        config = yaml.safe_load(f)

    all_symbols = {}
    for group in ["indices", "us_stocks", "cn_stocks"]:
        stocks = config.get(group, {})
        if not isinstance(stocks, dict):
            print(f"FAIL: '{group}' should be a mapping of SYMBOL: Name")
            sys.exit(1)
        for symbol, name in stocks.items():
            all_symbols[symbol] = (group, name)

    print(f"Validating {len(all_symbols)} symbols...\n")

    errors = []
    for symbol, (group, name) in all_symbols.items():
        valid = check_symbol(symbol)
        status = "OK" if valid else "FAIL"
        print(f"  [{status}] {symbol} ({name}) in {group}")
        if not valid:
            errors.append(f"{symbol} ({name})")

    print()
    if errors:
        print(f"FAILED: {len(errors)} invalid symbol(s): {', '.join(errors)}")
        print("Please check that these are valid US-listed stock symbols.")
        sys.exit(1)
    else:
        print(f"All {len(all_symbols)} symbols validated successfully.")


if __name__ == "__main__":
    main()
