#!/usr/bin/env python3
"""Compare the current V8 feature set with the leak-safe racer aptitude set."""

from __future__ import annotations

import argparse
import itertools
import json
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.impute import SimpleImputer
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OrdinalEncoder

from build_features import FEATURE_BASES as GENERATED_FEATURE_BASES


BASE_FEATURES = [
    "PLACE", "RACE", "MONTH", "DAYOFWEEK", "LANE",
    "AGE", "WEIGHT", "ST_AVG", "CLASS", "L", "F", "WIN1RATE", "WIN2RATE",
    "LOCALWIN1RATE", "LOCALWIN2RATE", "MOTORWIN2RATE", "MOTORWIN3RATE",
    "BOATWIN2RATE", "BOATWIN3RATE",
]
APTITUDE_FEATURES = [value for value in GENERATED_FEATURE_BASES if value != "RACER_ID"]


def parse_order(value):
    if pd.isna(value):
        return None
    text = str(value).replace(" ", "")
    for separator in (">", "-", "="):
        if separator in text:
            parts = text.split(separator)
            break
    else:
        parts = list(text)
    values = tuple(int(part) for part in parts if str(part).isdigit())
    return values if len(values) >= 3 else None


def wide_to_long(raw: pd.DataFrame) -> pd.DataFrame:
    dates = pd.to_datetime(raw["RACEDATE"], errors="coerce")
    orders = raw["RENTAN3"].map(parse_order)
    rows = []
    for lane in range(1, 7):
        part = pd.DataFrame(index=raw.index)
        part["race_row"] = raw.index
        part["PLACE"] = raw["PLACE"].astype(str)
        part["RACE"] = pd.to_numeric(raw["RACE"], errors="coerce")
        part["MONTH"] = dates.dt.month
        part["DAYOFWEEK"] = dates.dt.dayofweek
        part["LANE"] = lane
        for feature in BASE_FEATURES[5:]:
            part[feature] = pd.to_numeric(raw[f"{feature}{lane}"], errors="coerce")
        for feature in APTITUDE_FEATURES:
            part[feature] = pd.to_numeric(raw[f"{feature}{lane}"], errors="coerce")
        for rank in (1, 2, 3):
            part[f"y{rank}"] = orders.map(lambda order, rank=rank: int(bool(order) and order[rank - 1] == lane))
        part["split"] = raw["split"].astype(str)
        rows.append(part)
    return pd.concat(rows, ignore_index=True)


def make_model(features: list[str]) -> Pipeline:
    numeric = [feature for feature in features if feature != "PLACE"]
    preprocessor = ColumnTransformer([
        ("cat", Pipeline([
            ("impute", SimpleImputer(strategy="most_frequent")),
            ("encode", OrdinalEncoder(handle_unknown="use_encoded_value", unknown_value=-1)),
        ]), ["PLACE"]),
        ("numeric", Pipeline([("impute", SimpleImputer(strategy="median"))]), numeric),
    ])
    classifier = HistGradientBoostingClassifier(
        learning_rate=0.08,
        max_iter=180,
        max_leaf_nodes=31,
        l2_regularization=1.0,
        random_state=42,
    )
    return Pipeline([("pre", preprocessor), ("clf", classifier)])


def calibrated(calibrator: IsotonicRegression, probability: np.ndarray) -> np.ndarray:
    return np.clip(calibrator.predict(probability), 1e-6, 1 - 1e-6)


def calibration_error(y: np.ndarray, probability: np.ndarray, bins: int = 10) -> float:
    edges = np.linspace(0, 1, bins + 1)
    assignments = np.minimum(np.digitize(probability, edges[1:-1]), bins - 1)
    total = len(y)
    error = 0.0
    for index in range(bins):
        mask = assignments == index
        if mask.any():
            error += mask.sum() / total * abs(float(probability[mask].mean()) - float(y[mask].mean()))
    return float(error)


def race_pick_accuracy(frame: pd.DataFrame, probability: np.ndarray, target: str) -> float:
    selected = frame[["race_row", "LANE", target]].copy()
    selected["probability"] = probability
    prediction = selected.loc[selected.groupby("race_row")["probability"].idxmax()].set_index("race_row")["LANE"]
    actual = selected[selected[target] == 1].set_index("race_row")["LANE"]
    common = prediction.index.intersection(actual.index)
    return float((prediction.loc[common] == actual.loc[common]).mean())


def combo_probabilities(lanes, p1, p2, p3):
    probabilities = []
    for first, second, third in itertools.permutations(range(len(lanes)), 3):
        remaining_second = [index for index in range(len(lanes)) if index != first]
        denominator_second = p2[remaining_second].sum()
        q2 = p2[second] / denominator_second if denominator_second else 1 / len(remaining_second)
        remaining_third = [index for index in remaining_second if index != second]
        denominator_third = p3[remaining_third].sum()
        q3 = p3[third] / denominator_third if denominator_third else 1 / len(remaining_third)
        probabilities.append((f"{lanes[first]}-{lanes[second]}-{lanes[third]}", p1[first] * q2 * q3))
    total = sum(value for _, value in probabilities)
    return sorted([(key, value / total) for key, value in probabilities], key=lambda item: item[1], reverse=True)


