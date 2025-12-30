#!/usr/bin/python3.11
"""
scripts/metrics_trends.py

Reads:
  /home/bitnami/htdocs/public/data/metrics/metrics-YYYY-MM-DD.json

Writes:
  /home/bitnami/htdocs/public/data/metrics_trends.csv
  /home/bitnami/htdocs/public/data/metrics_trends.json
  /home/bitnami/htdocs/public/data/metrics_report.txt

Also prints a concise summary to stdout.
"""

import csv
import glob
import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


# ----------------------------
# Config / weights
# ----------------------------

@dataclass
class Weights:
    run_success: float = 12.0
    tab_completion: float = 12.0
    rss_errors: float = 10.0
    freshness_penalty: float = 6.0
    ai_strict_rate: float = 25.0
    off_topic_penalty: float = 15.0
    duplication_penalty: float = 10.0
    host_diversity: float = 10.0


W = Weights()

MAX_RSS_ERRORS_FOR_FULL_SCORE = 5
MAX_OFFTOPIC_RATE = 0.20
MAX_DUP_RATE = 0.20
TARGET_HOST_DIVERSITY = 10


# ----------------------------
# Helpers
# ----------------------------

def clamp(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))


def safe_int(v: Any, default: int = 0) -> int:
    try:
        return int(v)
    except Exception:
        return default


def safe_float(v: Any, default: float = 0.0) -> float:
    try:
        return float(v)
    except Exception:
        return default


def pct(n: int, d: int) -> float:
    return (n / d) if d > 0 else 0.0


def avg(vals: List[float]) -> float:
    return sum(vals) / len(vals) if vals else 0.0


def parse_date_from_filename(p: str) -> Optional[str]:
    name = Path(p).name
    if name.startswith("metrics-") and name.endswith(".json"):
        return name[8:-5]
    return None


def load_json(p: str) -> Optional[Dict[str, Any]]:
    try:
        return json.loads(Path(p).read_text())
    except Exception:
        return None


def collect_hosts(metrics: Dict[str, Any]) -> int:
    hosts = set()
    for t in metrics.get("tabs", []):
        for s in t.get("sources", []):
            if s.get("source"):
                hosts.add(s["source"])
    return len(hosts)


def freshness_penalty(metrics: Dict[str, Any]) -> float:
    hours = []
    for t in metrics.get("tabs", []):
        h = t.get("freshnessUsed")
        if h:
            hours.append(float(h))
    if not hours:
        return 0.0
    over = [h for h in hours if h > 24]
    if not over:
        return 0.0
    worst = max(over)
    return clamp((worst - 24) / 24)


# ----------------------------
# Scoring
# ----------------------------

def score_day(m: Dict[str, Any]) -> Tuple[float, Dict[str, Any]]:
    tabs_total = safe_int(m.get("tabsTotal"))
    thin = safe_int(m.get("thinTabs"))
    empty = safe_int(m.get("noUpdateTabs"))
    rss = safe_int(m.get("rssErrors"))
    picked = safe_int(m.get("pickedItemsTotal"))
    ai_strict = safe_int(m.get("aiStrictCount"))
    off = safe_int(m.get("offTopicCount"))
    dup = safe_int(m.get("dupCount"))
    hosts = safe_int(m.get("hostCount")) or collect_hosts(m)

    ai_rate = pct(ai_strict, picked)
    off_rate = pct(off, picked)
    dup_rate = pct(dup, max(1, picked))

    # Reliability
    s_run = W.run_success * (1 if m.get("runSuccess") else 0)
    pen_tabs = (thin * 0.12 + empty * 0.30) / tabs_total if tabs_total else 1
    s_tabs = W.tab_completion * clamp(1 - pen_tabs)
    s_rss = W.rss_errors * clamp(1 - rss / (MAX_RSS_ERRORS_FOR_FULL_SCORE * 2))
    s_fresh = W.freshness_penalty * (1 - freshness_penalty(m))

    # Quality
    s_ai = W.ai_strict_rate * ai_rate
    s_off = W.off_topic_penalty * (1 - clamp(off_rate / MAX_OFFTOPIC_RATE))
    s_dup = W.duplication_penalty * (1 - clamp(dup_rate / MAX_DUP_RATE))
    s_hosts = W.host_diversity * clamp(hosts / TARGET_HOST_DIVERSITY)

    score = round(s_run + s_tabs + s_rss + s_fresh + s_ai + s_off + s_dup + s_hosts, 2)

    return score, {
        "tabsTotal": tabs_total,
        "thinTabs": thin,
        "noUpdateTabs": empty,
        "rssErrors": rss,
        "aiStrictRate": ai_rate,
        "offTopicRate": off_rate,
        "dupRate": dup_rate,
        "hostCount": hosts,
        "freshnessPenalty": freshness_penalty(m),
    }


# ----------------------------
# Main
# ----------------------------

def main() -> int:
    repo_root = Path(__file__).resolve().parents[1]
    metrics_dir = repo_root / "public" / "data" / "metrics"
    files = sorted(glob.glob(str(metrics_dir / "metrics-*.json")))

    rows = []

    for fp in files:
        date = parse_date_from_filename(fp)
        m = load_json(fp)
        if not date or not m:
            continue
        score, dbg = score_day(m)
        rows.append({"date": date, "score": score, **dbg})

    if not rows:
        print("No metrics files found.")
        return 0

    rows.sort(key=lambda r: r["date"])

    latest = rows[-1]
    last7 = rows[-7:]
    score7 = avg([r["score"] for r in last7])

    # ---- PRINT TO SCREEN ----
    print("\n=== NewsBriefAI – Metrics Summary ===\n")
    print(f"Latest day: {latest['date']}")
    print(f"Score: {latest['score']:.2f}  (7d avg: {score7:.2f})\n")

    print("Tabs:")
    print(f"  total: {latest['tabsTotal']}")
    print(f"  thin: {latest['thinTabs']}")
    print(f"  no-update: {latest['noUpdateTabs']}\n")

    print("Quality:")
    print(f"  AI strict rate: {latest['aiStrictRate']:.1%}")
    print(f"  Off-topic rate: {latest['offTopicRate']:.1%}")
    print(f"  Duplication rate: {latest['dupRate']:.1%}")
    print(f"  Host count: {latest['hostCount']}\n")

    print("Reliability:")
    print(f"  RSS errors: {latest['rssErrors']}")
    print(f"  Freshness penalty: {latest['freshnessPenalty']:.2f}\n")

    worst = sorted(rows, key=lambda r: r["score"])[:3]
    print("Worst recent days:")
    for r in worst:
        print(f"  {r['date']} → {r['score']:.2f}")

    # ---- WRITE FILES ----
    out_dir = repo_root / "public" / "data"
    out_dir.mkdir(parents=True, exist_ok=True)

    # CSV
    with open(out_dir / "metrics_trends.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=rows[0].keys())
        w.writeheader()
        w.writerows(rows)

    # JSON
    (out_dir / "metrics_trends.json").write_text(
        json.dumps({"generated_at": datetime.utcnow().isoformat(), "rows": rows}, indent=2)
    )

    # TXT
    (out_dir / "metrics_report.txt").write_text(
        "\n".join(f"{r['date']} {r['score']:.2f}" for r in rows)
    )

    print("\nFiles written:")
    print("  public/data/metrics_trends.csv")
    print("  public/data/metrics_trends.json")
    print("  public/data/metrics_report.txt\n")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

