# Revoice完璧起動スクリプト再構築プロンプト

## 🎯 目的
Revoiceアプリの起動・再起動問題を根本的に解決する完璧なスクリプトを作成する

## 🔍 現状の問題分析

### 根本原因
1. **ViteサーバーとElectronの起動タイミング問題**
   - `wait-on`がタイムアウトする
   - ElectronがViteサーバーの準備を待てない
   - プロセス間の依存関係が不安定

2. **エラーハンドリング不足**
   - 接続失敗時の自動復旧がない
   - プロセス状態の確認が不十分
   - リトライ機能がない

3. **プロセス管理の問題**
   - 古いプロセスの残存
   - ポート競合の発生
   - クリーンアップの不完全

## 🛠️ 解決策の要件

### 必須機能
1. **段階的起動**
   - Viteサーバーを先に起動
   - サーバーの準備完了を確認
   - Electronを後から起動

2. **エラーハンドリング**
   - リトライ機能（最大5回）
   - タイムアウト処理
   - 詳細なログ出力

3. **ヘルスチェック**
   - Viteサーバーの応答確認
   - Electronプロセスの存在確認
   - ポート使用状況の確認

4. **クリーンアップ**
   - 古いプロセスの強制終了
   - ポートの解放
   - 最終確認

### 技術仕様
- **プロジェクトディレクトリ**: `/Users/sasuketorii/Revoice`
- **Electronディレクトリ**: `/Users/sasuketorii/Revoice/electron`
- **ポート**: 5173
- **最大リトライ回数**: 5回
- **リトライ間隔**: 3秒
- **タイムアウト**: 15秒

## 📝 スクリプト作成指示

### 1. 基本構造
```bash
#!/bin/bash
set -e  # エラー時に停止

# カラー定義
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# ログ関数
log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
```

### 2. 必須関数
- `cleanup_processes()` - プロセスクリーンアップ
- `start_vite_server()` - Viteサーバー起動
- `start_electron()` - Electron起動
- `health_check()` - ヘルスチェック
- `main()` - メイン処理

### 3. 処理フロー
1. プロジェクトディレクトリに移動
2. クリーンアップ実行
3. Viteサーバー起動（リトライ機能付き）
4. Electron起動
5. ヘルスチェック実行
6. 成功メッセージ表示

### 4. エラーハンドリング
- 各ステップでエラー時は即座に終了
- 詳細なエラーメッセージを出力
- リトライ機能で一時的な問題に対応

## 🧪 テスト手順

### 正常起動テスト
```bash
cd /Users/sasuketorii/Revoice
./start-perfect.sh
```

### 期待される出力
```
[INFO] Revoice完璧起動スクリプト v2.0 を開始...
[INFO] プロセスをクリーンアップ中...
[SUCCESS] クリーンアップ完了
[INFO] Viteサーバーを起動中...
[SUCCESS] Viteサーバーが起動しました (PID: xxxxx)
[INFO] Electronアプリを起動中...
[SUCCESS] Electronアプリが起動しました (PID: xxxxx)
[INFO] ヘルスチェックを実行中...
[SUCCESS] ヘルスチェック完了 - すべて正常です
[SUCCESS] 🎉 Revoiceアプリが正常に起動しました！
```

### 異常時のテスト
- ポート5173が使用中の場合
- Viteサーバーが起動しない場合
- Electronが起動しない場合

## 📋 検証項目

### 起動成功の確認
- [ ] Viteサーバーが`http://127.0.0.1:5173`で応答
- [ ] Electronウィンドウが開く
- [ ] UIが正常に表示される
- [ ] 音声ファイル選択ボタンが表示される

### プロセス確認
```bash
# プロセス確認
ps aux | grep -E "(electron|vite)" | grep -v grep

# ポート確認
lsof -i :5173

# HTTP接続テスト
curl -I http://127.0.0.1:5173/
```

## 🔧 トラブルシューティング

### よくある問題
1. **ポート競合**: `lsof -i :5173`で確認、`kill -9`で終了
2. **Viteサーバー起動失敗**: `npm run renderer:dev`を手動実行
3. **Electron起動失敗**: `npx cross-env VITE_DEV_SERVER_URL=http://127.0.0.1:5173 electron .`を手動実行

### デバッグコマンド
```bash
# 詳細ログで実行
bash -x ./start-perfect.sh

# プロセス確認
ps aux | grep -E "(electron|vite|wait-on|npm)"

# ポート確認
lsof -i :5173

# HTTP接続テスト
curl -v http://127.0.0.1:5173/
```

## 📚 参考情報

### プロジェクト構造
```
/Users/sasuketorii/Revoice/
├── electron/
│   ├── package.json
│   ├── main.js
│   └── renderer/
├── .venv/
├── pyproject.toml
└── start-perfect.sh
```

### 依存関係
- **Node.js**: npm、electron、vite
- **Python**: faster-whisper、revoice
- **システム**: ffmpeg

### 環境変数
- `VITE_DEV_SERVER_URL=http://127.0.0.1:5173`
- `PYTHONPATH` (Python環境用)

---

**作成日**: 2025年10月2日  
**目的**: Revoiceアプリの確実な起動とトラブルシューティング  
**対象**: AI Assistant、開発者、ユーザー
