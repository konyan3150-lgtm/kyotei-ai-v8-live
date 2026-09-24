# 選手適性DB パイロット

本番V8に触れず、BOAT RACE公式の日次番組表（B）・競走成績（K）から、登録番号を主キーにした選手別データを試作する実験です。

## 実行

```bash
python -m pip install -r requirements.txt
python pilot.py \
  --start 2025-03-01 \
  --end 2025-03-31 \
  --training-csv ../../../project_sources/02-boatrace_training-2-.csv
```

出力先 `output/`（ファイル名には指定期間が入ります）:

- `racer_starts_*.csv`: 1選手・1走単位の正規化データ
- `racer_aptitude_*.json`: 選手全体／コース別／会場別／会場×コース別の集計
- `training_join_*.csv`: 既存学習CSVのレースと登録番号6艇の結合結果
- `pilot_summary_*.json`: 取得件数・欠損・結合率

この1か月版の集計はデータ取得と結合の成立確認用です。学習特徴量として利用する際は、対象レースより前の履歴だけで計算し、少数サンプルを全体・級別平均へ縮小します。

## 時系列特徴量と比較

- `build_features.py`: 対象日より前の履歴だけから選手適性特徴量を生成
- `backtest_aptitude.py`: 現行V8相当と選手適性追加版を同じsplitで比較
- `BACKTEST_REPORT.md`: TEST期間の比較結果と本番反映判断
- `BACKTEST_3Y_REPORT.md`: 3年履歴と特徴量アブレーションの比較
- `walk_forward_backtest.py`: 3区間ウォークフォワード検証
- `WALK_FORWARD_REPORT.md`: 複数TEST期間での再現性評価
