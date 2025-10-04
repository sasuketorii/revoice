# AGENTS.md — Revoice 開発・運用ハンドブック

このドキュメントは、新しく参画した開発者・運用担当者が “Revoice” アプリを迷わず準備・実行・保守できるようにまとめたものです。Python 仮想環境から Electron/React の開発、SQLite ベースの履歴管理まで、現状の構成と今後の計画を含めて網羅しています。

---

## 1. プロジェクト概要
- **目的**: ローカル実行の高精度文字起こしツール（Electron + React + faster-whisper）。
- **構成**:
  - `electron/` … Electron 本体、React レンダラー、プリロードスクリプト、ビルド設定。
  - `revoice/` … Python パッケージ。faster-whisper CLI、整形ロジックなど。
  - `archive/` … 文字起こし結果や変換済み音声ファイルの保存先（デフォルト）。
  - `PLAN.md` … ロードマップ。SQLite 履歴、マルチタブ等の設計方針はここを参照。
  - `AGENTS.md` … 本ドキュメント（作業手順の基準書）。

---

## 2. 必要ツールと前提バージョン
| 種類 | 推奨バージョン | 補足 |
| --- | --- | --- |
| macOS | 13 Ventura 以降 | Windows/Linux も想定、現状は macOS 赤実績 |
| Node.js | 20.x LTS | `npm` 同梱。`corepack enable` 済みなら pnpm も利用可 |
| Python | 3.11.x | 仮想環境は `.venv/` を利用。faster-whisper が 3.9+ 必須 |
| ffmpeg | 6.x 以上 | 音声抽出と将来の変換機能で使用 |
| SQLite3 | OS 同梱で可 | Electron 同梱ライブラリは `better-sqlite3` |

> **Tip:** `python3 -V` / `node -v` / `ffmpeg -version` で事前確認。

---

## 3. Python 仮想環境と依存パッケージ
1. 仮想環境を作成
   ```bash
   cd /Users/sasuketorii/Revoice
   python3 -m venv .venv
   source .venv/bin/activate
   ```
2. 開発モードでパッケージをインストール
   ```bash
   python -m pip install --upgrade pip
   python -m pip install -e .
   ```
3. 動作確認
   ```bash
   python -c "import faster_whisper; print('faster-whisper OK')"
   ```

> Electron 起動時は自動で適切な Python を検出しますが、CLI 利用やテスト時は `.venv` の利用を推奨します。

---

## 4. Node / React 側依存インストール
```bash
cd /Users/sasuketorii/Revoice/electron
npm install
```
- `package.json` 内の主要コマンド:
  - `npm run dev` … Vite + Electron を同時起動。
  - `npm run renderer:dev` … レンダラー(Vite)のみ起動。
  - `npm run renderer:build` … 本番ビルド（整形確認用）。

---

## 5. 開発サーバー起動手順
### 🥇 推奨: ワンコマンド
```bash
cd /Users/sasuketorii/Revoice && ./start-revoice.sh
```
- `start-revoice.sh` は `start-clean.sh` でプロセスを掃除した後、Electron まで起動します。

### 🥈 手動ステップ
```bash
cd /Users/sasuketorii/Revoice
./start-clean.sh              # プロセス・ポート掃除
cd electron
npm run dev
```

### 🥉 最小構成（非推奨）
```bash
cd /Users/sasuketorii/Revoice/electron
npm run dev
```
> クリーンアップを省略するためポート衝突が起こりやすいので避けてください。

---

## 6. SQLite 履歴データベース
- デフォルトファイル: `~/Library/Application Support/Revoice-dev/history.db`（macOS）。
- テーブル:
  - `transcriptions` … 文字起こし結果のメタデータ。
  - `settings` … JSON 形式で各種設定（履歴ポリシー、フォーマット既定値など）。
  - `model_profiles` … `id`, `label`, `engine`, `params`, `created_at`, `updated_at`。
  - （今後）`jobs`, `tabs`, `job_events` … マルチタブ／並列ジョブ管理用。
- マイグレーションは Electron 起動時に実行予定（実装中）。
- 破損時のリセット: アプリ停止 → `history.db` をバックアップ → 削除 → 再起動で再生成。

---

