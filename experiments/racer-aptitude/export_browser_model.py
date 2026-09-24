#!/usr/bin/env python3
"""Export the validated sklearn V8 pipeline to the compact browser JSON format."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import joblib
import numpy as np
import pandas as pd


def export_rank(model_path: Path, calibrator_path: Path) -> dict:
    model = joblib.load(model_path)
    calibrator = joblib.load(calibrator_path)
    pre = model.named_steps["pre"]
    clf = model.named_steps["clf"]
    categories = pre.named_transformers_["cat"].named_steps["encode"].categories_[0].tolist()
    medians = pre.named_transformers_["numeric"].named_steps["impute"].statistics_.tolist()
    trees = []
    for iteration in clf._predictors:
        if len(iteration) != 1:
            raise ValueError("multiclass predictors are not supported")
        nodes = iteration[0].nodes
        trees.append([
            [
                int(node["feature_idx"]),
                float(node["num_threshold"]),
                int(node["left"]),
                int(node["right"]),
                bool(node["missing_go_to_left"]),
                bool(node["is_leaf"]),
                float(node["value"]),
            ]
            for node in nodes
        ])
    return {
        "baseline": float(np.asarray(clf._baseline_prediction).reshape(-1)[0]),
        "categories": categories,
        "medians": medians,
        "trees": trees,
        "cal_x": calibrator.X_thresholds_.tolist(),
        "cal_y": calibrator.y_thresholds_.tolist(),
    }


def interpolate(value: float, xs: list[float], ys: list[float]) -> float:
    return float(np.interp(value, xs, ys))


def json_predict(rank: dict, row: pd.Series, features: list[str]) -> float:
    category = str(row[features[0]])
    try:
        category_value = rank["categories"].index(category)
    except ValueError:
        category_value = -1
    values = [float(category_value)]
    for index, feature in enumerate(features[1:]):
        value = pd.to_numeric(pd.Series([row[feature]]), errors="coerce").iloc[0]
        values.append(float(value) if pd.notna(value) else float(rank["medians"][index]))
    raw = rank["baseline"]
    for tree in rank["trees"]:
        index = 0
        while not tree[index][5]:
            feature, threshold, left, right, missing_left, _, _ = tree[index]
            value = values[feature]
            index = left if (math.isnan(value) and missing_left) or (not math.isnan(value) and value <= threshold) else right
        raw += tree[index][6]
    probability = 1 / (1 + math.exp(-raw))
    return interpolate(probability, rank["cal_x"], rank["cal_y"])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--verify-csv", type=Path)
    parser.add_argument("--version", default="v8-aptitude-long-term-1")
    args = parser.parse_args()

    meta = joblib.load(args.model_dir / "meta.joblib")
    features = list(meta["features"])
    ranks = {
        str(rank): export_rank(args.model_dir / f"rank{rank}.joblib", args.model_dir / f"cal_rank{rank}.joblib")
        for rank in (1, 2, 3)
    }
    rule = meta.get("metrics", {}).get("purchase_recommended", {}).get("rule", {})
    payload = {"version": args.version, "features": features, "ranks": ranks, "rule": rule}

    if args.verify_csv:
        frame = pd.read_csv(args.verify_csv, nrows=250)
        if not set(features).issubset(frame.columns):
            from backtest_aptitude import wide_to_long

            frame = wide_to_long(frame)
        sample = frame.iloc[::7].copy()
        for rank in (1, 2, 3):
            model = joblib.load(args.model_dir / f"rank{rank}.joblib")
            calibrator = joblib.load(args.model_dir / f"cal_rank{rank}.joblib")
            expected = calibrator.predict(model.predict_proba(sample[features])[:, 1])
            actual = np.array([json_predict(ranks[str(rank)], row, features) for _, row in sample.iterrows()])
            error = float(np.max(np.abs(expected - actual)))
            print(f"rank{rank}: max_abs_error={error:.3e}")
            if error > 1e-10:
                raise RuntimeError(f"rank{rank} export mismatch: {error}")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {args.output} ({args.output.stat().st_size:,} bytes, {len(features)} features)")


if __name__ == "__main__":
    main()
