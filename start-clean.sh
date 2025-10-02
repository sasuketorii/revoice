#!/bin/bash
# Revoice起動前クリーンアップスクリプト

echo "🧹 Revoice起動前クリーンアップを開始..."

# 1. ポート5173を使用しているプロセスを確認
echo "📊 ポート5173の使用状況を確認中..."
if lsof -i :5173 > /dev/null 2>&1; then
    echo "⚠️  ポート5173が使用中です。プロセスを終了します..."
    lsof -ti :5173 | xargs kill -9 2>/dev/null
    sleep 2
else
    echo "✅ ポート5173は空いています"
fi

# 2. Electron関連プロセスを確認・終了
echo "📊 Electron関連プロセスを確認中..."
ELECTRON_PIDS=$(ps aux | grep -E "(electron|vite|wait-on|npm.*dev)" | grep -v grep | awk '{print $2}')
if [ ! -z "$ELECTRON_PIDS" ]; then
    echo "⚠️  Electron関連プロセスが見つかりました。終了します..."
    echo "$ELECTRON_PIDS" | xargs kill -9 2>/dev/null
    sleep 2
else
    echo "✅ Electron関連プロセスは見つかりませんでした"
fi

# 3. 最終確認
echo "🔍 最終確認中..."
if lsof -i :5173 > /dev/null 2>&1; then
    echo "❌ まだポート5173が使用中です"
    exit 1
else
    echo "✅ クリーンアップ完了！起動準備OK"
fi

echo "🚀 クリーンアップ完了！npm run devを実行してください"