## 7. 設定とプロファイルの挙動
| 設定項目 | 保存先 | 備考 |
| --- | --- | --- |
| 文字起こしフォーマット（タイムスタンプ有/無） | `settings` テーブル | タブで変更するとグローバル既定値も更新 |
| 履歴保持ポリシー（推奨 or カスタム） | 同上 | カスタム時は日数・件数・間隔を JSON で保持。0 は `null` に変換 |
| モデルプロファイル（高精度/高速） | `model_profiles` + `settings` | ヘッダーと設定画面で同期、切り替え時に 3 秒の ETA バナー表示 |

### 7.1 フロントエンド UI ナビゲーション（2025-10 更新）
- サイドバーは「Voice to Text / Movie to Voice / Setting」の 3 グループ構成。現行実装は Voice to Text の「文字起こし」「履歴」「ログ」と Setting 内の「Voice to textの設定（履歴ポリシー）」が利用可能。
- 「文字起こし」ではタブボタン + アップロードフォーム + 結果表示を縦並びで表示。出力スタイルは「タイムスタンプあり / なし」の 2 択で、選択すると即座に SQLite に保存される。
- 「履歴」は左カラムに履歴リスト（クリックで選択）、右カラムに詳細と本文プレビュー・アイコン操作（表示/コピー/削除）。選択状態は SQLite の読み込み結果に同期。
- 「ログ」は従来のログパネルのみを全幅表示。clipboard コピーは右上ツールから実行。
- 旧 UI の履歴ポリシー設定は「Setting → Voice to textの設定」へ移動。UI から保存すると即座に pruning ジョブが走り `[SYSTEM] History pruning removed ...` が出力される。

---

## 8. ビルドとテスト
- レンダラー整合性チェック
  ```bash
  cd electron
  npm run renderer:build
  ```
- Python CLI テスト（任意）
  ```bash
  source .venv/bin/activate
  python -m revoice.cli <INPUT_FILE> --output_dir archive/test
  ```
- ログ確認: Electron 起動後、アプリ下部のログパネルまたはコンソールで `[SYSTEM] ...` を探す。

---

## 9. トラブルシューティング
### ① ポート5173の競合
```
Error: Port 5173 is already in use
```
**対処**
```bash
lsof -i :5173
lsof -ti :5173 | xargs kill -9
# または
pkill -f "vite|electron|wait-on"
```

### ② Electron ウィンドウが真っ白
```
ERR_CONNECTION_REFUSED
```
**原因**: Vite が落ちている。
```bash
cd electron
npm run renderer:dev
```

### ③ faster-whisper が見つからない
```
[ERROR] faster-whisper is not installed
```
**対処**
```bash
cd /Users/sasuketorii/Revoice
source .venv/bin/activate
python -m pip install -e .
```

### ④ DB 関連
- `[SYSTEM] DB error ...` が表示されたら `history.db` をバックアップして削除 → 再起動。
- 自動整理が動かない場合は設定画面で間隔・値が保存されているか確認。

### ⑤ 既知のログ
- `[SYSTEM] Queueing job ...` … 並列タブ上限でキュー待ち。現状は最大4タブ。
- `[SYSTEM] Transcriptを読み込みました: ...` … 文字起こし結果を SQLite に反映済み。

---

## 10. 完全リセット手順
```bash
cd /Users/sasuketorii/Revoice
pkill -f "electron|vite|wait-on|npm.*dev"
lsof -i :5173
./start-clean.sh
sleep 3
./start-revoice.sh
```

---

## 11. 最低限の動作確認チェック
- [ ] `http://127.0.0.1:5173/` が 200 を返す
- [ ] Electron ウィンドウが表示される
- [ ] UI 下部にログパネルが表示される
- [ ] ファイル選択ボタンがアクティブ
- [ ] 文字起こし結果欄にテキストが表示される
- [ ] `[SYSTEM]` と `[PROGRESS]` ログが流れる

---

## 12. 新機能ロードマップ概要
詳細は `PLAN.md` を参照。特に:
- 履歴の SQLite 永続化（実装中）
- 履歴保持ポリシー UI（推奨/カスタム）
- タイムスタンプ無し整形
- モデルプロファイル切り替えと ETA 表示
- マルチタブ & 音声変換サイドバー（最大4タブ）

---

