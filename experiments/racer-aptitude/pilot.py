#!/usr/bin/env python3
"""Build a small, non-production racer aptitude dataset from official BOAT RACE files.

The script downloads the daily B (program) and K (result) archives, parses them,
and writes normalized starts, race-to-training joins, and descriptive aggregates.
It deliberately does not modify the live V8 model or deployed application.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
import statistics
import time
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Iterable

import lhafile


VENUES = {
    "01": "桐生", "02": "戸田", "03": "江戸川", "04": "平和島",
    "05": "多摩川", "06": "浜名湖", "07": "蒲郡", "08": "常滑",
    "09": "津", "10": "三国", "11": "びわこ", "12": "住之江",
    "13": "尼崎", "14": "鳴門", "15": "丸亀", "16": "児島",
    "17": "宮島", "18": "徳山", "19": "下関", "20": "若松",
    "21": "芦屋", "22": "福岡", "23": "唐津", "24": "大村",
}

BRANCHES = (
    "群馬", "埼玉", "東京", "静岡", "愛知", "三重", "福井", "滋賀",
    "大阪", "兵庫", "徳島", "香川", "岡山", "広島", "山口", "福岡",
    "佐賀", "長崎",
)
BRANCH_PATTERN = "|".join(BRANCHES)

BLOCK_RE = re.compile(r"^(\d{2})[BK]BGN$")
RACE_RE = re.compile(r"^\s*([0-9０-９]{1,2})[RＲ]\s")
PROGRAM_ROW_RE = re.compile(
    rf"^([1-6])\s+(\d{{4}})(.+?)(\d{{2}})({BRANCH_PATTERN})(\d{{2}})(A1|A2|B1|B2)\s"
)
RESULT_ROW_RE = re.compile(
    r"^\s*(\S{1,2})\s+([1-6])\s+(\d{4})\s+(.+?)\s+"
    r"(\d{1,3})\s+(\d{1,3})\s+(\d\.\d{2}|\.{1,2})\s+([1-6])\s+"
    r"([FL]?\d?\.\d{2}|\.{1,2})\s+"
)
CONDITION_RE = re.compile(
    r"^\s*(\d{1,2})R\s+.*?H\d+m\s+(\S+)\s+風\s+(.+?)\s+(\d+)m\s+波\s+(\d+)cm"
)
TECHNIQUES = ("まくり差し", "逃げ", "まくり", "差し", "抜き", "恵まれ")
FULLWIDTH_DIGITS = str.maketrans("０１２３４５６７８９", "0123456789")
VENUE_ALIASES = {"琵琶湖": "びわこ"}


def daterange(start: date, end: date) -> Iterable[date]:
    current = start
    while current <= end:
        yield current
        current += timedelta(days=1)


def download(url: str, target: Path, retries: int = 3) -> None:
    if target.exists() and target.stat().st_size > 0:
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    last_error: Exception | None = None
    for attempt in range(retries):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "V8-racer-aptitude-pilot/1.0"})
            with urllib.request.urlopen(request, timeout=30) as response:
                target.write_bytes(response.read())
            return
        except (urllib.error.URLError, TimeoutError) as exc:
            last_error = exc
            time.sleep(1.0 + attempt)
    raise RuntimeError(f"download failed: {url}: {last_error}")


def extract_text(archive: Path) -> str:
    lha = lhafile.Lhafile(str(archive))
    members = lha.namelist()
    if len(members) != 1:
        raise ValueError(f"unexpected archive members: {archive}: {members}")
    return lha.read(members[0]).decode("cp932", errors="replace")


def archive_source(day: date, kind: str, work_dir: Path) -> tuple[str, Path]:
    yyyymm = day.strftime("%Y%m")
    yymmdd = day.strftime("%y%m%d")
    target = work_dir / "archives" / kind / yyyymm / f"{kind.lower()}{yymmdd}.lzh"
    url = f"https://www1.mbrace.or.jp/od2/{kind}/{yyyymm}/{kind.lower()}{yymmdd}.lzh"
    return url, target


def prefetch_archives(days: list[date], work_dir: Path, workers: int = 4) -> None:
    sources = [archive_source(day, kind, work_dir) for day in days for kind in ("B", "K")]
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {executor.submit(download, url, target): url for url, target in sources}
        for future in as_completed(futures):
            future.result()


def clean_name(value: str) -> str:
    return re.sub(r"[\s\u3000]+", "", value)


def numeric_text(value: str) -> int:
    return int(value.translate(FULLWIDTH_DIGITS))


def parse_start(value: str) -> tuple[float | None, str]:
    value = value.strip()
    if not value or value.startswith("."):
        return None, ""
    status = value[0] if value[0] in "FL" else ""
    numeric = value[1:] if status else value
    try:
        timing = float(numeric)
        if status == "F":
            timing = -timing
        return timing, status
    except ValueError:
        return None, status


def parse_finish(value: str) -> tuple[int | None, str]:
    try:
        return int(value), ""
    except ValueError:
        return None, value.strip()


def parse_program(text: str, race_date: str) -> dict[tuple[str, str, int, int], dict[str, Any]]:
    rows: dict[tuple[str, str, int, int], dict[str, Any]] = {}
    venue = ""
    race_no = 0
    for line in text.splitlines():
        block = BLOCK_RE.match(line.strip())
        if block:
            venue = VENUES.get(block.group(1), "")
            race_no = 0
            continue
        race = RACE_RE.match(line)
        if race:
            race_no = numeric_text(race.group(1))
            continue
        match = PROGRAM_ROW_RE.match(line)
        if not match or not venue or not race_no:
            continue
        lane, racer_id, name, age, branch, weight, racer_class = match.groups()
        key = (race_date, venue, race_no, int(lane))
        rows[key] = {
            "racer_id": racer_id,
            "racer_name": clean_name(name),
            "age": int(age),
            "branch": branch,
            "weight": int(weight),
            "class": racer_class,
        }
    return rows


def parse_results(text: str, race_date: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    venue = ""
    race_no = 0
    weather = wind_direction = technique = ""
    wind_speed: int | None = None
    wave_height: int | None = None
    for line in text.splitlines():
        block = BLOCK_RE.match(line.strip())
        if block:
            venue = VENUES.get(block.group(1), "")
            race_no = 0
            continue
        condition = CONDITION_RE.match(line)
        if condition:
            race_no = int(condition.group(1))
            weather = condition.group(2)
            wind_direction = re.sub(r"[\s\u3000]+", "", condition.group(3))
            wind_speed = int(condition.group(4))
            wave_height = int(condition.group(5))
            technique = ""
            continue
        if "ﾚｰｽﾀｲﾑ" in line:
            technique = next((item for item in TECHNIQUES if item in line), "")
            continue
        match = RESULT_ROW_RE.match(line)
        if not match or not venue or not race_no:
            continue
        finish_raw, lane, racer_id, name, motor, boat, exhibition, course, start_raw = match.groups()
        finish, finish_status = parse_finish(finish_raw)
        start_timing, start_status = parse_start(start_raw)
        rows.append({
            "date": race_date,
            "venue": venue,
            "race": race_no,
            "lane": int(lane),
            "racer_id": racer_id,
            "racer_name": clean_name(name),
            "finish": finish,
            "finish_status": finish_status,
            "motor": int(motor),
            "boat": int(boat),
            "exhibition_time": None if exhibition.startswith(".") else float(exhibition),
            "course": int(course),
            "st": start_timing,
            "start_status": start_status,
            "technique": technique if finish == 1 else "",
            "weather": weather,
            "wind_direction": wind_direction,
            "wind_speed_m": wind_speed,
            "wave_height_cm": wave_height,
        })
    return rows


def write_csv(path: Path, rows: list[dict[str, Any]], fields: list[str] | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = fields or (list(rows[0]) if rows else [])
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def rate(count: int, total: int) -> float | None:
    return round(count / total, 6) if total else None


def mean(values: list[float]) -> float | None:
    return round(statistics.fmean(values), 6) if values else None


def stdev(values: list[float]) -> float | None:
    return round(statistics.pstdev(values), 6) if len(values) >= 2 else None


def metric(rows: list[dict[str, Any]]) -> dict[str, Any]:
    completed = [row for row in rows if isinstance(row["finish"], int)]
    starts = len(rows)
    finish = [row["finish"] for row in completed]
    sts = [row["st"] for row in rows if isinstance(row["st"], float)]
    techniques = Counter(row["technique"] for row in rows if row["technique"])
    return {
        "starts": starts,
        "completed_starts": len(completed),
        "win_rate": rate(sum(value == 1 for value in finish), len(completed)),
        "top2_rate": rate(sum(value <= 2 for value in finish), len(completed)),
        "top3_rate": rate(sum(value <= 3 for value in finish), len(completed)),
        "mean_finish": mean([float(value) for value in finish]),
        "mean_st": mean(sts),
        "st_std": stdev(sts),
        "technique_wins": dict(sorted(techniques.items())),
    }


def build_aptitude(rows: list[dict[str, Any]]) -> dict[str, Any]:
    by_racer: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        by_racer[row["racer_id"]].append(row)
    output: dict[str, Any] = {}
    for racer_id, racer_rows in sorted(by_racer.items()):
        latest = max(racer_rows, key=lambda item: (item["date"], item["race"]))
        course = {str(value): metric([r for r in racer_rows if r["course"] == value]) for value in range(1, 7)}
        venues = sorted({r["venue"] for r in racer_rows})
        venue = {value: metric([r for r in racer_rows if r["venue"] == value]) for value in venues}
        venue_course = {
            f"{value}:{course_no}": metric([r for r in racer_rows if r["venue"] == value and r["course"] == course_no])
            for value in venues for course_no in range(1, 7)
            if any(r["venue"] == value and r["course"] == course_no for r in racer_rows)
        }
        output[racer_id] = {
            "racer_name": latest["racer_name"],
            "class": latest.get("class", ""),
            "overall": metric(racer_rows),
            "course": course,
            "venue": venue,
            "venue_course": venue_course,
        }
    return output


def load_training_keys(path: Path, start: str, end: str) -> tuple[set[tuple[str, str, int]], int]:
    keys: set[tuple[str, str, int]] = set()
    rows = 0
    with path.open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            if start <= row["RACEDATE"] <= end:
                venue = VENUE_ALIASES.get(row["PLACE"], row["PLACE"])
                keys.add((row["RACEDATE"], venue, int(row["RACE"])))
                rows += 1
    return keys, rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", default="2025-03-01")
    parser.add_argument("--end", default="2025-03-31")
    parser.add_argument("--training-csv", type=Path, required=True)
    parser.add_argument("--work-dir", type=Path, default=Path("work"))
    parser.add_argument("--output-dir", type=Path, default=Path("output"))
    parser.add_argument("--download-workers", type=int, default=4)
    args = parser.parse_args()

    start_date = datetime.strptime(args.start, "%Y-%m-%d").date()
    end_date = datetime.strptime(args.end, "%Y-%m-%d").date()
    period_tag = f"{start_date:%Y%m%d}_{end_date:%Y%m%d}"
    all_rows: list[dict[str, Any]] = []
    all_program: dict[tuple[str, str, int, int], dict[str, Any]] = {}
    failed: list[dict[str, str]] = []
    daily_counts: list[dict[str, Any]] = []

    days = list(daterange(start_date, end_date))
    prefetch_archives(days, args.work_dir, max(1, args.download_workers))

    for day in days:
        day_program: dict[tuple[str, str, int, int], dict[str, Any]] = {}
        day_results: list[dict[str, Any]] = []
        try:
            for kind in ("B", "K"):
                _, archive = archive_source(day, kind, args.work_dir)
                text = extract_text(archive)
                if kind == "B":
                    day_program = parse_program(text, day.isoformat())
                else:
                    day_results = parse_results(text, day.isoformat())
            for row in day_results:
                program = day_program.get((row["date"], row["venue"], row["race"], row["lane"]), {})
                for field in ("age", "branch", "weight", "class"):
                    row[field] = program.get(field)
                row["program_racer_match"] = program.get("racer_id") == row["racer_id"]
            all_program.update(day_program)
            all_rows.extend(day_results)
            daily_counts.append({"date": day.isoformat(), "program_starts": len(day_program), "result_starts": len(day_results)})
            time.sleep(0.05)
        except Exception as exc:  # keep the pilot auditable when one official daily file is missing
            failed.append({"date": day.isoformat(), "error": str(exc)})

    all_rows.sort(key=lambda row: (row["date"], row["venue"], row["race"], row["lane"]))
    args.output_dir.mkdir(parents=True, exist_ok=True)
    write_csv(args.output_dir / f"racer_starts_{period_tag}.csv", all_rows)

    aptitude = build_aptitude(all_rows)
    (args.output_dir / f"racer_aptitude_{period_tag}.json").write_text(
        json.dumps(aptitude, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    official_races: dict[tuple[str, str, int], list[dict[str, Any]]] = defaultdict(list)
    for row in all_rows:
        official_races[(row["date"], row["venue"], row["race"])].append(row)
    training_keys, training_rows = load_training_keys(args.training_csv, args.start, args.end)
    joined_keys = training_keys & set(official_races)
    complete_joined_keys = {key for key in joined_keys if len(official_races[key]) == 6}
    complete_program_keys = {
        key for key in training_keys
        if all((key[0], key[1], key[2], lane) in all_program for lane in range(1, 7))
    }
    join_rows = []
    for key in sorted(training_keys):
        result_starts = official_races.get(key, [])
        program_starts = [all_program.get((key[0], key[1], key[2], lane), {}) for lane in range(1, 7)]
        join_rows.append({
            "date": key[0], "venue": key[1], "race": key[2],
            "registration_ids_complete": key in complete_program_keys,
            "results_complete": len(result_starts) == 6,
            **{f"racer_id_{lane}": program_starts[lane - 1].get("racer_id", "") for lane in range(1, 7)},
        })
    write_csv(args.output_dir / f"training_join_{period_tag}.csv", join_rows)

    complete_races = sum(len(rows) == 6 for rows in official_races.values())
    program_matches = sum(bool(row["program_racer_match"]) for row in all_rows)
    summary = {
        "period": {"start": args.start, "end": args.end},
        "source": "BOAT RACE official B/K daily archives",
        "days_requested": (end_date - start_date).days + 1,
        "days_parsed": len(daily_counts),
        "failed_days": failed,
        "official": {
            "program_starts": len(all_program),
            "races": len(official_races),
            "complete_six_boat_races": complete_races,
            "starts": len(all_rows),
            "racers": len(aptitude),
            "venues": len({row["venue"] for row in all_rows}),
            "program_result_racer_matches": program_matches,
            "program_result_match_rate": rate(program_matches, len(all_rows)),
            "missing_st": sum(row["st"] is None for row in all_rows),
            "missing_exhibition_time": sum(row["exhibition_time"] is None for row in all_rows),
            "nonstandard_finish": sum(row["finish"] is None for row in all_rows),
        },
        "training_csv": {
            "races_in_period": training_rows,
            "complete_registration_id_matches": len(complete_program_keys),
            "registration_id_join_rate": rate(len(complete_program_keys), training_rows),
            "race_key_matches": len(joined_keys),
            "race_key_match_rate": rate(len(joined_keys), training_rows),
            "complete_six_boat_matches": len(complete_joined_keys),
            "complete_join_rate": rate(len(complete_joined_keys), training_rows),
        },
        "daily_counts": daily_counts,
    }
    (args.output_dir / f"pilot_summary_{period_tag}.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
