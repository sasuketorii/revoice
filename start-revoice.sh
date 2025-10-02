#!/bin/bash
# Revoice最適起動スクリプト

echo "🎯 Revoice最適起動を開始..."

# プロジェクトディレクトリに移動
cd /Users/sasuketorii/Revoice

# 1. クリーンアップ実行
echo "🧹 起動前クリーンアップを実行..."
./start-clean.sh

# 2. Electronディレクトリに移動
cd electron

# 3. 開発サーバー起動
echo "🚀 開発サーバーを起動中..."
npm run dev

echo "✅ 起動完了！"
