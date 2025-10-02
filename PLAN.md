# Revoice ロードマップ – 2025年Q4

## 0. 基本方針
- デスクトップ体験は軽量・オフライン完結を最優先する。
- 永続データはすべて SQLite に集約し、IPC 経由で安全に提供する。
- すべての機能で事後解析のための `[SYSTEM] ...` ログを必ず残す。
- 既存の `archive/` 出力との互換性は、移行設計が整うまでは維持する。

---

## 1. 履歴の永続化（SQLite 同梱）
### 目的
- アプリ再起動後も文字起こし履歴を保持する。
- 将来的な絞り込み／集計機能を追加しやすいスキーマを用意する。

### 実装方針
1. **SQLite バンドル**
   - `electron/package.json` に `better-sqlite3` を追加。
   - Electron Builder で macOS 向けバイナリを同梱（順次 Windows/Linux も対応）。
2. **DB サービス層（メインプロセス）**
   - DB ファイル: `<appData>/Revoice/history.db`（開発時は `~/Library/Application Support/Revoice-dev/history.db` など appData 相当パスに統一）。
   - 初期テーブル:
     - `transcriptions(id INTEGER PRIMARY KEY, input_path TEXT, output_path TEXT, transcript_preview TEXT, model TEXT, language TEXT, created_at TEXT, duration REAL, status TEXT, notes TEXT)`
     - `settings(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)` ※ `value` は JSON 文字列で保存し、キーごとのスキーマをドキュメント化
     - 必要なインデックス例: `transcriptions(created_at)`, `transcriptions(status)`
   - IPC: `history:*` のエンドポイントで CRUD（store / list / purge / detail）を提供。
3. **Renderer 統合**
   - 起動時にページネーション付きで最新履歴を取得。
   - 楽観的 UI 更新でレスポンス向上、失敗時は `[SYSTEM]` ログで通知。
4. **マイグレーション**
   - 初回マイグレーションで `transcriptions` と `settings` を作成し主要インデックスを付与。
   - 旧来のメモリ履歴がある場合は初回起動時に SQLite へ移行。
   - 将来的な CSV/ドラッグ&ドロップインポートは別タスクで検討。

### 受け入れ条件
- アプリを終了・再起動しても直近の履歴が保持される。
- DB ファイルは自動生成され、破損時には UI ログに `[SYSTEM] DB error ...` を表示。
- テストでは SQLite をモック化し、副作用なしで検証できる。

---

## 2. 履歴保持ポリシー
### 目的
- データ肥大化を防ぎつつ、ユーザーが意図通りに管理できるようにする。

### 実装方針
1. `settings` テーブルで保持期間と件数上限を管理。
2. 設定画面にカードを配置し、上部のセグメントボタンで `推奨 / カスタム` を切り替え。
   - **推奨**: 90日または200件のうち早い方で自動整理。
   - **カスタム**: 日数と件数の数値入力（0は無制限）を許可。
3. 自動整理は「起動時に必ず実行」し、その後は既定で12時間ごと（設定で変更可能）に実行。処理結果は `[SYSTEM] History pruning removed X rows` をログ出力。
4. 自動整理間隔はプリセット（12h / 24h / 起動時のみ）とカスタム時間（1〜72時間の数値入力＋単位選択）を用意。保存内容は SQLite に反映。
5. 入力値は即バリデーションを行い（負数禁止、日数≤365、件数≤10000、時間1〜72h）、0 は内部的に `null` として無制限を表現。

### 受け入れ条件
- ポリシー変更後、次のトリガー実行で条件外の履歴が削除される。
- UI 上で入力不備がある場合は保存できないようバリデーションエラーを表示。

---

## 3. 文字起こしフォーマット（タイムスタンプなし＋整形）
### 目的
- デフォルト出力を読みやすい文章／箇条書きに整える。

### 実装方針
1. CLI に新フラグ（例: `--output_style=plain`）を追加し、既存デフォルトは維持。アプリ経由ではこのフラグを指定してタイムスタンプ無し出力を選択。
2. `revoice/postprocess.py` を新設し、句読点補正と文章整形（最大3文で段落化、強調語で箇条書き化）を行う。
3. 文字起こしタブ上部に 2択セグメントボタンを配置: `タイムスタンプあり / なし（推奨）`。
   - デフォルトは `なし`。
   - 選択内容はグローバル既定値として SQLite に保存。
   - 新規タブは直近の既定値をコピー。
   - タブ内で切り替えた場合は即時反映し、同時にグローバル既定値も更新。

### 受け入れ条件
- アプリ経由のデフォルト（plain モード）では `[MM:SS]` などのタイムスタンプが含まれない整形済みテキストが出力される。
- CLI の従来デフォルトは保持し、互換オプションで元の挙動に戻せる。

### 検討事項
- 日本語句読点挿入の評価用コーパス収集。
- LLM 連携による高度整形は別途検討。

---

## 4. モデルプロファイル（高精度 vs. 高速）
### 目的
- UI からワンクリックで精度重視／速度重視を切り替えられるようにする。

