#!/usr/bin/env python3
"""Build dev/tomorrow.json from BOAT RACE's official next-day race lists."""

from __future__ import annotations

import json
import re
import sys
import time
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
from bs4 import BeautifulSoup

JST = timezone(timedelta(hours=9))
BASE = "https://www.boatrace.jp/owpc/pc/race/racelist"
INDEX = "https://www.boatrace.jp/owpc/pc/race/index"
UA = "kyotei-ai-v8-live/1.0 (+GitHub Actions; next-day race program)"
LOCAL = threading.local()


class IncompleteProgramError(RuntimeError):
    """Official next-day program has not finished publishing yet."""


def clean(value: str) -> str:
    return re.sub(r"\s+", " ", value.replace("\u3000", " ")).strip()


def number(value: str):
    value = value.strip().replace("−", "-")
    if value in {"", "-", "--"}:
        return None
    try:
        return float(value)
    except ValueError:
        return None


def fetch_page(session: requests.Session, date: str, venue: int, race: int) -> str:
    response = session.get(
        BASE,
        params={"rno": race, "jcd": f"{venue:02d}", "hd": date},
        timeout=30,
    )
    response.raise_for_status()
    response.encoding = response.apparent_encoding or "utf-8"
    return response.text


def session_for_thread() -> requests.Session:
    session = getattr(LOCAL, "session", None)
    if session is None:
        session = requests.Session()
        session.headers.update({"User-Agent": UA})
        LOCAL.session = session
    return session


def active_venues(date: str):
    session = session_for_thread()
    response = session.get(INDEX, params={"hd": date}, timeout=30)
    response.raise_for_status()
    response.encoding = response.apparent_encoding or "utf-8"
    soup = BeautifulSoup(response.text, "lxml")
    found = set()
    for link in soup.select("a[href*='jcd=']"):
        match = re.search(r"[?&]jcd=(\d{2})(?:&|$)", link.get("href", ""))
        if match:
            found.add(int(match.group(1)))
    return sorted(found)


def parse_racer(row_text: str):
    text = clean(row_text)
    head = re.search(
        r"(\d{4})\s*/\s*([AB][12])\s+(.+?)\s+([^\s/]+)/([^\s]+)\s+"
        r"(\d+)歳\s*/\s*([\d.]+)kg\s+F(\d+)\s+L(\d+)\s+([\d.]+)",
        text,
    )
    if not head:
        return None
    tail = text[head.end() :]
    values = re.findall(r"(?<![\d.])-?(?:\d+(?:\.\d+)?|-)(?![\d.])", tail)
    if len(values) < 12:
        return None
    vals = [number(v) for v in values[:12]]
    return {
        "registration_number": int(head.group(1)),
        "rank_number": head.group(2),
        "name": clean(head.group(3)),
        "branch": head.group(4),
        "birthplace": head.group(5),
        "age": int(head.group(6)),
        "weight": float(head.group(7)),
        "flying_count": int(head.group(8)),
        "late_count": int(head.group(9)),
        "average_start_timing": float(head.group(10)),
        "national_win_rate": vals[0],
        "national_top_2_percent": vals[1],
        "national_top_3_percent": vals[2],
        "local_win_rate": vals[3],
        "local_top_2_percent": vals[4],
        "local_top_3_percent": vals[5],
        "motor_number": int(vals[6]) if vals[6] is not None else None,
        "motor_top_2_percent": vals[7],
        "motor_top_3_percent": vals[8],
        "boat_number": int(vals[9]) if vals[9] is not None else None,
        "boat_top_2_percent": vals[10],
        "boat_top_3_percent": vals[11],
    }


def parse_race(html: str, date: str, venue: int, race: int):
    soup = BeautifulSoup(html, "lxml")
    racers = []
    for tr in soup.select("tr"):
        parsed = parse_racer(tr.get_text(" ", strip=True))
        if parsed:
            racers.append(parsed)
    # The official table contains exactly one row for each of the six boats.
    unique = []
    seen = set()
    for racer in racers:
        key = racer["registration_number"]
        if key not in seen:
            seen.add(key)
            unique.append(racer)
    if len(unique) != 6:
        return None

    title_node = next(
        (node for node in soup.select("h2, h3") if "m" in clean(node.get_text()).lower()),
        None,
    )
    title = clean(title_node.get_text(" ", strip=True)) if title_node else ""
    if title.endswith("1800m"):
        title = title[:-5].strip()

    close_time = None
    time_pattern = re.compile(r"\b([01]\d|2[0-3]):[0-5]\d\b")
    for table in soup.select("table"):
        times = time_pattern.findall(table.get_text(" ", strip=True))
        full_times = re.findall(r"\b(?:[01]\d|2[0-3]):[0-5]\d\b", table.get_text(" ", strip=True))
        if len(full_times) >= 12:
            close_time = full_times[race - 1]
            break
    if not close_time:
        return None

    closed_at = f"{date[:4]}-{date[4:6]}-{date[6:8]} {close_time}:00"
    return {
        "number": race,
        "title": title,
        "closed_at": closed_at,
        "racers": {str(i): racer for i, racer in enumerate(unique, 1)},
        "preview": {"racers": {}},
    }


def fetch_race(date: str, venue: int, race: int):
    html = fetch_page(session_for_thread(), date, venue, race)
    return venue, race, parse_race(html, date, venue, race)


def build(date: str):
    stadiums = {}
    failures = []
    venues = active_venues(date)
    if not venues:
        raise RuntimeError("Official next-day venue list is not ready")
    # The official site throttles parallel access. A single keep-alive session is
    # slower but consistently returns the complete racer table.
    with ThreadPoolExecutor(max_workers=1) as executor:
        futures = {
            executor.submit(fetch_race, date, venue, race): (venue, race)
            for venue in venues
            for race in range(1, 13)
        }
        for future in as_completed(futures):
            venue, race = futures[future]
            try:
                _, _, parsed = future.result()
                if parsed:
                    stadiums.setdefault(str(venue), {"races": {}})["races"][str(race)] = parsed
            except Exception as exc:  # One venue must not block every other venue.
                failures.append(f"{venue:02d}-{race:02d}: {exc}")
            time.sleep(0.01)

    for stadium in stadiums.values():
        stadium["races"] = dict(sorted(stadium["races"].items(), key=lambda x: int(x[0])))
    stadiums = dict(sorted(stadiums.items(), key=lambda x: int(x[0])))
    race_count = sum(len(s["races"]) for s in stadiums.values())
    expected = len(venues) * 12
    if not stadiums or race_count != expected:
        sample = "; ".join(failures[:5])
        raise IncompleteProgramError(f"Next-day program is incomplete ({race_count}/{expected} races). {sample}")
    return {
        "date": date,
        "generated_at": datetime.now(JST).isoformat(timespec="seconds"),
        "source": "BOAT RACE official next-day program",
        "programs": {"stadiums": stadiums},
    }


def main() -> int:
    target = (datetime.now(JST) + timedelta(days=1)).strftime("%Y%m%d")
    output = Path(sys.argv[1] if len(sys.argv) > 1 else "dev/tomorrow.json")
    try:
        payload = build(target)
    except IncompleteProgramError as exc:
        print(f"Waiting for official next-day data: {exc}")
        return 0
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    races = sum(len(x["races"]) for x in payload["programs"]["stadiums"].values())
    print(f"Wrote {output}: {target}, {len(payload['programs']['stadiums'])} venues, {races} races")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
