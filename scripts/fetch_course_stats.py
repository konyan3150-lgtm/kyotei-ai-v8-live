#!/usr/bin/env python3
"""Update course-by-course racer statistics for today's BOAT RACE program."""

from __future__ import annotations

import argparse
import json
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import requests
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

JST = timezone(timedelta(hours=9))
PROGRAM_URL = "https://boatraceopenapi.github.io/api/v1/{year}/{date}.json"
PROGRAM_FALLBACK_URL = "https://boatraceopenapi.github.io/api/v1/today.json"
COURSE_URL = "https://www.boatrace.jp/owpc/pc/data/racersearch/course?toban={number}"
USER_AGENT = "kyotei-ai-v8-live/1.0 (daily course statistics updater)"
_thread_local = threading.local()


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_utc(value: datetime | None = None) -> str:
    return (value or utc_now()).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def session() -> requests.Session:
    cached = getattr(_thread_local, "session", None)
    if cached is not None:
        return cached
    cached = requests.Session()
    retry = Retry(
        total=3,
        connect=3,
        read=3,
        backoff_factor=0.8,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=frozenset(("GET",)),
    )
    cached.mount("https://", HTTPAdapter(max_retries=retry))
    cached.headers.update({"User-Agent": USER_AGENT, "Accept-Language": "ja,en;q=0.7"})
    _thread_local.session = cached
    return cached


def number_or_none(text: str | None) -> float | None:
    if text is None:
        return None
    cleaned = text.replace("%", "").replace("－", "-").strip()
    if not cleaned or cleaned in {"-", "--", "- -"}:
        return None
    match = re.search(r"-?\d+(?:\.\d+)?", cleaned)
    return float(match.group()) if match else None


def style_width(element: Any) -> float | None:
    match = re.search(r"width\s*:\s*(-?\d+(?:\.\d+)?)%", element.get("style", ""))
    return float(match.group(1)) if match else None


def find_table(soup: BeautifulSoup, title: str) -> Any:
    for table in soup.select("main table"):
        heading = table.select_one("thead th")
        if heading and title in heading.get_text(" ", strip=True):
            return table
    raise ValueError(f"table not found: {title}")


def empty_courses() -> dict[str, dict[str, float | None]]:
    return {
        str(course): {
            "entryRate": None,
            "avgStart": None,
            "win1": 0.0,
            "win2": 0.0,
            "win3": 0.0,
        }
        for course in range(1, 7)
    }


def table_labels(table: Any) -> dict[str, float | None]:
    result: dict[str, float | None] = {}
    for row in table.select("tbody tr"):
        lane = row.select_one("th")
        label = row.select_one(".table1_progress2Label")
        if not lane or not label:
            continue
        key = lane.get_text(strip=True)
        if key in {"1", "2", "3", "4", "5", "6"}:
            result[key] = number_or_none(label.get_text(" ", strip=True))
    return result


def fetch_racer(number: str, fallback_name: str) -> tuple[str, dict[str, Any]]:
    response = session().get(COURSE_URL.format(number=number), timeout=30)
    response.raise_for_status()
    response.encoding = response.apparent_encoding or response.encoding
    soup = BeautifulSoup(response.text, "lxml")
    courses = empty_courses()

    entries = table_labels(find_table(soup, "コース別進入率"))
    starts = table_labels(find_table(soup, "コース別平均スタートタイミング"))
    triple_table = find_table(soup, "コース別3連対率")

    for course in courses:
        courses[course]["entryRate"] = entries.get(course)
        courses[course]["avgStart"] = starts.get(course)

    for row in triple_table.select("tbody tr"):
        lane = row.select_one("th")
        if not lane:
            continue
        course = lane.get_text(strip=True)
        if course not in courses:
            continue
        for bar in row.select(".table1_progress2Bar > span.is-progress"):
            value = style_width(bar)
            inner = bar.find("span")
            classes = set(inner.get("class", [])) if inner else set()
            if value is None:
                continue
            if "is-progress1" in classes:
                courses[course]["win1"] = value
            elif "is-progress2" in classes:
                courses[course]["win2"] = value
            elif "is-progress3" in classes:
                courses[course]["win3"] = value

    heading = soup.select_one("main h2")
    page_name = fallback_name
    if heading:
        match = re.match(r"(.+?)（コース別成績）", heading.get_text(" ", strip=True))
        if match:
            page_name = re.sub(r"[　\s]+", " ", match.group(1)).strip()

    time.sleep(0.15)
    return number, {
        "number": number,
        "courses": courses,
        "fetchedAt": iso_utc(),
        "name": page_name,
    }


