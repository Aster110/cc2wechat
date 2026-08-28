#!/usr/bin/env bash
# cc2wechat 带外看门狗 —— 安装 / 卸载（幂等，bash 与 zsh 下都能跑）
#
#   bash scripts/install-watchdog.sh              安装（macOS=launchd / Linux=crontab，每 2 分钟一次）
#   bash scripts/install-watchdog.sh --uninstall  卸载
#   bash scripts/install-watchdog.sh --status     看当前装没装
#
# 为什么是 cron/launchd 而不是常驻进程：常驻的看门狗会跟着被看护的进程一起死
# （同一次 OOM、同一次 kill -9、同一次机器重启）。一次性运行模型把"看门狗自己活着"
# 这件事外包给系统的调度器——那才是真正的带外。

set -eu

LABEL="com.aster.cc2wechat-watchdog"
INTERVAL_SEC=120
CRON_MARKER="# cc2wechat-watchdog"

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
ENTRY="$REPO_DIR/dist/watchdog/cli.js"

DATA_DIR="$HOME/.cc2wechat"
CONFIG_FILE="$DATA_DIR/watchdog.json"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LAUNCHD_LOG="$DATA_DIR/watchdog-launchd.log"

MODE="install"
for arg in "$@"; do
  case "$arg" in
    --uninstall) MODE="uninstall" ;;
    --status) MODE="status" ;;
    -h|--help)
      printf '%s\n' "用法: $0 [--uninstall|--status]"
      exit 0
      ;;
    *)
      printf '未知参数: %s\n' "$arg" >&2
      exit 2
      ;;
  esac
done

OS=$(uname -s)

log() { printf '[watchdog-install] %s\n' "$1"; }

# ---------------------------------------------------------------- 卸载 / 状态

uninstall_macos() {
  if [ -f "$PLIST" ]; then
    launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || launchctl unload "$PLIST" >/dev/null 2>&1 || true
    rm -f "$PLIST"
    log "已卸载 launchd 任务: $LABEL"
  else
    log "launchd 任务本来就没装"
  fi
}

uninstall_linux() {
  if crontab -l 2>/dev/null | grep -qF "$CRON_MARKER"; then
    crontab -l 2>/dev/null | grep -vF "$CRON_MARKER" | crontab -
    log "已从 crontab 移除看门狗"
  else
    log "crontab 里本来就没有"
  fi
}

status_macos() {
  if [ -f "$PLIST" ]; then
    log "plist 在: $PLIST"
    launchctl list 2>/dev/null | grep -F "$LABEL" || log "（launchctl list 里没有，可能没 load 上）"
  else
    log "未安装"
  fi
}

status_linux() {
  crontab -l 2>/dev/null | grep -F "$CRON_MARKER" || log "未安装"
}

if [ "$MODE" = "uninstall" ]; then
  case "$OS" in
    Darwin) uninstall_macos ;;
    *) uninstall_linux ;;
  esac
  log "配置与状态文件保留在 ${DATA_DIR}（要清干净自己删）"
  exit 0
fi

if [ "$MODE" = "status" ]; then
  case "$OS" in
    Darwin) status_macos ;;
    *) status_linux ;;
  esac
  exit 0
fi

# -------------------------------------------------------------------- 安装

NODE_BIN=$(command -v node || true)
if [ -z "$NODE_BIN" ]; then
  printf '找不到 node，先装 node>=22 再来\n' >&2
  exit 1
fi

if [ ! -f "$ENTRY" ]; then
  printf '缺少 %s\n先在仓里跑一次: npm run build\n' "$ENTRY" >&2
  exit 1
fi

mkdir -p "$DATA_DIR"

WROTE_SAMPLE=0
if [ ! -f "$CONFIG_FILE" ]; then
  MACHINE=$(hostname -s 2>/dev/null || hostname)
  cat > "$CONFIG_FILE" <<EOF
{
  "machine": "$MACHINE",
  "webhook": "https://open.feishu.cn/open-apis/bot/v2/hook/PUT-YOUR-WEBHOOK-HERE",
  "daemons": [
    { "name": "codex-18087", "port": 18087 }
  ],
  "expiryFile": "~/.cc2wechat/credentials-expiry.json",
  "heartbeatHour": 9
}
EOF
  chmod 600 "$CONFIG_FILE"
  WROTE_SAMPLE=1
  log "已写入样例配置: $CONFIG_FILE"
fi

case "$OS" in
  Darwin)
    mkdir -p "$HOME/Library/LaunchAgents"
    NODE_DIR=$(dirname "$NODE_BIN")
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$ENTRY</string>
  </array>
  <key>StartInterval</key><integer>$INTERVAL_SEC</integer>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$NODE_DIR:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StandardOutPath</key><string>$LAUNCHD_LOG</string>
  <key>StandardErrorPath</key><string>$LAUNCHD_LOG</string>
  <key>WorkingDirectory</key><string>$REPO_DIR</string>
</dict>
</plist>
EOF
    # 幂等：先 bootout 再 bootstrap，重复跑不会报 "already loaded"
    launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
    if ! launchctl bootstrap "gui/$(id -u)" "$PLIST" >/dev/null 2>&1; then
      launchctl unload "$PLIST" >/dev/null 2>&1 || true
      launchctl load "$PLIST"
    fi
    log "launchd 已装好: ${LABEL}（每 ${INTERVAL_SEC}s 一次）"
    log "日志: $LAUNCHD_LOG 与 $DATA_DIR/watchdog.log"
    ;;
  *)
    CRON_LINE="*/2 * * * * $NODE_BIN $ENTRY >> $DATA_DIR/watchdog-cron.log 2>&1 $CRON_MARKER"
    # 幂等：先滤掉旧的同 marker 行，再追加
    (crontab -l 2>/dev/null | grep -vF "$CRON_MARKER" || true; printf '%s\n' "$CRON_LINE") | crontab -
    log "crontab 已装好（*/2 * * * *）"
    log "日志: $DATA_DIR/watchdog-cron.log 与 $DATA_DIR/watchdog.log"
    ;;
esac

if [ "$WROTE_SAMPLE" = "1" ]; then
  printf '\n'
  log "⚠️  还差一步：编辑 ${CONFIG_FILE}，把 webhook 换成真实的飞书机器人地址"
  log "改完验一下带外通道: $NODE_BIN $ENTRY --test-alert"
else
  log "沿用已有配置: $CONFIG_FILE"
  log "验一下: $NODE_BIN $ENTRY --test-alert"
fi
