"""Offline comparison: calibrators fit on validation only; test stays untouched."""
import argparse
import importlib.util
import json
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, log_loss


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--csv', required=True)
    ap.add_argument('--source', required=True)
    ap.add_argument('--repo', required=True)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    src, repo, out = Path(a.source), Path(a.repo), Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    spec = importlib.util.spec_from_file_location('v8_common', src / 'src/common.py')
    common = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(common)
    raw = pd.read_csv(a.csv)
    assert not raw.duplicated(['RACEDATE', 'PLACE', 'RACE']).any()
    assert not raw.isna().any().any()
    periods = raw.groupby('split').RACEDATE.agg(['min', 'max', 'count'])
    assert periods.loc['train', 'max'] < periods.loc['validate', 'min']
    assert periods.loc['validate', 'max'] < periods.loc['test', 'min']
    orders = raw.RENTAN3.map(common.parse_order)
    assert orders.map(lambda x: x is not None and len(x) == 3 and len(set(x)) == 3 and all(1 <= v <= 6 for v in x)).all()
    assert not set(common.FEATURES) & {'TAN', 'TANK', 'RENTAN2', 'RENTAN2K', 'RENTAN3', 'RENTAN3K'}
    # Join by race identity; mode records never count as additional races.
    server = {}
    conflicts = []
    paths = sorted((repo / 'dev/server-predictions-archive').glob('*.json'))
    paths.append(repo / 'dev/server-predictions.json')
    for p in paths:
        for rec in json.loads(p.read_text()).get('records', {}).values():
            key = (str(rec['date']), str(rec['stadium']).zfill(2), str(rec['race']).zfill(2))
            previous = server.get(key)
            if previous and previous.get('result') and rec.get('result') and previous['result'] != rec['result']:
                conflicts.append(key)
            server[key] = rec
    assert not conflicts, f'Conflicting results: {conflicts}'
    audit = {'training_races': len(raw), 'periods': periods.to_dict('index'),
             'server_unique_races': len(server), 'server_settled': sum(bool(r.get('settled')) for r in server.values()),
             'server_result_conflicts': conflicts, 'expert_v2_status': 'not located; not included',
             'ev_status': 'not evaluated: historical pre-deadline odds for all tickets are required',
             'scope': 'offline only; no production or saved financial history mutation'}
    print(json.dumps(audit, ensure_ascii=False), flush=True)
    long = common.wide_to_long(raw, require_target=True)
    valid = long[long.split.eq('validate')].copy()
    test = long[long.split.eq('test')].copy()
    age = (pd.to_datetime(valid.race_row.map(raw.RACEDATE)).max() - pd.to_datetime(valid.race_row.map(raw.RACEDATE))).dt.days
    weights = np.power(0.5, age.to_numpy() / 21)
    result = {}
    for rank in (1, 2, 3):
        model = joblib.load(src / f'models_v8/rank{rank}.joblib')
        old = joblib.load(src / f'models_v8/cal_rank{rank}.joblib')
        pv = model.predict_proba(valid[common.FEATURES])[:, 1]
        pt = model.predict_proba(test[common.FEATURES])[:, 1]
        yv, yt = valid[f'y{rank}'].to_numpy(), test[f'y{rank}'].to_numpy()
        logit = lambda p: np.log(np.clip(p, 1e-6, 1-1e-6) / (1-np.clip(p, 1e-6, 1-1e-6))).reshape(-1, 1)
        predictions = {'raw': pt, 'old_isotonic': old.predict(pt)}
        for name, w in [('platt', None), ('recent_platt_half_life_21d', weights)]:
            cal = LogisticRegression(C=1e6, max_iter=1000)
            cal.fit(logit(pv), yv, sample_weight=w)
            predictions[name] = cal.predict_proba(logit(pt))[:, 1]
        metrics = {}
        for name, p in predictions.items():
            p = np.clip(p, 1e-6, 1-1e-6)
            assert np.isfinite(p).all()
            tmp = test[['race_row', 'LANE', f'y{rank}']].assign(prob=p)
            chosen = tmp.loc[tmp.groupby('race_row').prob.idxmax()]
            metrics[name] = {'brier': float(brier_score_loss(yt, p)), 'log_loss': float(log_loss(yt, p)),
                             'race_pick_accuracy': float(chosen[f'y{rank}'].mean())}
        result[f'rank{rank}'] = metrics
        print(f'rank{rank}: {json.dumps(metrics)}', flush=True)
    (out / 'audit.json').write_text(json.dumps(audit, ensure_ascii=False, indent=2))
    (out / 'calibration_comparison.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print('Complete. Comparison only; no calibrator selected from test results.', flush=True)


if __name__ == '__main__':
    main()
