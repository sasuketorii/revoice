# AGENTS.md - Revoice起動手順ガイド

## 🎯 最適な起動方法

### 🥇 推奨：ワンコマンド起動
```bash
cd /Users/sasuketorii/Revoice && ./start-revoice.sh
```

### 🥈 手動クリーンアップ + 起動
```bash
cd /Users/sasuketorii/Revoice
./start-clean.sh
cd electron
npm run dev
```

### 🥉 従来の方法（リスクあり）
```bash
cd /Users/sasuketorii/Revoice/electron
npm run dev
```

## 🛡️ トラブルシューティング

### よくある問題と解決方法

#### 1. ポート5173が使用中エラー
```
Error: Port 5173 is already in use
```

**原因：** 以前のプロセスが残っている

**解決方法：**
```bash
# プロセス確認
lsof -i :5173

# 強制終了
lsof -ti :5173 | xargs kill -9

# または
pkill -f "vite|electron|wait-on"
```

#### 2. Electronウィンドウが白紙
```
ERR_CONNECTION_REFUSED
```

**原因：** Viteサーバーが停止している

**解決方法：**
```bash
# Viteサーバーを再起動
cd /Users/sasuketorii/Revoice/electron
npm run renderer:dev
```

#### 3. faster-whisperエラー
```
[ERROR] faster-whisper is not installed: No module named 'faster_whisper'
```

**原因：** Python依存関係がインストールされていない

**解決方法：**
```bash
cd /Users/sasuketorii/Revoice
source .venv/bin/activate
python -m pip install -e .
```

## 🔧 作成されたスクリプト

### start-clean.sh（クリーンアップ専用）
- ポート5173の使用状況確認
- 古いプロセスを自動終了
- Electron関連プロセスのクリーンアップ
- 最終確認でエラー防止

### start-revoice.sh（完全自動起動）
- クリーンアップ自動実行
- プロジェクトディレクトリ移動
- Electronディレクトリ移動
- 開発サーバー起動

## 📋 完全リセット手順

問題が解決しない場合の完全リセット：

```bash
cd /Users/sasuketorii/Revoice

# 1. 全プロセス終了
pkill -f "electron|vite|wait-on|npm.*dev"

# 2. ポート確認
lsof -i :5173

# 3. クリーンアップ実行
./start-clean.sh

# 4. 3秒待機
sleep 3

# 5. 起動
./start-revoice.sh
```

## 🚀 起動確認チェックリスト

起動が成功した場合の確認項目：

- [ ] Viteサーバーが `http://127.0.0.1:5173/` で起動
- [ ] Electronウィンドウが開く
- [ ] ウィンドウが白紙でない（UIが表示される）
- [ ] 音声ファイル選択ボタンが表示される
- [ ] 開発者ツールが開く（開発モード）

## 📝 注意事項

1. **venvは不要** - Electronアプリ起動時はvenvに移動する必要はない
2. **Python処理** - Electronが自動で適切なPython環境を選択する
3. **プロセス管理** - 終了時は`Ctrl+C`で正常に終了する
4. **ポート競合** - 他のアプリがポート5173を使用していないか確認

## 🔍 デバッグコマンド

問題の診断に使用するコマンド：

```bash
# プロセス確認
ps aux | grep -E "(electron|vite|wait-on|npm)"

# ポート確認
lsof -i :5173

# HTTP接続テスト
curl -I http://127.0.0.1:5173/

# Python環境確認
cd /Users/sasuketorii/Revoice
source .venv/bin/activate
python -c "import faster_whisper; print('OK')"
```

---

**最終更新：** 2025年10月2日  
**作成者：** AI Assistant  
**目的：** Revoiceアプリの確実な起動とトラブルシューティング
