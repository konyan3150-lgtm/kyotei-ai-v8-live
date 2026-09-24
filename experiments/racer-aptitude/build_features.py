#!/usr/bin/env python3
"""Create leak-safe racer aptitude features for the existing wide training CSV.

Every feature for a target date is calculated only from result rows whose date is
strictly earlier than the target date. Same-day results are intentionally excluded.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
from collections import Counter, defaultdict, deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Iterator

import pandas as pd


VENUE_ALIASES = {"琵琶湖": "びわこ"}
DEFAULTS = {"win": 1 / 6, "top2": 2 / 6, "top3": 3 / 6, "finish": 3.5, "st": 0.17}
TECHNIQUE_COLUMNS = {
    "逃げ": "TECH_ESCAPE",
    "差し": "TECH_SASHI",
    "まくり": "TECH_MAKURI",
    "まくり差し": "TECH_MAKURISASHI",
    "抜き": "TECH_NUKI",
    "恵まれ": "TECH_LUCKY",
}
FEATURE_BASES = [
    "RACER_ID",
    "APT_STARTS", "APT_WIN", "APT_TOP2", "APT_TOP3", "APT_MEAN_FINISH", "APT_MEAN_ST", "APT_ST_STD",
    "APT_COURSE_STARTS", "APT_COURSE_WIN", "APT_COURSE_TOP2", "APT_COURSE_TOP3", "APT_COURSE_ST",
    "APT_VENUE_STARTS", "APT_VENUE_WIN", "APT_VENUE_TOP2", "APT_VENUE_TOP3", "APT_VENUE_ST",
    "APT_VC_STARTS", "APT_SELECTED_WIN", "APT_SELECTED_TOP2", "APT_SELECTED_TOP3", "APT_SELECTED_ST",
    "APT_VENUE_COURSE_ADV",
    "FORM10_STARTS", "FORM10_WIN", "FORM10_TOP2", "FORM10_MEAN_FINISH", "FORM10_MEAN_ST",
    "FORM30_STARTS", "FORM30_WIN", "FORM30_TOP2", "FORM30_MEAN_FINISH", "FORM30_MEAN_ST",
    "FORM50_STARTS", "FORM50_WIN", "FORM50_TOP2", "FORM50_MEAN_FINISH", "FORM50_MEAN_ST",
    *[f"{value}_RATE" for value in TECHNIQUE_COLUMNS.values()],
]


def number(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        parsed = float(value)
        return parsed if math.isfinite(parsed) else None
    except (TypeError, ValueError):
        return None


@dataclass
class Stats:
    starts: int = 0
    completed: int = 0
    wins: int = 0
    top2: int = 0
    top3: int = 0
    finish_sum: float = 0.0
    st_count: int = 0
    st_sum: float = 0.0
    st_sq_sum: float = 0.0
    techniques: Counter[str] = field(default_factory=Counter)

    def add(self, row: dict[str, Any]) -> None:
        self.starts += 1
        finish = number(row.get("finish"))
        if finish is not None:
            rank = int(finish)
            self.completed += 1
            self.wins += rank == 1
            self.top2 += rank <= 2
            self.top3 += rank <= 3
            self.finish_sum += rank
        st = number(row.get("st"))
        if st is not None:
            self.st_count += 1
            self.st_sum += st
            self.st_sq_sum += st * st
        technique = row.get("technique", "")
        if technique:
            self.techniques[technique] += 1

    def raw(self) -> dict[str, float]:
        denominator = self.completed or 1
        st_denominator = self.st_count or 1
        st_mean = self.st_sum / st_denominator if self.st_count else DEFAULTS["st"]
        variance = max(0.0, self.st_sq_sum / st_denominator - st_mean * st_mean) if self.st_count else 0.0
        return {
            "win": self.wins / denominator if self.completed else DEFAULTS["win"],
            "top2": self.top2 / denominator if self.completed else DEFAULTS["top2"],
            "top3": self.top3 / denominator if self.completed else DEFAULTS["top3"],
            "finish": self.finish_sum / denominator if self.completed else DEFAULTS["finish"],
            "st": st_mean,
            "st_std": math.sqrt(variance),
        }

    def smoothed(self, prior: dict[str, float], alpha: float = 20.0) -> dict[str, float]:
        n = self.completed
        st_n = self.st_count
        return {
            "win": (self.wins + alpha * prior["win"]) / (n + alpha),
            "top2": (self.top2 + alpha * prior["top2"]) / (n + alpha),
            "top3": (self.top3 + alpha * prior["top3"]) / (n + alpha),
            "finish": (self.finish_sum + alpha * prior["finish"]) / (n + alpha),
            "st": (self.st_sum + alpha * prior["st"]) / (st_n + alpha),
            "st_std": self.raw()["st_std"],
        }


def normalize_venue(value: str) -> str:
    return VENUE_ALIASES.get(value, value)


def history_rows(paths: list[Path]) -> Iterator[dict[str, Any]]:
    previous = ""
    for path in paths:
        with path.open(encoding="utf-8-sig", newline="") as handle:
            for row in csv.DictReader(handle):
                current = row["date"]
                if previous and current < previous:
                    raise ValueError(f"history is not chronological: {path}: {current} < {previous}")
                previous = current
                row["venue"] = normalize_venue(row["venue"])
                yield row


def load_join(path: Path) -> dict[tuple[str, str, int], list[str]]:
    output: dict[tuple[str, str, int], list[str]] = {}
    with path.open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            key = (row["date"], normalize_venue(row["venue"]), int(row["race"]))
            output[key] = [row[f"racer_id_{lane}"] for lane in range(1, 7)]
    return output


class FeatureState:
    def __init__(self) -> None:
        self.global_course: dict[int, Stats] = defaultdict(Stats)
        self.racer: dict[str, Stats] = defaultdict(Stats)
        self.racer_course: dict[tuple[str, int], Stats] = defaultdict(Stats)
        self.racer_venue: dict[tuple[str, str], Stats] = defaultdict(Stats)
        self.racer_vc: dict[tuple[str, str, int], Stats] = defaultdict(Stats)
        self.recent: dict[str, deque[dict[str, Any]]] = defaultdict(lambda: deque(maxlen=50))
        self.latest_date = ""

    def add(self, row: dict[str, Any]) -> None:
        racer_id = row["racer_id"]
        venue = row["venue"]
        course = int(row["course"])
        self.global_course[course].add(row)
        self.racer[racer_id].add(row)
        self.racer_course[(racer_id, course)].add(row)
        self.racer_venue[(racer_id, venue)].add(row)
        self.racer_vc[(racer_id, venue, course)].add(row)
        self.recent[racer_id].append(row)
        self.latest_date = max(self.latest_date, row["date"])

    @staticmethod
    def recent_stats(rows: Iterable[dict[str, Any]]) -> Stats:
        stats = Stats()
        for row in rows:
            stats.add(row)
        return stats

    def features(self, racer_id: str, venue: str, course: int) -> dict[str, Any]:
        global_prior = self.global_course[course].raw()
        overall_stats = self.racer[racer_id]
        overall = overall_stats.smoothed(global_prior, alpha=30)
        course_stats = self.racer_course[(racer_id, course)]
        course_value = course_stats.smoothed(overall, alpha=16)
        venue_stats = self.racer_venue[(racer_id, venue)]
        venue_value = venue_stats.smoothed(overall, alpha=16)
        vc_stats = self.racer_vc[(racer_id, venue, course)]
        vc_prior = {
            key: (course_value[key] + venue_value[key]) / 2
            for key in ("win", "top2", "top3", "finish", "st")
        }
        vc_value = vc_stats.smoothed(vc_prior, alpha=10)
        vc_value["st_std"] = vc_stats.raw()["st_std"]

        if vc_stats.completed >= 8:
            selected = vc_value
        elif course_stats.completed >= 12:
            selected = course_value
        elif venue_stats.completed >= 12:
            selected = venue_value
        else:
            selected = overall

        values: dict[str, Any] = {
            "RACER_ID": racer_id,
            "APT_STARTS": overall_stats.starts,
            "APT_WIN": overall["win"], "APT_TOP2": overall["top2"], "APT_TOP3": overall["top3"],
            "APT_MEAN_FINISH": overall["finish"], "APT_MEAN_ST": overall["st"], "APT_ST_STD": overall["st_std"],
            "APT_COURSE_STARTS": course_stats.starts,
            "APT_COURSE_WIN": course_value["win"], "APT_COURSE_TOP2": course_value["top2"],
            "APT_COURSE_TOP3": course_value["top3"], "APT_COURSE_ST": course_value["st"],
            "APT_VENUE_STARTS": venue_stats.starts,
            "APT_VENUE_WIN": venue_value["win"], "APT_VENUE_TOP2": venue_value["top2"],
            "APT_VENUE_TOP3": venue_value["top3"], "APT_VENUE_ST": venue_value["st"],
            "APT_VC_STARTS": vc_stats.starts,
            "APT_SELECTED_WIN": selected["win"], "APT_SELECTED_TOP2": selected["top2"],
            "APT_SELECTED_TOP3": selected["top3"], "APT_SELECTED_ST": selected["st"],
            "APT_VENUE_COURSE_ADV": selected["win"] - global_prior["win"],
        }

        recent_rows = list(self.recent[racer_id])
        for window in (10, 30, 50):
            stats = self.recent_stats(recent_rows[-window:])
            raw = stats.raw()
            values[f"FORM{window}_STARTS"] = stats.starts
            values[f"FORM{window}_WIN"] = raw["win"]
            values[f"FORM{window}_TOP2"] = raw["top2"]
            values[f"FORM{window}_MEAN_FINISH"] = raw["finish"]
            values[f"FORM{window}_MEAN_ST"] = raw["st"]

        technique_denominator = course_stats.completed or 1
        for technique, column in TECHNIQUE_COLUMNS.items():
            values[f"{column}_RATE"] = course_stats.techniques[technique] / technique_denominator
        return values


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--training-csv", type=Path, required=True)
    parser.add_argument("--join-csv", type=Path, required=True)
    parser.add_argument("--history-csv", type=Path, nargs="+", required=True)
    parser.add_argument("--output-csv", type=Path, required=True)
    parser.add_argument("--audit-json", type=Path, required=True)
    args = parser.parse_args()

    training = pd.read_csv(args.training_csv)
    training["_original_index"] = range(len(training))
    training["_date"] = training["RACEDATE"].astype(str)
    training = training.sort_values(["_date", "PLACE", "RACE"], kind="stable")
    joins = load_join(args.join_csv)

    history = iter(history_rows(args.history_csv))
    current_history = next(history, None)
    state = FeatureState()
    missing_join = 0
    leakage_violations = 0
    target_rows = 0
    output_fields = [column for column in training.columns if not column.startswith("_")]
    output_fields += [f"{feature}{lane}" for lane in range(1, 7) for feature in FEATURE_BASES]
    args.output_csv.parent.mkdir(parents=True, exist_ok=True)

    with args.output_csv.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=output_fields, extrasaction="ignore")
        writer.writeheader()
        for target_date, group in training.groupby("_date", sort=True):
            while current_history is not None and current_history["date"] < target_date:
                state.add(current_history)
                current_history = next(history, None)
            if state.latest_date and state.latest_date >= target_date:
                leakage_violations += 1

            for values in group.itertuples(index=False, name=None):
                base = dict(zip(training.columns, values))
                venue = normalize_venue(str(base["PLACE"]))
                key = (target_date, venue, int(base["RACE"]))
                racer_ids = joins.get(key)
                if not racer_ids or any(not value for value in racer_ids):
                    missing_join += 1
                    racer_ids = racer_ids or [""] * 6
                for lane, racer_id in enumerate(racer_ids, 1):
                    features = state.features(racer_id, venue, lane)
                    for feature, value in features.items():
                        base[f"{feature}{lane}"] = value
                writer.writerow(base)
                target_rows += 1

    audit = {
        "training_rows": target_rows,
        "history_files": [str(path) for path in args.history_csv],
        "latest_history_date_used": state.latest_date,
        "missing_registration_join_rows": missing_join,
        "leakage_violations": leakage_violations,
        "same_day_results_excluded": True,
        "feature_bases": FEATURE_BASES,
        "fallback": "venue-course>=8, else course>=12, else venue>=12, else racer overall",
        "shrinkage": "Bayesian-style smoothing toward broader past-only rates",
    }
    args.audit_json.parent.mkdir(parents=True, exist_ok=True)
    args.audit_json.write_text(json.dumps(audit, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(audit, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
