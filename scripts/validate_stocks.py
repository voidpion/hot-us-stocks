#!/usr/bin/env python3
"""Validate that all stock symbols in config/stocks.yaml are real US-listed stocks."""

import re
import ssl
import sys

import requests
import urllib3
import yaml

ssl._create_default_https_context = ssl._create_unverified_context
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

CONFIG_PATH = "config/stocks.yaml"


def check_diff():
    """Ensure PR only adds new symbols — no modifications or deletions allowed."""
    import subprocess

    # Get the base branch config (main)
    try:
        base_yaml = subprocess.run(
            ["git", "show", "origin/main:config/stocks.yaml"],
            capture_output=True, text=True, check=True,
        ).stdout
        base_config = yaml.safe_load(base_yaml) or {}
    except subprocess.CalledProcessError:
        # First time adding the file, no base to compare
        return []

    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        pr_config = yaml.safe_load(f) or {}

    errors = []
    for group in ["indices", "us_stocks", "cn_stocks"]:
        base_stocks = base_config.get(group, {}) or {}
        pr_stocks = pr_config.get(group, {}) or {}

        # Check for deleted symbols
        for symbol in base_stocks:
            if symbol not in pr_stocks:
                errors.append(f"不允许删除: {symbol} ({base_stocks[symbol]}) from {group}")

        # Check for modified names
        for symbol in base_stocks:
            if symbol in pr_stocks and pr_stocks[symbol] != base_stocks[symbol]:
                errors.append(
                    f"不允许修改: {symbol} \"{base_stocks[symbol]}\" -> \"{pr_stocks[symbol]}\" in {group}"
                )

    return errors


def check_symbol(symbol: str) -> tuple[bool, str]:
    """Check if a symbol exists and return the real company name from Sina Finance."""
    try:
        url = f"https://hq.sinajs.cn/list=gb_{symbol.lower()}"
        r = requests.get(url, timeout=10, verify=False)
        if '=""' in r.text or len(r.text.strip()) <= 20:
            return False, ""
        # Sina format: var hq_str_gb_aapl="Apple Inc,..."
        # The first field after the opening quote is the company name
        match = re.search(r'"(.+)"', r.text)
        if match:
            fields = match.group(1).split(",")
            real_name = fields[0].strip() if fields else ""
            return True, real_name
        return True, ""
    except Exception:
        return False, ""


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

    # Check for unauthorized modifications/deletions
    diff_errors = check_diff()
    if diff_errors:
        print("PR contains unauthorized changes:\n")
        for e in diff_errors:
            print(f"  [FAIL] {e}")
        print("\nOnly adding new stocks is allowed. Do not modify or delete existing entries.")
        sys.exit(1)

    print(f"Validating {len(all_symbols)} symbols...\n")

    errors = []
    warnings = []
    for symbol, (group, name) in all_symbols.items():
        valid, real_name = check_symbol(symbol)
        if not valid:
            print(f"  [FAIL] {symbol} ({name}) in {group} — symbol not found")
            errors.append(f"{symbol} ({name})")
        elif real_name and name.lower() not in real_name.lower() and real_name.lower() not in name.lower():
            print(f"  [WARN] {symbol}: config name \"{name}\" vs actual \"{real_name}\"")
            warnings.append(f"{symbol}: \"{name}\" -> \"{real_name}\"")
        else:
            print(f"  [ OK ] {symbol} ({name})")

    print()
    if warnings:
        print(f"WARNING: {len(warnings)} name mismatch(es):")
        for w in warnings:
            print(f"  {w}")
        print()
    if errors:
        print(f"FAILED: {len(errors)} invalid symbol(s): {', '.join(errors)}")
        print("Please check that these are valid US-listed stock symbols.")
        sys.exit(1)
    else:
        print(f"All {len(all_symbols)} symbols validated successfully.")


if __name__ == "__main__":
    main()
