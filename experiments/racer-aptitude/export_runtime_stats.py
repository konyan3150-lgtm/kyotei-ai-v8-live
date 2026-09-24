#!/usr/bin/env python3
"""Aggregate normalized official starts into the compact runtime aptitude DB."""

from __future__ import annotations

import argparse
import csv
import json
import math
from collections import defaultdict
from pathlib import Path


def blank() -> list[float]:
    # starts, completed, wins, top2, top3, finish_sum, st_count, st_sum, st_sq_sum
    return [0, 0, 0, 0, 0, 0.0, 0, 0.0, 0.0]


def number(value: str) -> float | None:
    try:
        parsed = float(value)
        return parsed if math.isfinite(parsed) else None
    except (TypeError, ValueError):
        return None


def add(stats: list[float], row: dict[str, str]) -> None:
    stats[0] += 1
    finish = number(row.get("finish", ""))
    if finish is not None:
        rank = int(finish)
        stats[1] += 1
        stats[2] += int(rank == 1)
        stats[3] += int(rank <= 2)
        stats[4] += int(rank <= 3)
        stats[5] += rank
    st = number(row.get("st", ""))
    if st is not None:
        stats[6] += 1
        stats[7] += st
        stats[8] += st * st


def compact(stats: list[float]) -> list[float | int]:
    return [int(v) for v in stats[:5]] + [round(stats[5], 3), int(stats[6]), round(stats[7], 6), round(stats[8], 8)]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--starts", type=Path, nargs="+", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    global_course = defaultdict(blank)
    racers: dict[str, dict] = {}
    first_date = "9999-99-99"
    through_date = ""
    rows = 0
    for path in args.starts:
        with path.open(encoding="utf-8-sig", newline="") as handle:
            for row in csv.DictReader(handle):
                racer_id = str(row["racer_id"])
                venue = "びわこ" if row["venue"] == "琵琶湖" else row["venue"]
                course = str(int(row["course"]))
                day = row["date"]
                first_date = min(first_date, day)
                through_date = max(through_date, day)
                racer = racers.setdefault(racer_id, {"o": blank(), "c": defaultdict(blank), "v": defaultdict(blank), "x": defaultdict(blank)})
                for target in (global_course[course], racer["o"], racer["c"][course], racer["v"][venue], racer["x"][f"{venue}:{course}"]):
                    add(target, row)
                rows += 1

    packed = {}
    for racer_id, racer in racers.items():
        packed[racer_id] = {
            "o": compact(racer["o"]),
            "c": {key: compact(value) for key, value in racer["c"].items()},
            "v": {key: compact(value) for key, value in racer["v"].items()},
            "x": {key: compact(value) for key, value in racer["x"].items()},
        }
    payload = {
        "schema": "kyotei-v8-racer-aptitude",
        "version": 1,
        "from": first_date,
        "through": through_date,
        "starts": rows,
        "racers_count": len(packed),
        "fields": ["starts", "completed", "wins", "top2", "top3", "finish_sum", "st_count", "st_sum", "st_sq_sum"],
        "global_course": {key: compact(value) for key, value in global_course.items()},
        "racers": packed,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({key: payload[key] for key in ("from", "through", "starts", "racers_count")}, ensure_ascii=False))
    print(f"wrote {args.output} ({args.output.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
