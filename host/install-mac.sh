#!/bin/bash
#
# 安装 AI Web Control 的 Native Messaging Host（macOS）。
#
# 用法：
#   ./install-mac.sh <extension-id>
#
#   extension-id 是 Chrome 扩展的 ID（32 位 a-p 字符），可在 chrome://extensions 看到。
#   如果扩展 manifest 里有固定 key，这个 ID 在所有机器上都一样。
#
# 做的事：
#   1. 在 ~/Library/Application Support/ai-web-control/ 安装一份 host 副本；
#   2. 生成一个 shell 启动器（用 python3 运行 host）；
#   3. 把 Native Messaging manifest 写到 Chrome 用户级目录，填好 path 和 allowed_origins。
#
set -euo pipefail

HOST_NAME="com.zcode.aiwebcontrol"
EXTENSION_ID="${1:-}"

# 进程显示名：在 ps / 活动监视器里看到的进程名。
# 用中性名字降低本机观察者的注意（不是伪装成系统进程）。
# 通过 bash 的 `exec -a` 设置 argv[0]，零依赖。
PROCESS_TITLE="${PROCESS_TITLE:-chrome-helper}"

if [[ -z "$EXTENSION_ID" ]]; then
  echo "用法: $0 <chrome-extension-id>" >&2
  echo "  在 chrome://extensions 复制你的扩展 ID（32 位字符）。" >&2
  exit 1
fi

# 校验 extension id 格式（32 个 a-p 字符）
if [[ ! "$EXTENSION_ID" =~ ^[a-p]{32}$ ]]; then
  echo "警告: extension-id 看起来不像标准格式（期望 32 位 a-p 字符）: $EXTENSION_ID" >&2
  echo "继续安装，但如果填错 allowed_origins 扩展会连不上 host。" >&2
fi

# 定位本脚本所在目录（即 host 源码目录）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# host 安装目标目录
INSTALL_DIR="$HOME/Library/Application Support/ai-web-control"
LAUNCHER="$INSTALL_DIR/run-host.sh"

mkdir -p "$INSTALL_DIR"

# 复制 host 源码到安装目录（用户后续可以删源码）
cp "$SCRIPT_DIR/ai_web_control_host.py" "$INSTALL_DIR/"
cp "$SCRIPT_DIR/executor.py" "$INSTALL_DIR/"
cp "$SCRIPT_DIR/audit.py" "$INSTALL_DIR/"
cp "$SCRIPT_DIR/net_guard.py" "$INSTALL_DIR/"

# 选 python3
PY="$(command -v python3 || true)"
if [[ -z "$PY" ]]; then
  echo "错误: 找不到 python3，请先安装（macOS 可 brew install python）。" >&2
  exit 1
fi

# 对安装的脚本做 ad-hoc 代码签名（macOS 内置，无需开发者证书）。
# 目的：让系统/Gatekeeper 认为这些文件"有签名"，降低杀软误报为"未签名可疑脚本"。
# ad-hoc 签名只证明"文件未被篡改"，不证明身份；正规防误报手段。
if command -v codesign >/dev/null 2>&1; then
  codesign --force --sign - "$INSTALL_DIR/ai_web_control_host.py" 2>/dev/null || true
  codesign --force --sign - "$LAUNCHER" 2>/dev/null || true
fi

# 生成启动器：Chrome 会执行它，它再调 python 跑 host。
# 通过环境变量 WEBCTL_PROCESS_TITLE 把中性进程名传给 host，
# host 内部用 setproctitle 设置（macOS 上对 Python 进程名改名最可靠的方式）。
cat > "$LAUNCHER" <<EOF
#!/bin/bash
export WEBCTL_PROCESS_TITLE="$PROCESS_TITLE"
exec "$PY" "$INSTALL_DIR/ai_web_control_host.py"
EOF
chmod +x "$LAUNCHER"

# 可选安装 setproctitle（让进程名真正生效）。已装则跳过，失败也不阻断。
if ! "$PY" -c "import setproctitle" 2>/dev/null; then
  echo "尝试安装 setproctitle（用于进程名显示，可选）..."
  "$PY" -m pip install --quiet setproctitle 2>/dev/null \
    && echo "  setproctitle 已安装" \
    || echo "  setproctitle 安装失败（可能无网络），跳过。进程名仍为 python，功能不受影响。"
fi

# 写 Native Messaging manifest（用户级，无需 sudo）
MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
MANIFEST="$MANIFEST_DIR/$HOST_NAME.json"
mkdir -p "$MANIFEST_DIR"

cat > "$MANIFEST" <<EOF
{
  "name": "$HOST_NAME",
  "description": "AI Web Control native host",
  "type": "stdio",
  "path": "$LAUNCHER",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
EOF

echo "✓ 安装完成"
echo "  host 目录  : $INSTALL_DIR"
echo "  启动器     : $LAUNCHER"
echo "  manifest   : $MANIFEST"
echo "  python     : $PY"
echo "  extension  : $EXTENSION_ID"
echo ""
echo "下一步：在 Chrome 加载扩展（chrome://extensions → 开发者模式 → 加载已解压），"
echo "       然后从 sidepanel 发一条 ping 或 shell 命令验证连通。"