## 13. ディレクトリクイックリファレンス
```
Revoice/
├── AGENTS.md            # 本ドキュメント
├── PLAN.md              # detailed roadmap
├── archive/             # 出力フォルダ（デフォルト）
├── electron/
│   ├── main.js          # Electron メインプロセス
│   ├── preload.js       # コンテキストブリッジ
│   ├── renderer/        # React ソース
│   └── package.json
├── revoice/
│   ├── cli.py           # faster-whisper CLI
│   └── postprocess.py   # 整形ロジック（導入予定）
├── start-clean.sh
└── start-revoice.sh
```

---

## 14. よくある質問 (FAQ)
**Q. venv に入らなくても Electron は動く？**  
A. はい。メインプロセスが自動で Python を検出しますが、CLI やテストは `.venv` 利用を推奨。

**Q. SQLite はどこに置けばよい？**  
A. macOS 開発時は `~/Library/Application Support/Revoice-dev/` に作成されます。環境に合わせて `app.getPath('userData')` が参照されます。

**Q. 文字起こしが空になるときは？**  
A. `[SYSTEM] Transcript...` ログを確認。ファイル名のNFC/NFD差異や出力先の権限が問題になる場合があります。

**Q. モデルを切り替えても速度が変わらない？**  
A. 入力の長さや CPU/GPU 状況によります。`PLAN.md` のプロファイル設計を参照し、必要に応じて `params JSON` を調整してください。

---

## 15. 動画→音声コンバーター
> 詳細な仕様は `PLAN-media-converter.md` を参照。ここでは運用・実装のポイントをまとめる。

### 15.1 前提
- FFmpeg 6.x 以上が必要。`ffmpeg -version` で事前確認。環境によっては `settings.conversion.ffmpegPath` を追加する予定。
- 変換後の音声フォーマット（AAC/FLAC/OGG/WAV）はそのまま文字起こしに使用できるよう、faster-whisper CLI 側の拡張子チェックを更新済み／更新予定。

### 15.2 UI 構成（動画→音声 ページ）
1. **ドロップゾーン**: 複数ファイル対応。ドラッグ＆ドロップまたは「ファイルを選ぶ」でキューに積む。
2. **ジョブセクション**: 進行中のジョブと最近の完了（直近3件）を別カードで表示。完了したジョブはその場で文字起こしに送れる。
3. **設定パネル**: 「バランス / 高音質 / 軽量 / カスタム」のプリセットカードを用意。カスタム選択時のみフォーマット・サンプリングレート等の詳細項目が展開され、保存先ディレクトリはボタンからフォルダ選択できる。自動タブ生成と同時変換上限もここで切り替え。
4. **変換履歴ページ**: 左側リストで変換履歴を選択し、右側でプリセット・長さ・サイズなどの詳細＋文字起こしへの送信ボタンを表示。
4. **ログ反映**: `[CONVERT]` プレフィックスのログを `jobs:event` と UI トーストに反映。

### 15.3 変換ジョブ管理
- メインプロセス側で `conversionQueue` を実装し、`jobs` テーブルに `type = 'conversion'` で保存。metadata にはプリセット情報と出力先、元動画パスを記録する。
- 進捗は `-progress` パイプから取得し、`convert:event` IPC でレンダラーへ送信する。
- 保存先は初期値 `Downloads`。設定で変更可能。存在しない場合は自動生成し、失敗時は Downloads にフォールバック。

### 15.4 文字起こしとの連携
- 変換完了行の「文字起こしに送る」を押すと `enqueueJob` を呼び出し、新しいタブが生成される。
- タブ metadata に `sourceConversionJobId` を残し、元の変換ジョブと追跡可能にする。
- 変換後ファイルのフォーマットはすべて文字起こしに渡せるよう CLI 側の対応を確認すること（例: `m4a`, `flac`, `ogg`, `wav`）。

### 15.5 ドキュメントの位置付け
- 引き継ぎ時は `PLAN-media-converter.md` → `AGENTS.md` → `NEXT_STEPS_PROMPT.md` の順で読めば全体像が掴めるようにしている。
- UI 文言やプリセット値は日本語で統一し、調整が必要な場合は本節を更新する。

**最終更新**: 2025年10月3日  
**記録担当**: AI Assistant  
**用途**: Revoice アプリの開発・運用・トラブルシューティングを誰でも再現できるようにするための基準書
