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


def parse_group(items: list) -> dict:
    """Parse a mixed list into {symbol: name_or_None}."""
    result = {}
    if not isinstance(items, list):
        return result
    for item in items:
        if isinstance(item, str):
            result[item] = None
        elif isinstance(item, dict):
            for symbol, name in item.items():
                result[str(symbol)] = str(name)
    return result


def get_all_symbols(config: dict) -> dict:
    """Extract all symbols from config, keyed by symbol -> (group, name_or_None)."""
    all_symbols = {}
    for group in ["indices", "us_stocks", "cn_stocks"]:
        items = config.get(group, [])
        if not isinstance(items, list):
            print(f"FAIL: '{group}' should be a list")
            sys.exit(1)
        for symbol, name in parse_group(items).items():
            all_symbols[symbol] = (group, name)
    return all_symbols


def check_diff():
    """Ensure PR only adds new symbols — no modifications or deletions allowed."""
    import subprocess

    try:
        base_yaml = subprocess.run(
            ["git", "show", "origin/main:config/stocks.yaml"],
            capture_output=True, text=True, check=True,
        ).stdout
        base_config = yaml.safe_load(base_yaml) or {}
    except subprocess.CalledProcessError:
        return []

    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        pr_config = yaml.safe_load(f) or {}

    base_symbols = get_all_symbols(base_config)
    pr_symbols = get_all_symbols(pr_config)

    errors = []
    for symbol, (group, name) in base_symbols.items():
        if symbol not in pr_symbols:
            errors.append(f"不允许删除: {symbol} from {group}")
        elif name is not None and pr_symbols[symbol][1] != name:
            errors.append(f"不允许修改: {symbol} \"{name}\" -> \"{pr_symbols[symbol][1]}\" in {group}")

    return errors


def check_symbol(symbol: str) -> tuple[bool, str]:
    """Check if a symbol exists and return the real company name from Sina Finance."""
    try:
        url = f"https://hq.sinajs.cn/list=gb_{symbol.lower()}"
        r = requests.get(url, timeout=10, verify=False)
        if '=""' in r.text or len(r.text.strip()) <= 20:
            return False, ""
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

    all_symbols = get_all_symbols(config)

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
    for symbol, (group, name) in all_symbols.items():
        valid, real_name = check_symbol(symbol)
        if not valid:
            print(f"  [FAIL] {symbol} in {group} — symbol not found")
            errors.append(symbol)
        else:
            display = name or real_name or symbol
            print(f"  [ OK ] {symbol} ({display})")

    print()
    if errors:
        print(f"FAILED: {len(errors)} invalid symbol(s): {', '.join(errors)}")
        print("Please check that these are valid US-listed stock symbols.")
        sys.exit(1)
    else:
        print(f"All {len(all_symbols)} symbols validated successfully.")


if __name__ == "__main__":
    main()
