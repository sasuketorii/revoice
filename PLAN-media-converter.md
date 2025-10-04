# PLAN-media-converter — 動画→音声コンバーター要件定義

## 1. 背景 / 目的
- 動画ファイルはサイズが大きく、直接文字起こしすると処理時間・メモリ負荷が高い。
- 文字起こし前に音声トラックのみを抽出して軽量化することで、faster-whisper の入力として最適化する。
- Revoice アプリ内で完結する「動画→音声変換」フローを提供し、変換済み音声をそのまま文字起こしタブへ渡せるようにする。

## 2. 想定シナリオ
1. ユーザーが動画ファイル（`.mp4`, `.mov`, など）をドロップ or ファイルピッカーから選択。
2. 変換プリセット（音声フォーマット・サンプリングレート・ビットレート）を選択し、変換を実行。
3. 処理完了後、指定フォルダ（初期値: Downloads）へ軽量な音声ファイルが保存される。
4. 完了通知から「文字起こしタブで開く」を選ぶと、新しいタブが生成され自動的に `enqueueJob` される。

## 3. 入出力要件
### 3.1 入力
- 対応動画形式: `mp4`, `mov`, `mkv`, `avi`, `webm`（FFmpeg が処理できる範囲）。
- 入力ファイルサイズ上限: 10GB（超過時は警告表示）。
- 複数ファイル同時投入を許可し、キューに積んで順次処理。

### 3.2 出力
- 音声フォーマット候補: `m4a (AAC)`, `flac`, `ogg (Vorbis)`, `wav`。
- サンプリングレート: 16kHz / 24kHz / 44.1kHz（初期値 16kHz）。
- チャンネル: モノラル / ステレオ（初期値 モノラル）。
- ビットレート（圧縮形式）: 64/128/192 kbps のプリセット。
- ファイル命名規約: `<元ファイル名>_<preset>.<ext>`。
- **文字起こし側との整合**: faster-whisper CLI / Electron UI で上記フォーマットを全て許容する。拡張子チェック・ドラッグ＆ドロップ対応を更新すること。

### 3.3 保存先
- 初期値: `app.getPath('downloads')`。
- 設定画面からディレクトリを変更可能。存在しない場合は自動作成、失敗時は Downloads にフォールバック。
- 保存先は `settings` テーブルに `conversion.outputDir` として保存。

## 4. UI / UX（概要）
※ 詳細な要素配置や文言は `AGENTS.md` の「15. 動画→音声コンバーター」節を参照。

- 左サイドバーの「動画→音声」ページで操作。
- ページ構成:
  1. **ドロップゾーン** + 「ファイルを選ぶ」ボタン。
  2. **変換ジョブリスト**: 各ジョブのファイル名／設定／進捗バー／キャンセル。
  3. **設定パネル**: フォーマット・ビットレート・サンプリングレート・保存先・並列数。
  4. **完了アクション**: Finder/Explorer で開く、文字起こしに送る。
- 変換中はキャンセルボタンを提供し、処理終了後はジョブログとトーストで結果を通知。

## 5. バックエンド仕様
- メインプロセスに `conversionQueue` を実装。並列数は `settings.conversion.maxParallelJobs`（初期値 2）。
- FFmpeg コマンド例:
  ```bash
  ffmpeg -y -i <input> -vn -ac <channels> -ar <sampleRate> -b:a <bitrate> <output>
  ```
- 進捗取得: `-progress pipe:1` を利用し、% を算出の上 `convert:event` IPC でレンダラーへ送信。
- 変換一時ファイルは `app.getPath('temp')/revoice-convert/<uuid>` に生成 → 成功後に保存先へ rename。
- ジョブ記録: `jobs` テーブルの `type` を `'conversion'` に設定し、metadata にプリセット情報・最終保存パス・元ファイルパスを保存。

## 6. 文字起こし連携
- 変換完了行の「文字起こしに送る」で `enqueueJob` を実行。payload には変換後の音声ファイルパスをセットし、タブタイトルを音声ファイル名で初期化。
- タブ metadata の `sourceConversionJobId` で変換ジョブと紐付ける。
- 自動連携を有効にした場合（設定 `conversion.autoCreateTranscribeTab` が true）、変換完了と同時にタブ作成まで行う。

## 7. 設定／永続化
- `settings` テーブルに以下を追加:
  ```json
  {
    "conversion": {
      "outputDir": "/Users/<name>/Downloads",
      "defaultPreset": {
        "format": "aac",
        "bitrateKbps": 128,
        "sampleRate": 16000,
        "channels": 1
      },
      "maxParallelJobs": 2,
      "autoCreateTranscribeTab": false
    }
  }
  ```
- `jobs.metadata` 例:
  ```json
  {
    "preset": "aac_128_mono_16k",
    "outputPath": "/Users/.../Downloads/video_aac.m4a",
    "sourceInputPath": "/Users/.../video.mp4",
    "durationSec": 123.4,
    "sizeBytes": 2345678
  }
  ```

## 8. ログ / 通知
- `[CONVERT] Queueing conversion for {file}`
- `[CONVERT] Progress 37% ({file})`
- `[CONVERT] Saved to {path}`
- エラー: `[CONVERT][ERROR] {file}: {reason}`
- 変換完了時に OS 通知 (トグル可) + UI トーストで共有。

## 9. エラーケース
- FFmpeg が見つからない → 設定画面でバイナリパスを要求。未設定時はエラーを出し変換不可。
- 入力のコーデックが非対応 → エラー表示しジョブを `failed` にする。
- 保存先の書き込み権限が不足 → メッセージとともに Downloads へフォールバック。
- ディスク空き容量不足 → 変換開始時にチェックして不足時は警告。

## 10. 開発ステップ（推奨順）
1. `jobs` テーブルの conversion 対応 + metadata 設計。
2. FFmpeg ラッパーと conversionQueue 実装。
3. 設定 UI / 永続化の実装。
4. 動画→音声ページ UI 実装（ドロップゾーン／ジョブリスト／設定）。
5. 文字起こしタブ連携の導線実装。
6. テスト（多形式ファイル、再起動復元、エラーパス）。

## 11. ドキュメント
- 開発手順・UI モックは `AGENTS.md` 15章を参照。
- 引き継ぎ用には `NEXT_STEPS_PROMPT.md` にタスクを追加すること。

---
この仕様をもとに動画→音声コンバーター機能を実装する。
