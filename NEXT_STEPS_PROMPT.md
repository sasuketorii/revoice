# Revoice 次担当者向け実装プロンプト

## 現在の状況
- Electron メイン・レンダラー・Python CLI の基盤は動作済み。
- 履歴データは SQLite (`history.db`) に永続化され、一覧読み込み・追加・削除 API が整備済み。
- フロントエンドは GitHub 風ライトテーマへ刷新済みで、履歴タブはページネーション・総件数表示・失敗ジョブの保存に対応。

## 次に実装すべき項目（PLAN.md 順）
1. **履歴保持ポリシー (Section 2)**
   - `settings` テーブルで推奨 / カスタム設定を保持。
   - Renderer にポリシー設定 UI（推奨プリセット・カスタム入力・バリデーション）を追加。
   - 自動整理ジョブを Electron メインに実装し、起動時・一定間隔で `historyStorage.pruneBeforeISO` 等を呼び出せるようにする。
   - `[SYSTEM] History pruning removed X rows` ログを出力。

2. **文字起こしフォーマット切り替え (Section 3)**
   - `revoice/postprocess.py` を新規作成し、タイムスタンプ無し整形を実装。
   - Python CLI に `--output_style` フラグを追加し、Electron から選択できるよう UI を 2択セグメントボタン化。
   - 選択内容を SQLite `settings` に保存し、新規タブでも既定値を利用できるよう反映。

3. **モデルプロファイル (Section 4)**
   - `model_profiles` テーブルの CRUD / IPC を実装。
  - Renderer でプロファイル編集・切り替え UI を実装し、切り替え時に 3 秒の ETA バナーを表示。
   - CLI 起動時に選択プロファイルのパラメータを適用。

4. **タブ＆ジョブ管理 (Section 5)**
   - `tabs`, `jobs`, `job_events` テーブルとマイグレーションを追加。
   - Renderer に Zustand 等の状態管理を導入し、最大 4 タブの並列実行・キュー表示をサポート。
   - タブ閉じる／復元・ディープリンク `revoice://transcribe/:id` などの設計に沿って実装。

## 補足メモ
- 既存の `electron/history/storage.js` に `pruneBeforeISO` や件数・削除 API を追加済み。必要に応じてここを利用してポリシー実装を行う。
- `history:delete` IPC とフロントのページネーションが導入されているので、保持ポリシーやタブ消去ロジックはここを活用すること。
- 失敗ジョブは `status = 'failed'` で保存される。必要であれば詳細表示を追加しても良い。

## 最低限の確認項目
1. `./start-revoice.sh` でアプリが起動し、履歴・ポリシー・フォーマット切り替え・プロファイル等の UI が動作すること。
2. 少なくとも 1 回は文字起こしを実行して履歴が SQLite に保存されることを確認。
3. 実装した自動整理やタブ管理のロジックに対して、ログまたはテストで動作確認を残すこと。

---
このファイルをプロンプトとして引き継ぎ、上記タスクを順に実装してください。
