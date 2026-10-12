"""
审计日志：所有经过 host 的操作都落盘为 JSONL，便于回溯。

日志位置：
  macOS : ~/Library/Logs/ai-web-control/audit-YYYYMMDD.jsonl
  Linux : ~/.local/share/ai-web-control/logs/audit-YYYYMMDD.jsonl
  Win   : %LOCALAPPDATA%\\ai-web-control\\logs\\audit-YYYYMMDD.jsonl

stdout 绝不能写日志（会污染 Native Messaging 帧），所有日志走文件。
"""

import json
import os
import sys
import threading
from datetime import datetime, timezone


def _log_dir():
    if sys.platform == "darwin":
        base = os.path.expanduser("~/Library/Logs/ai-web-control")
    elif sys.platform == "win32":
        base = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")),
                            "ai-web-control", "logs")
    else:
        base = os.path.expanduser("~/.local/share/ai-web-control/logs")
    os.makedirs(base, exist_ok=True)
    return base


class AuditLogger:
    def __init__(self):
        self._lock = threading.Lock()

    def log(self, action, detail):
        """记录一条操作。action 是动作类型，detail 是该动作的参数摘要。"""
        entry = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "pid": os.getpid(),
            "platform": sys.platform,
            "action": action,
            "detail": detail,
        }
        line = json.dumps(entry, ensure_ascii=False)
        try:
            with self._lock:
                day = datetime.now().strftime("%Y%m%d")
                path = os.path.join(_log_dir(), f"audit-{day}.jsonl")
                with open(path, "a", encoding="utf-8") as f:
                    f.write(line + "\n")
        except Exception as e:
            # 日志失败不能影响主流程，落到 stderr
            sys.stderr.write(f"[audit] failed to write: {e}\n")
        return entry
