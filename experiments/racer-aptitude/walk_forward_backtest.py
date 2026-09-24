#!/usr/bin/env python3
"""Three-fold walk-forward evaluation for V8 racer aptitude features."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score

from backtest_aptitude import (
    APTITUDE_FEATURES,
    BASE_FEATURES,
    calibrated,
    calibration_error,
    choose_rule,
    make_model,
    performance,
    race_pick_accuracy,
    race_predictions,
    wide_to_long,
)


FOLDS = [
    {
        "name": "fold1_2024_autumn",
        "train": ("2024-04-01", "2024-08-31"),
        "validate": ("2024-09-01", "2024-09-30"),
        "test": ("2024-10-01", "2024-11-30"),
    },
    {
        "name": "fold2_2024winter_2025jan",
        "train": ("2024-04-01", "2024-10-31"),
        "validate": ("2024-11-01", "2024-11-30"),
        "test": ("2024-12-01", "2025-01-31"),
    },
    {
        "name": "fold3_2025_spring",
        "train": ("2024-04-01", "2024-12-31"),
        "validate": ("2025-01-01", "2025-02-13"),
        "test": ("2025-02-14", "2025-03-31"),
    },
]


def assign_split(raw: pd.DataFrame, fold: dict[str, Any]) -> pd.Series:
    dates = pd.to_datetime(raw["RACEDATE"])
    output = pd.Series("unused", index=raw.index, dtype="object")
    for split in ("train", "validate", "test"):
        start, end = pd.to_datetime(fold[split][0]), pd.to_datetime(fold[split][1])
        output.loc[dates.between(start, end)] = split
    return output


def evaluate_variant(
    raw: pd.DataFrame,
    long: pd.DataFrame,
    features: list[str],
    minimum_recommended: int,
) -> dict[str, Any]:
    train = long[long["fold_split"].eq("train")].copy()
    valid = long[long["fold_split"].eq("validate")].copy()
    test = long[long["fold_split"].eq("test")].copy()
    metrics: dict[str, Any] = {
        "feature_count": len(features),
        "train_races": int(train["race_row"].nunique()),
        "validate_races": int(valid["race_row"].nunique()),
        "test_races": int(test["race_row"].nunique()),
    }
    valid_probabilities = {}
    test_probabilities = {}
    for rank in (1, 2, 3):
        model = make_model(features)
        model.fit(train[features], train[f"y{rank}"])
        valid_raw = model.predict_proba(valid[features])[:, 1]
        calibrator = IsotonicRegression(y_min=1e-6, y_max=1 - 1e-6, out_of_bounds="clip")
        calibrator.fit(valid_raw, valid[f"y{rank}"].to_numpy())
        valid_probability = calibrated(calibrator, valid_raw)
        test_raw = model.predict_proba(test[features])[:, 1]
        test_probability = calibrated(calibrator, test_raw)
        y_test = test[f"y{rank}"].to_numpy()
        metrics[f"rank{rank}"] = {
            "auc": float(roc_auc_score(y_test, test_probability)),
            "brier": float(brier_score_loss(y_test, test_probability)),
            "log_loss": float(log_loss(y_test, test_probability)),
            "ece10": calibration_error(y_test, test_probability),
            "race_pick_accuracy": race_pick_accuracy(test, test_probability, f"y{rank}"),
        }
        valid_probabilities[rank] = valid_probability
        test_probabilities[rank] = test_probability

    valid_races = race_predictions(raw, valid, valid_probabilities)
    test_races = race_predictions(raw, test, test_probabilities)
    probability_threshold, gap_threshold, validation_selected = choose_rule(
        valid_races, minimum=minimum_recommended
    )
    selected = test_races[
        (test_races["top_combo_prob"] >= probability_threshold)
        & (test_races["top1_lane_gap"] >= gap_threshold)
    ]
    metrics["all_test_races"] = performance(test_races)
    metrics["purchase_recommended"] = {
        "rule": {
            "top_combo_prob_min": probability_threshold,
            "top1_lane_gap_min": gap_threshold,
        },
        "validation": validation_selected,
        "test": performance(selected),
    }
    return metrics


def combine_performance(items: list[dict[str, Any]]) -> dict[str, Any]:
    races = sum(item["races"] for item in items)
    hits = sum(item["hits"] for item in items)
    bet = sum(item["bet_yen"] for item in items)
    returned = sum(item["return_yen"] for item in items)
    exact_hits = sum(item["top_exact_rate"] * item["races"] for item in items)
    return {
        "races": races,
        "hits": hits,
        "hit_rate": hits / races if races else None,
        "top_exact_rate": exact_hits / races if races else None,
        "bet_yen": bet,
        "return_yen": returned,
        "roi": returned / bet if bet else None,
    }


def aggregate(folds: dict[str, dict[str, Any]]) -> dict[str, Any]:
    fold_values = list(folds.values())
    test_races = [value["all_test_races"] for value in fold_values]
    selected = [value["purchase_recommended"]["test"] for value in fold_values]
    output: dict[str, Any] = {
        "all_test_races": combine_performance(test_races),
        "purchase_recommended": combine_performance(selected),
    }
    total_test = sum(value["test_races"] for value in fold_values)
    for rank in (1, 2, 3):
        output[f"rank{rank}"] = {
            metric: sum(value[f"rank{rank}"][metric] * value["test_races"] for value in fold_values) / total_test
            for metric in ("auc", "brier", "log_loss", "ece10", "race_pick_accuracy")
        }
    return output


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("csv", type=Path)
    parser.add_argument("--output", type=Path, default=Path("walk-forward-output"))
    parser.add_argument("--minimum-recommended", type=int, default=200)
    args = parser.parse_args()

    args.output.mkdir(parents=True, exist_ok=True)
    destination = args.output / "walk_forward_comparison.json"
    raw = pd.read_csv(args.csv)
    long = wide_to_long(raw)
    variants = {
        "baseline": BASE_FEATURES,
        "aptitude_long_term": BASE_FEATURES + [value for value in APTITUDE_FEATURES if value.startswith("APT_")],
        "aptitude_plus_form": BASE_FEATURES + [
            value for value in APTITUDE_FEATURES if value.startswith("APT_") or value.startswith("FORM")
        ],
        "aptitude_full": BASE_FEATURES + APTITUDE_FEATURES,
    }
    if destination.exists():
        results = json.loads(destination.read_text(encoding="utf-8"))
        for name in variants:
            results.setdefault("variants", {}).setdefault(name, {"folds": {}})
            results["variants"][name].setdefault("folds", {})
    else:
        results = {
            "protocol": {
                "folds": FOLDS,
                "minimum_validation_recommended_races": args.minimum_recommended,
                "tests_are_non_overlapping": True,
            },
            "variants": {name: {"folds": {}} for name in variants},
        }

    for fold in FOLDS:
        split = assign_split(raw, fold)
        long["fold_split"] = split.loc[long["race_row"]].to_numpy()
        for name, features in variants.items():
            if fold["name"] in results["variants"][name]["folds"]:
                continue
            results["variants"][name]["folds"][fold["name"]] = evaluate_variant(
                raw, long, features, args.minimum_recommended
            )
            destination.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")

    for value in results["variants"].values():
        value["aggregate"] = aggregate(value["folds"])

    destination.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
