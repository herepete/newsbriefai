#!/usr/bin/python3.11

from datetime import datetime, timedelta
from pathlib import Path
import gzip
import re
import sys

# ------------------------------------------------------------
# CONFIG
# ------------------------------------------------------------

LOG_DIR = Path("/opt/bitnami/apache/logs")
WINDOW_MINUTES = int(sys.argv[1]) if len(sys.argv) > 1 else 1440  # default 24h

# Apache date format: [15/Jan/2026:06:30:44 +0000]
DATE_RE = re.compile(r"\[(\d{2}/\w{3}/\d{4}:\d{2}:\d{2}:\d{2})")
UA_RE = re.compile(r'"[^"]*" "[^"]*" "([^"]*)"')

BOT_KEYWORDS = [
    "bot", "spider", "crawl", "slurp",
    "google", "bing", "duckduckgo",
    "yandex", "baidu", "ahrefs",
    "semrush", "mj12", "uptimerobot"
]

# ------------------------------------------------------------

def parse_time(ts):
    return datetime.strptime(ts, "%d/%b/%Y:%H:%M:%S")

def human_window(minutes):
    if minutes < 60:
        return f"{minutes} minutes"
    if minutes < 1440:
        return f"{minutes // 60} hours"
    days = minutes // 1440
    return f"{days} day{'s' if days != 1 else ''}"

def iter_log_lines(path):
    if path.suffix == ".gz":
        with gzip.open(path, "rt", errors="ignore") as f:
            yield from f
    else:
        with path.open("r", errors="ignore") as f:
            yield from f

def is_bot(user_agent):
    if not user_agent:
        return False
    ua = user_agent.lower()
    return any(k in ua for k in BOT_KEYWORDS)

# ------------------------------------------------------------

def collect_stats(minutes):
    cutoff = datetime.utcnow() - timedelta(minutes=minutes)

    logs = [LOG_DIR / "access_log"]

    # Include rotated logs if window > 48h
    if minutes > 2880:
        for f in LOG_DIR.glob("access_log-*.gz"):
            if datetime.fromtimestamp(f.stat().st_mtime) >= cutoff:
                logs.append(f)

    stats = {
        "minutes": minutes,
        "human_hits": 0,
        "bot_hits": 0,
        "human_ips": set(),
        "bot_ips": set(),
        "paths": {},
        "last_human_hit": None,
        "last_bot_hit": None,
    }

    for log_file in logs:
        if not log_file.exists():
            continue

        for line in iter_log_lines(log_file):
            m = DATE_RE.search(line)
            if not m:
                continue

            try:
                ts = parse_time(m.group(1))
            except ValueError:
                continue

            if ts < cutoff:
                continue

            parts = line.split()
            ip = parts[0] if parts else "?"

            ua_match = UA_RE.search(line)
            user_agent = ua_match.group(1) if ua_match else ""

            bot = is_bot(user_agent)

            try:
                path = line.split('"')[1].split()[1]
            except Exception:
                path = None

            if bot:
                stats["bot_hits"] += 1
                stats["bot_ips"].add(ip)
                stats["last_bot_hit"] = max(stats["last_bot_hit"], ts) if stats["last_bot_hit"] else ts
            else:
                stats["human_hits"] += 1
                stats["human_ips"].add(ip)
                stats["last_human_hit"] = max(stats["last_human_hit"], ts) if stats["last_human_hit"] else ts

                if path:
                    stats["paths"][path] = stats["paths"].get(path, 0) + 1

    return stats

# ------------------------------------------------------------

def print_block(stats, title):
    print(f"\n--- {title} ---")
    print(f"Human hits: {stats['human_hits']}  (IPs: {len(stats['human_ips'])})")
    print(f"Bot hits:   {stats['bot_hits']}  (IPs: {len(stats['bot_ips'])})")

    print(f"Last human hit: {stats['last_human_hit'].isoformat() if stats['last_human_hit'] else 'none'}")
    print(f"Last bot hit:   {stats['last_bot_hit'].isoformat() if stats['last_bot_hit'] else 'none'}")

    if stats["paths"]:
        print("\nTop human paths:")
        for p, c in sorted(stats["paths"].items(), key=lambda x: x[1], reverse=True)[:8]:
            print(f"  {p:45} {c}")

# ------------------------------------------------------------

def main():
    print("\n=== Apache Interest Summary (Humans vs Bots) ===")
    print(f"Generated at: {datetime.utcnow().isoformat()}Z")

    # Always show recent activity
    recent = collect_stats(15)
    print_block(recent, "Last 15 minutes")

    # Show requested window
    main_stats = collect_stats(WINDOW_MINUTES)
    print_block(main_stats, f"Last {human_window(WINDOW_MINUTES)}")

if __name__ == "__main__":
    main()

