#!/bin/bash
# Revoice完璧起動スクリプト v2.1
# ViteサーバーとElectronの起動を段階的に制御し、ヘルスチェックと詳細ログで安定稼働を保証する

set -euo pipefail

# =============================================
# カラー定義とログユーティリティ
# =============================================
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $1"; }

# =============================================
# 定数・グローバル変数
# =============================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR"
ELECTRON_DIR="$PROJECT_ROOT/electron"
PORT=5173
MAX_RETRIES=5
RETRY_DELAY=3
READY_TIMEOUT=15
LOG_DIR="$PROJECT_ROOT/.revoice-logs"

mkdir -p "$LOG_DIR"

VITE_PID=""
ELECTRON_PID=""

# =============================================
# ユーティリティ関数
# =============================================
usage() {
    cat <<'USAGE'
Usage: ./start-perfect.sh [OPTIONS]

Options:
  --cleanup-only     クリーンアップのみ実行
  --skip-cleanup     クリーンアップをスキップして起動
  -h, --help         このメッセージを表示
USAGE
}

ensure_command() {
    local cmd="$1"
    if ! command -v "$cmd" >/dev/null 2>&1; then
        log_error "依存コマンド '$cmd' が見つかりません"
        exit 1
    fi
}

stop_process() {
    local pid="${1:-}"
    local label="${2:-process}"
    local force="${3:-false}"

    if [[ -z "$pid" ]]; then
        return 0
    fi

    if ! kill -0 "$pid" >/dev/null 2>&1; then
        return 0
    fi

    if [[ "$force" == "true" ]]; then
        kill -9 "$pid" >/dev/null 2>&1 || true
    else
        kill "$pid" >/dev/null 2>&1 || true
        sleep 1
        if kill -0 "$pid" >/dev/null 2>&1; then
            log_warning "$label (PID: $pid) が終了しないため強制終了します"
            kill -9 "$pid" >/dev/null 2>&1 || true
        fi
    fi

    wait "$pid" >/dev/null 2>&1 || true
}

handle_exit() {
    local status=$1
    if (( status != 0 )); then
        log_error "スクリプトがエラーで終了しました (exit code: $status)"
        stop_process "$ELECTRON_PID" "Electron" true
        stop_process "$VITE_PID" "Viteサーバー" true
        log_info "詳細は $LOG_DIR 内のログを確認してください"
    fi
}
trap 'handle_exit $?' EXIT

wait_for_http() {
    local timeout=$1
    local elapsed=0
    while (( elapsed < timeout )); do
        if curl --silent --head --fail --max-time 2 "http://127.0.0.1:$PORT/" >/dev/null; then
            return 0
        fi
        sleep 1
        ((elapsed++))
    done
    return 1
}

# =============================================
# コア処理
# =============================================
cleanup_processes() {
    log_info "プロセスをクリーンアップ中..."

    local port_pids
    port_pids=$(lsof -ti :"$PORT" 2>/dev/null || true)
    if [[ -n "$port_pids" ]]; then
        log_warning "ポート$PORT が使用中です。関連プロセスを終了します..."
        echo "$port_pids" | xargs kill >/dev/null 2>&1 || true
        sleep 1
        echo "$port_pids" | xargs kill -9 >/dev/null 2>&1 || true
    fi

    local stale_pids
    stale_pids=$(ps ax -o pid=,command= | grep "$PROJECT_ROOT" | grep -E '(Electron|electron|vite|wait-on|npm .*dev)' | awk '{print $1}' | tr '\n' ' ' || true)
    if [[ -n "$stale_pids" ]]; then
        log_warning "既存のElectron/Vite関連プロセスを終了します..."
        echo "$stale_pids" | xargs kill >/dev/null 2>&1 || true
        sleep 1
        echo "$stale_pids" | xargs kill -9 >/dev/null 2>&1 || true
    fi

    if lsof -i :"$PORT" >/dev/null 2>&1; then
        log_error "ポート$PORT の解放に失敗しました"
        return 1
    fi

    log_success "クリーンアップ完了"
    return 0
}

