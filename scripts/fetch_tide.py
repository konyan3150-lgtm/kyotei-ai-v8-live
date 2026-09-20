#!/usr/bin/env python3
"""Build dev/tide.json from JMA astronomical tide tables."""

from __future__ import annotations

import json
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path

JST = timezone(timedelta(hours=9))
BASE = "https://www.data.jma.go.jp/kaiyou/data/db/tide/suisan/txt/{year}/{code}.txt"

# BOAT RACE stadium code -> representative JMA tide station.
# Inland freshwater venues are intentionally omitted.
VENUE_STATIONS = {
    "03": "TK", "04": "TK", "05": "TK",
    "06": "MI", "07": "NG", "08": "NG", "09": "NG",
    "12": "OS", "13": "OS", "14": "KM", "15": "TA",
    "16": "UN", "17": "Q8", "18": "QA", "20": "O3",
    "21": "O3", "22": "QF", "23": "KA", "24": "QD",
}

STATION_NAMES = {
    "TK": "東京", "MI": "舞阪", "NG": "名古屋", "OS": "大阪",
    "KM": "小松島", "TA": "高松", "UN": "宇野", "Q8": "広島",
    "QA": "徳山", "O3": "苅田", "QF": "博多", "KA": "唐津",
    "QD": "佐世保",
}


def parse_extrema(block: str, kind: str) -> list[dict]:
    values = []
    for pos in range(0, 28, 7):
        raw_time = block[pos:pos + 4]
        raw_level = block[pos + 4:pos + 7]
        if raw_time == "9999" or raw_level == "999":
            continue
        try:
            hour, minute = int(raw_time[:2]), int(raw_time[2:])
            level = int(raw_level)
        except ValueError:
            continue
        values.append({"kind": kind, "time": f"{hour:02d}:{minute:02d}", "level_cm": level})
    return values


def parse_table(text: str, wanted_dates: set[str]) -> dict[str, dict]:
    records = {}
    for line in text.splitlines():
        if len(line) < 136:
            continue
        try:
            hourly = [int(line[i:i + 3]) for i in range(0, 72, 3)]
            yy, mm, dd = int(line[72:74]), int(line[74:76]), int(line[76:78])
        except ValueError:
            continue
        date = f"20{yy:02d}{mm:02d}{dd:02d}"
        if date not in wanted_dates:
            continue
        events = parse_extrema(line[80:108], "high") + parse_extrema(line[108:136], "low")
        events.sort(key=lambda x: x["time"])
        records[date] = {"hourly_cm": hourly, "events": events}
    return records


def fetch_station(code: str, years: set[int], wanted_dates: set[str]) -> dict[str, dict]:
    records = {}
    for year in sorted(years):
        request = urllib.request.Request(BASE.format(year=year, code=code), headers={"User-Agent": "kyotei-ai-v8/1.0"})
        with urllib.request.urlopen(request, timeout=30) as response:
            text = response.read().decode("ascii", errors="replace")
        records.update(parse_table(text, wanted_dates))
    return records


def main() -> None:
    output = Path(sys.argv[1] if len(sys.argv) > 1 else "dev/tide.json")
    now = datetime.now(JST)
    dates = [(now + timedelta(days=offset)).date() for offset in range(-1, 3)]
    wanted_dates = {d.strftime("%Y%m%d") for d in dates}
    years = {d.year for d in dates}
    stations = {}
    codes = sorted(set(VENUE_STATIONS.values()))
    with ThreadPoolExecutor(max_workers=8) as pool:
        pending = {pool.submit(fetch_station, code, years, wanted_dates): code for code in codes}
        for future in as_completed(pending):
            code = pending[future]
            try:
                records = future.result()
                if records:
                    stations[code] = {"name": STATION_NAMES[code], "dates": records}
            except Exception as exc:
                print(f"warning: {code}: {exc}", file=sys.stderr)
    if not stations:
        raise RuntimeError("No JMA tide records were fetched")
    payload = {
        "schema": "kyotei-v8-tide-v1",
        "generated_at": now.isoformat(timespec="seconds"),
        "source": "気象庁 潮位表（天文潮位）",
        "venue_station": VENUE_STATIONS,
        "stations": stations,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {output}: {len(stations)} stations, {len(wanted_dates)} days")


if __name__ == "__main__":
    main()