def race_predictions(raw: pd.DataFrame, frame: pd.DataFrame, probabilities: dict[int, np.ndarray], top_k: int = 3):
    work = frame[["race_row", "LANE"]].copy()
    for rank in (1, 2, 3):
        work[f"p{rank}"] = probabilities[rank]
    rows = []
    for race_row, group in work.groupby("race_row", sort=False):
        group = group.sort_values("LANE")
        combinations = combo_probabilities(
            group["LANE"].to_numpy(), group["p1"].to_numpy(), group["p2"].to_numpy(), group["p3"].to_numpy()
        )
        actual_order = parse_order(raw.loc[race_row, "RENTAN3"])
        payout = pd.to_numeric(raw.loc[race_row, "RENTAN3K"], errors="coerce")
        if not actual_order or pd.isna(payout):
            continue
        actual = "-".join(map(str, actual_order[:3]))
        picks = [key for key, _ in combinations[:top_k]]
        p1_sorted = np.sort(group["p1"].to_numpy())[::-1]
        rows.append({
            "race_row": int(race_row),
            "actual": actual,
            "top_exact": int(combinations[0][0] == actual),
            "hit": int(actual in picks),
            "return_yen": float(payout) if actual in picks else 0.0,
            "top_combo_prob": float(combinations[0][1]),
            "top1_lane_gap": float(p1_sorted[0] - p1_sorted[1]),
        })
    return pd.DataFrame(rows)


def performance(rows: pd.DataFrame, top_k: int = 3) -> dict[str, float | int]:
    bet = len(rows) * top_k * 100
    returned = rows["return_yen"].sum() if len(rows) else 0.0
    return {
        "races": int(len(rows)),
        "hits": int(rows["hit"].sum()) if len(rows) else 0,
        "hit_rate": float(rows["hit"].mean()) if len(rows) else float("nan"),
        "top_exact_rate": float(rows["top_exact"].mean()) if len(rows) else float("nan"),
        "bet_yen": int(bet),
        "return_yen": float(returned),
        "roi": float(returned / bet) if bet else float("nan"),
    }


def choose_rule(rows: pd.DataFrame, minimum: int = 300) -> tuple[float, float, dict[str, Any]]:
    probability_grid = np.unique(np.quantile(rows["top_combo_prob"], np.linspace(0.05, 0.90, 18)))
    gap_grid = np.unique(np.quantile(rows["top1_lane_gap"], np.linspace(0, 0.80, 9)))
    candidates = []
    for probability in probability_grid:
        for gap in gap_grid:
            selected = rows[(rows["top_combo_prob"] >= probability) & (rows["top1_lane_gap"] >= gap)]
            if len(selected) < minimum:
                continue
            result = performance(selected)
            shrink = min(1.0, len(selected) / (minimum * 2))
            score = 1.0 + (result["roi"] - 1.0) * shrink
            candidates.append((score, result["roi"], len(selected), float(probability), float(gap), result))
    if not candidates:
        raise ValueError("no selective rule candidate")
    candidates.sort(reverse=True)
    best = candidates[0]
    return best[3], best[4], best[5]


def train_variant(name: str, raw: pd.DataFrame, long: pd.DataFrame, features: list[str], output: Path) -> dict:
    train = long[long["split"].eq("train")].copy()
    valid = long[long["split"].eq("validate")].copy()
    test = long[long["split"].eq("test")].copy()
    metrics: dict[str, Any] = {"feature_count": len(features), "features": features}
    models = {}
    calibrators = {}
    valid_probabilities = {}
    test_probabilities = {}

    variant_dir = output / name
    variant_dir.mkdir(parents=True, exist_ok=True)
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
        models[rank] = model
        calibrators[rank] = calibrator
        valid_probabilities[rank] = valid_probability
        test_probabilities[rank] = test_probability
        joblib.dump(model, variant_dir / f"rank{rank}.joblib")
        joblib.dump(calibrator, variant_dir / f"cal_rank{rank}.joblib")

    valid_races = race_predictions(raw, valid, valid_probabilities)
    test_races = race_predictions(raw, test, test_probabilities)
    probability_threshold, gap_threshold, validation_selected = choose_rule(valid_races)
    test_selected = test_races[
        (test_races["top_combo_prob"] >= probability_threshold)
        & (test_races["top1_lane_gap"] >= gap_threshold)
    ]
    metrics["all_test_races"] = performance(test_races)
    metrics["purchase_recommended"] = {
        "rule": {"top_combo_prob_min": probability_threshold, "top1_lane_gap_min": gap_threshold},
        "validation": validation_selected,
        "test": performance(test_selected),
    }
    joblib.dump({"features": features, "metrics": metrics, "version": name}, variant_dir / "meta.joblib")
    (variant_dir / "metrics.json").write_text(json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8")
    test_selected.to_csv(variant_dir / "selected_test.csv", index=False)
    return metrics


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("csv", type=Path)
    parser.add_argument("--output", type=Path, default=Path("backtest-output"))
    parser.add_argument("--ablations", action="store_true", help="長期適性・直近フォーム・決まり手を段階比較")
    args = parser.parse_args()
    raw = pd.read_csv(args.csv)
    long = wide_to_long(raw)
    args.output.mkdir(parents=True, exist_ok=True)
    variants = {"baseline": BASE_FEATURES}
    if args.ablations:
        long_term = [feature for feature in APTITUDE_FEATURES if feature.startswith("APT_")]
        form = [feature for feature in APTITUDE_FEATURES if feature.startswith("FORM")]
        technique = [feature for feature in APTITUDE_FEATURES if feature.startswith("TECH_")]
        variants.update({
            "aptitude_long_term": BASE_FEATURES + long_term,
            "aptitude_plus_form": BASE_FEATURES + long_term + form,
            "aptitude_full": BASE_FEATURES + long_term + form + technique,
        })
    else:
        variants["aptitude"] = BASE_FEATURES + APTITUDE_FEATURES
    comparison = {
        name: train_variant(name, raw, long, features, args.output)
        for name, features in variants.items()
    }
    (args.output / "comparison.json").write_text(json.dumps(comparison, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(comparison, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