def fetch_program(date: str) -> dict[str, Any]:
    urls = [
        PROGRAM_URL.format(year=date[:4], date=date),
        PROGRAM_FALLBACK_URL,
    ]
    last_error: Exception | None = None
    for url in urls:
        try:
            response = session().get(url, timeout=30)
            response.raise_for_status()
            payload = response.json()
            if payload.get("programs", {}).get("stadiums"):
                return payload
        except Exception as exc:
            last_error = exc
    raise RuntimeError(f"program fetch failed for {date}: {last_error}")


def program_targets(program: dict[str, Any]) -> tuple[dict[str, str], list[dict[str, Any]]]:
    targets: dict[str, str] = {}
    coverage: list[dict[str, Any]] = []
    stadiums = program.get("programs", {}).get("stadiums", {})
    for stadium, stadium_data in sorted(stadiums.items(), key=lambda item: int(item[0])):
        races = stadium_data.get("races", {}) or {}
        racers: set[str] = set()
        for race_data in races.values():
            for racer in (race_data.get("racers", {}) or {}).values():
                number = str(racer.get("number") or "").strip()
                if not number:
                    continue
                name = re.sub(r"[　\s]+", " ", str(racer.get("name") or "")).strip()
                targets[number] = name
                racers.add(number)
        coverage.append(
            {
                "stadium": str(stadium),
                "races": sorted((str(key) for key in races), key=int),
                "racers": sorted(racers, key=int),
            }
        )
    return targets, coverage


def parse_fetched_at(value: Any) -> datetime | None:
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


def load_cache(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if payload.get("schema") == "kyotei-course-stats":
            return payload
    except (OSError, json.JSONDecodeError):
        pass
    return {}


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("output", nargs="?", default="course-stats.json")
    parser.add_argument("--date", help="JST date in YYYYMMDD format")
    parser.add_argument("--refresh-days", type=int, default=30)
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()

    date = args.date or datetime.now(JST).strftime("%Y%m%d")
    output = Path(args.output)
    cache = load_cache(output)
    racers: dict[str, Any] = dict(cache.get("racers") or {})

    program = fetch_program(date)
    targets, coverage = program_targets(program)
    cutoff = utc_now() - timedelta(days=max(1, args.refresh_days))
    pending: list[tuple[str, str]] = []
    for number, name in targets.items():
        existing = racers.get(number)
        fetched_at = parse_fetched_at(existing.get("fetchedAt")) if isinstance(existing, dict) else None
        complete = isinstance(existing, dict) and isinstance(existing.get("courses"), dict) and len(existing["courses"]) == 6
        if not complete or fetched_at is None or fetched_at < cutoff:
            pending.append((number, name))

    print(f"date={date} target={len(targets)} cached={len(racers)} fetch={len(pending)}")
    unchanged = (
        not pending
        and cache.get("date") == date
        and cache.get("targetCount") == len(targets)
        and cache.get("coverage") == coverage
    )
    if unchanged:
        print("course statistics are already current")
        return 0

    failures: list[tuple[str, str]] = []
    with ThreadPoolExecutor(max_workers=max(1, min(args.workers, 6))) as executor:
        futures = {
            executor.submit(fetch_racer, number, name): (number, name)
            for number, name in pending
        }
        completed = 0
        for future in as_completed(futures):
            number, name = futures[future]
            try:
                key, racer = future.result()
                racers[key] = racer
            except Exception as exc:
                failures.append((number, str(exc)))
                print(f"WARN {number} {name}: {exc}")
            completed += 1
            if completed % 25 == 0 or completed == len(pending):
                print(f"progress={completed}/{len(pending)} failures={len(failures)}")

    available = sum(1 for number in targets if number in racers)
    payload = {
        "schema": "kyotei-course-stats",
        "date": date,
        "generatedAt": iso_utc(),
        "targetCount": len(targets),
        "coverage": coverage,
        "racers": dict(sorted(racers.items(), key=lambda item: int(item[0]))),
        "update": {
            "requested": len(pending),
            "succeeded": len(pending) - len(failures),
            "failed": len(failures),
            "availableForToday": available,
        },
    }
    write_json(output, payload)
    print(f"wrote={output} available={available}/{len(targets)} totalCached={len(racers)}")
    if failures and available < max(1, int(len(targets) * 0.9)):
        raise RuntimeError(f"coverage too low: {available}/{len(targets)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
