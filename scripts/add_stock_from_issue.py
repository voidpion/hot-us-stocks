#!/usr/bin/env python3
"""Parse a GitHub Issue body and add the stock to config/stocks.yaml."""

import os
import re
import ssl
import sys

import requests
import yaml

ssl._create_default_https_context = ssl._create_unverified_context

CONFIG_PATH = "config/stocks.yaml"
GITHUB_OUTPUT = os.environ.get("GITHUB_OUTPUT", "")


def set_output(key: str, value: str):
    if GITHUB_OUTPUT:
        with open(GITHUB_OUTPUT, "a") as f:
            f.write(f"{key}={value}\n")


def resolve_name(symbol: str) -> str:
    """Fetch real company name from Sina Finance API."""
    try:
        url = f"https://hq.sinajs.cn/list=gb_{symbol.lower()}"
        r = requests.get(url, timeout=10, verify=False)
        if '=""' in r.text or len(r.text.strip()) <= 20:
            return ""
        match = re.search(r'"(.+)"', r.text)
        if match:
            fields = match.group(1).split(",")
            return fields[0].strip() if fields else ""
    except Exception:
        pass
    return ""


def parse_issue():
    """Extract symbol, name, and category from issue body."""
    body = os.environ.get("ISSUE_BODY", "")
    title = os.environ.get("ISSUE_TITLE", "")

    # Try to extract from structured issue template fields
    symbol = ""
    name = ""
    group = "us_stocks"

    # Parse "### 股票代码\n\nPLTR" style fields
    symbol_match = re.search(r"###\s*股票代码\s*\n+\s*(\w+)", body)
    if symbol_match:
        symbol = symbol_match.group(1).upper().strip()

    name_match = re.search(r"###\s*股票名称[（(]?可选[)）]?\s*\n+\s*(.+)", body)
    if name_match:
        name = name_match.group(1).strip()
        if name in ("_No response_", "None", ""):
            name = ""

    if "cn_stocks" in body or "中概股" in body:
        group = "cn_stocks"

    # Fallback: try to extract from title "添加股票: PLTR"
    if not symbol:
        title_match = re.search(r"[:\s]+([A-Z]{1,5})\b", title)
        if title_match:
            symbol = title_match.group(1).upper()

    return symbol, name, group


def main():
    symbol, name, group = parse_issue()

    if not symbol:
        set_output("added", "false")
        set_output("reason", "无法从 Issue 中解析出股票代码")
        return

    # Validate symbol exists
    real_name = resolve_name(symbol)
    if not real_name:
        set_output("added", "false")
        set_output("reason", f"股票代码 {symbol} 无效或无法验证")
        return

    # Use provided name or resolved name
    display_name = name or real_name

    # Load config
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        config = yaml.safe_load(f) or {}

    # Check if already exists
    existing = []
    for g in ["indices", "us_stocks", "cn_stocks"]:
        for item in config.get(g, []):
            if isinstance(item, str) and item == symbol:
                existing.append(g)
            elif isinstance(item, dict) and symbol in item:
                existing.append(g)

    if existing:
        set_output("added", "false")
        set_output("reason", f"{symbol} 已存在于 {', '.join(existing)}")
        return

    # Add to config
    if group not in config:
        config[group] = []

    if name:
        config[group].append({symbol: name})
    else:
        config[group].append(symbol)

    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        yaml.dump(config, f, allow_unicode=True, default_flow_style=False, sort_keys=False)

    set_output("added", "true")
    set_output("symbol", symbol)
    set_output("name", display_name)
    set_output("group", group)
    print(f"Added {symbol} ({display_name}) to {group}")


if __name__ == "__main__":
    main()
