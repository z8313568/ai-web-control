#!/usr/bin/env python3
"""
AI Web Control — Native Messaging Host.

Chrome 扩展通过 Native Messaging（stdin/stdout，4 字节 little-endian 长度头 + JSON）
与本进程通信。本进程负责：
  1. 读取协议帧；
  2. 派发给 executor 执行（shell / file_read / file_write / file_list）；
  3. 写回结果帧；
  4. 所有操作经 audit 落盘。

通信契约见 docs/PROTOCOL.md。stdout 只允许写协议帧，任何日志走 stderr/文件。
"""

import json
import os
import struct
import sys
import threading
import traceback

from audit import AuditLogger
from executor import Executor
from net_guard import check_on_startup

HOST_NAME = "com.zcode.aiwebcontrol"

# 进程显示名：在 ps / 活动监视器里看到的中性名字，降低本机观察注意。
# 不是伪装成系统进程，认真审计仍可查到真实脚本路径。
PROCESS_TITLE = os.environ.get("WEBCTL_PROCESS_TITLE", "chrome-helper")


def _set_process_title():
    """尝试改进程显示名。优先 setproctitle（最可靠），不可用则静默跳过。"""
    try:
        import setproctitle
        setproctitle.setproctitle(PROCESS_TITLE)
    except ImportError:
        # setproctitle 未安装：macOS 上 argv[0] 改名对 Python 不生效，跳过。
        # 这是可接受的降级——功能不受影响，只是进程名仍显示为 python。
        pass


_set_process_title()


# --------------------------------------------------------------------------- #
# Native Messaging 协议读写
# --------------------------------------------------------------------------- #
def read_message():
    """从 stdin 读一条 Native Messaging 消息。

    帧格式：前 4 字节 unsigned int (little-endian) = JSON 正文字节数。
    返回解析后的 dict，或 None 表示 stdin 已关闭（Chrome 断开连接）。
    """
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None  # EOF，Chrome 关闭了连接

    msg_len = struct.unpack("<I", raw_len)[0]
    if msg_len == 0:
        return {}

    body = sys.stdin.buffer.read(msg_len)
    if len(body) < msg_len:
        return None  # 不完整，视为断开

    return json.loads(body.decode("utf-8"))


def write_message(msg):
    """往 stdout 写一条 Native Messaging 消息。"""
    body = json.dumps(msg, ensure_ascii=False).encode("utf-8")
    # 超过 1MB 的消息 Chrome 会拒收，这里主动截断保护
    if len(body) > 1024 * 1024:
        write_message({
            "type": "error",
            "error": "response_too_large",
            "detail": f"响应体 {len(body)} 字节超过 1MB 上限，已截断",
            "original_type": msg.get("type") if isinstance(msg, dict) else None,
        })
        return

    sys.stdout.buffer.write(struct.pack("<I", len(body)))
    sys.stdout.buffer.write(body)
    sys.stdout.buffer.flush()


# --------------------------------------------------------------------------- #
# 主消息循环
# --------------------------------------------------------------------------- #
def main():
    # 启动时网络自检：确保进程没有打开任何监听 socket。
    # 这是"跨机器扫描检测不到本服务"的根本保证。
    # 若发现监听 socket（代码被篡改），立即 abort（exit 13）。
    check_on_startup()

    audit = AuditLogger()
    executor = Executor(audit=audit)

    # 注意：不主动发送 ready 握手。
    # 扩展用 sendNativeMessage（单次消息模式）：每次发一条、期望收到一条对应回复。
    # 若 host 启动时先写 ready，会被当成第一条命令的回复，导致错位。
    # host 的能力通过 ping 消息按需查询即可。

    while True:
        try:
            msg = read_message()
        except Exception as e:
            # 解析失败也要回复，避免扩展端死等
            sys.stderr.write(f"[host] read/parse error: {e}\n")
            write_message({"type": "error", "error": "parse_failed", "detail": str(e)})
            continue

        if msg is None:
            # stdin 关闭 = Chrome 断开，干净退出
            sys.stderr.write("[host] stdin closed, exiting.\n")
            break

        # 详细日志：记录收到的每条消息（截断防刷屏）
        msg_preview = str(msg)[:200]
        sys.stderr.write(f"[host] ← recv: {msg_preview}\n")
        sys.stderr.flush()

        # 单次消息模式下，Chrome 发一条、等一条回复。
        # 同步处理（不开线程）确保回复严格按请求顺序返回，不会错乱。
        handle_message(executor, msg)


def handle_message(executor, msg):
    """处理单条消息，把结果写回 stdout。

    stdout 的写入用一把全局锁串行化，避免多线程交错写坏帧。
    """
    if not isinstance(msg, dict):
        with _write_lock:
            write_message({"type": "error", "error": "invalid_message", "detail": "expecting a JSON object"})
        return

    msg_type = msg.get("type", "request")
    req_id = msg.get("id") or msg.get("req_id") or ""

    # ping 是保活探针，立即回
    if msg_type == "ping" or msg.get("action") == "ping":
        with _write_lock:
            write_message({"type": "pong", "id": req_id, "ts": _now_iso()})
        return

    action = msg.get("action")
    if not action:
        with _write_lock:
            write_message({
                "type": "result",
                "id": req_id,
                "ok": False,
                "error": "missing_action",
            })
        return

    try:
        result = executor.dispatch(action, msg)
        payload = {
            "type": "result",
            "id": req_id,
            "ok": True,
            "data": result,
        }
        sys.stderr.write(f"[host] → send: ok, data keys={list(result.keys()) if isinstance(result, dict) else type(result).__name__}\n")
    except Exception as e:
        sys.stderr.write(f"[host] action {action} failed: {e}\n"
                         f"{traceback.format_exc()}")
        payload = {
            "type": "result",
            "id": req_id,
            "ok": False,
            "error": type(e).__name__,
            "detail": str(e),
        }
        sys.stderr.write(f"[host] → send: error {payload['error']}: {payload['detail']}\n")
    sys.stderr.flush()

    with _write_lock:
        write_message(payload)


_write_lock = threading.Lock()


def _now_iso():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


if __name__ == "__main__":
    main()