start_vite_server() {
    log_info "Viteサーバーを起動中..."
    local attempt
    local success=false
    pushd "$ELECTRON_DIR" >/dev/null

    for attempt in $(seq 1 "$MAX_RETRIES"); do
        local log_file="$LOG_DIR/vite_attempt_${attempt}.log"
        log_info "npm run renderer:dev を開始 (試行 $attempt/$MAX_RETRIES)"
        npm run renderer:dev >"$log_file" 2>&1 &
        VITE_PID=$!

        if wait_for_http "$READY_TIMEOUT"; then
            log_success "Viteサーバーが起動しました (PID: $VITE_PID)"
            log_info "ログ: $log_file"
            success=true
            break
        fi

        log_warning "Viteサーバーが応答しません。ログ: $log_file"
        stop_process "$VITE_PID" "Viteサーバー" true
        VITE_PID=""
        sleep "$RETRY_DELAY"
    done

    popd >/dev/null

    if [[ "$success" == "true" ]]; then
        return 0
    fi

    log_error "Viteサーバーの起動に失敗しました"
    return 1
}

start_electron() {
    log_info "Electronアプリを起動中..."
    local attempt
    local success=false
    pushd "$ELECTRON_DIR" >/dev/null

    for attempt in $(seq 1 "$MAX_RETRIES"); do
        local log_file="$LOG_DIR/electron_attempt_${attempt}.log"
        log_info "Electron起動コマンドを実行 (試行 $attempt/$MAX_RETRIES)"
        npx cross-env VITE_DEV_SERVER_URL="http://127.0.0.1:$PORT" electron . >"$log_file" 2>&1 &
        ELECTRON_PID=$!
        sleep "$RETRY_DELAY"

        if kill -0 "$ELECTRON_PID" >/dev/null 2>&1; then
            log_success "Electronアプリが起動しました (PID: $ELECTRON_PID)"
            log_info "ログ: $log_file"
            success=true
            break
        fi

        log_warning "Electronが起動しません。ログ: $log_file"
        stop_process "$ELECTRON_PID" "Electron" true
        ELECTRON_PID=""
        sleep "$RETRY_DELAY"
    done

    popd >/dev/null

    if [[ "$success" == "true" ]]; then
        return 0
    fi

    log_error "Electronアプリの起動に失敗しました"
    return 1
}

health_check() {
    log_info "ヘルスチェックを実行中..."

    if ! wait_for_http 5; then
        log_error "Viteサーバーが応答しません"
        return 1
    fi

    if ! lsof -i :"$PORT" >/dev/null 2>&1; then
        log_error "ポート$PORT にリスナーが存在しません"
        return 1
    fi

    if [[ -z "$ELECTRON_PID" ]] || ! kill -0 "$ELECTRON_PID" >/dev/null 2>&1; then
        log_error "Electronプロセスが確認できません"
        return 1
    fi

    log_success "ヘルスチェック完了 - すべて正常です"
    return 0
}

main() {
    local mode="full"
    local skip_cleanup=false

    while (($#)); do
        case "$1" in
            --cleanup-only)
                mode="cleanup"
                ;;
            --skip-cleanup)
                skip_cleanup=true
                ;;
            -h|--help)
                usage
                return 0
                ;;
            *)
                log_error "不明なオプション: $1"
                usage
                return 1
                ;;
        esac
        shift
    done

    ensure_command "npm"
    ensure_command "npx"
    ensure_command "curl"
    ensure_command "lsof"

    if [[ ! -d "$ELECTRON_DIR" ]]; then
        log_error "Electronディレクトリが見つかりません: $ELECTRON_DIR"
        exit 1
    fi

    if [[ "$mode" == "cleanup" ]]; then
        if cleanup_processes; then
            log_success "クリーンアップのみ完了しました"
            return 0
        else
            log_error "クリーンアップに失敗しました"
            return 1
        fi
    fi

    log_info "Revoice完璧起動スクリプト v2.1 を開始..."
    log_info "ログは $LOG_DIR に保存されます"

    if [[ "$skip_cleanup" == true ]]; then
        log_warning "--skip-cleanup が指定されたため既存プロセスの終了をスキップします"
    else
        if ! cleanup_processes; then
            log_error "クリーンアップに失敗しました"
            exit 1
        fi
    fi

    if ! start_vite_server; then
        log_error "Viteサーバーの起動に失敗しました"
        exit 1
    fi

    if ! start_electron; then
        log_error "Electronアプリの起動に失敗しました"
        exit 1
    fi

    if ! health_check; then
        log_error "ヘルスチェックに失敗しました"
        exit 1
    fi

    log_success "🎉 Revoiceアプリが正常に起動しました！"
    log_info "Electronウィンドウが開いていることを確認してください"
}

main "$@"