### 実装方針
1. `model_profiles` テーブル（例: `id TEXT PRIMARY KEY`, `label TEXT`, `engine TEXT`, `params JSON`, `created_at TEXT`, `updated_at TEXT`）でプロフィールを管理。
2. ヘッダー右上に 2択セグメントボタンを配置し、`高精度 (large-v3, beam 5, int8)` と `高速 (small, greedy, int8_float16)` を切り替え。設定画面にも同じセレクタを配置して同期させる。
3. 選択内容は SQLite に保存し、次回起動時に復元。
4. 切り替え時はヘッダー直下に 3 秒間のバナーを表示し、`[SYSTEM] 推定処理時間: 高精度 ~X分 / 高速 ~Y分` をログにも記録。

### 受け入れ条件
- プロファイル切り替えで CLI への引数が即時に変わる。
- 選択内容は再起動後も保持される。

---

## 5. 将来機能：メディア変換・サイドバー・マルチタブ
### 目的
- 大容量動画を軽量音声へ事前変換し、並列で最大4ジョブまで扱える UI に刷新する。

### 実装方針
1. **音声変換ツール**
   - `ffmpeg` ラッパーで 16kHz モノラル FLAC/OGG（128kbps 以下）へ変換。
   - 変換結果は `/archive/audio-cache/` に保存し、チェックサム重複を排除。削除ボタンを提供。
   - ドラッグ＆ドロップのキュー UI と進捗バーを用意。
2. **サイドバー＆レイアウト**
   - 左サイドバー幅 220px を想定：`文字起こし / 音声変換 / 設定 / アカウント(予定)`。
   - ヘッダー（高さ64px）にモデルセレクタ・ストレージ使用量・システムログトグルを配置し、表示領域が不足した場合は省略記号＋ツールチップで対応。
   - メイン領域はタブストリップ（最大4件、各130px以上）＋ワークスペース。推奨最小ウィンドウは 1180×720。幅が800px未満になった場合はサイドバーを自動折りたたみ。
3. **マルチタブ／並列ジョブ管理**
   - メインプロセスにジョブコントローラを実装し、同時実行は最大4。5件目以降は FIFO キュー。
   - タブはジョブIDに紐付き、クローズ時に「ジョブを停止する／バックグラウンドで継続する」を選択。
   - ジョブ状態とタブ配置は SQLite に保存し、再起動時に `queued` / `running` / `completed` 状態を復元。
   - キューイベントは `[SYSTEM]` ログ（作成・開始・完了・停滞・再開）で追跡。
4. **タスク連携**
   - 音声変換完了後に「この音声を文字起こし」ボタンから新タブを生成し、変換済みファイルを自動指定。
   - 設定画面では出力先ディレクトリ、履歴保持ポリシー、モデルデフォルト、並列数（1〜4）を管理。
5. **データモデル案**
   - `jobs(id TEXT PRIMARY KEY, type TEXT, status TEXT, payload JSON, result_path TEXT, created_at TEXT, updated_at TEXT)`
     - `payload` には `input_path`, `output_path`, `profile`, `format`, `options` などを JSON で保持。
   - `tabs(id TEXT PRIMARY KEY, job_id TEXT REFERENCES jobs(id), title TEXT, layout JSON, last_opened_at TEXT)`
     - `layout` はタブ固有の UI 状態を JSON で保持。
   - `job_events(event_id TEXT PRIMARY KEY, job_id TEXT REFERENCES jobs(id), event TEXT, created_at TEXT, payload JSON)`
     - イベントは最大30日または2000件を目安にローテーション。`event_id` は UUID、`created_at` は ISO8601。
     - `payload` にはメッセージや進捗値など詳細を保持。`(job_id, created_at)` にインデックスを付与。

### 依存関係
- セクション1の永続化基盤（SQLite）と IPC 契約が前提。
- `ffmpeg` バイナリ同梱時の notarization 対応。
- 状態共有のために Zustand/Recoil 等の導入を検討。

### 受け入れ条件
- サイドバーでのナビゲーションが安定し、`revoice://transcribe/:id` などのディープリンクで該当タブが開く。
  - 最大4タブまで同時実行、5件目はキューに入り `[SYSTEM] Queueing job ...` を表示。
  - 変換タブと文字起こしタブで共通の進捗 UI・キャンセル操作を提供。
  - タブの開閉／復元がログに残り、状態が一貫する。

---

## 調査タスク
- 日本語句読点復元ライブラリの精度／速度比較。
- `better-sqlite3` の Windows ビルド手順（将来的な多OS対応のため）。
- Apple Silicon での GPU 推論（`coremltools` / `whisper.cpp` 等）の可能性調査。

---

## 直近のアクションチェックリスト
1. SQLite サービスとマイグレーションの骨組みを実装。
2. 既存のインメモリ履歴を SQLite バックエンドへ置き換え。
3. 履歴保持ポリシー UI と自動整理ジョブを実装。
4. タイムスタンプ無し整形とモデルセレクタの実装（#3 と並行可）。
5. 音声変換ツールとサイドバー＋マルチタブ UI のプロトタイプを着手。
