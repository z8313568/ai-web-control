"""
命令执行器。

按用户要求采用「完整 Shell + 日志审计」策略：不阻断任何命令，
但对危险命令打 warning 级别标记，便于审计回溯。

所有 action 在这里分发，结果统一为 dict，由 host 主程序包装成协议帧回写。
"""

import os
import shlex
import subprocess

# 危险关键字（仅告警，不阻断）。命中即给审计日志打 danger=true。
_DANGER_PATTERNS = [
    "rm -rf /", "rm -rf ~", "rm -rf $HOME", "rm -rf *",
    "mkfs", "dd if=", ":(){:|:&};:",
    "shutdown", "reboot", "halt",
    "chmod -R 000", "chown -R",
    "> /dev/sda", "mv / ",
]


def _looks_dangerous(cmd):
    norm = " ".join(cmd.split()).lower()
    for pat in _DANGER_PATTERNS:
        if pat.lower() in norm:
            return True, pat
    return False, None


class Executor:
    """分发并执行 action。无状态，所有持久化交给 audit。"""

    def __init__(self, audit):
        self.audit = audit

    # ----------------------------------------------------------------- #
    def dispatch(self, action, msg):
        handler = {
            "shell": self._shell,
            "file_read": self._file_read,
            "file_write": self._file_write,
            "file_list": self._file_list,
        }.get(action)

        if handler is None:
            raise ValueError(f"unknown action: {action}")
        return handler(msg)

    # ----------------------------------------------------------------- #
    def _shell(self, msg):
        cmd = msg.get("cmd")
        if not cmd:
            raise ValueError("missing 'cmd'")

        timeout = float(msg.get("timeout", 30))
        cwd = msg.get("cwd") or None
        use_shell = bool(msg.get("shell", True))

        dangerous, matched = _looks_dangerous(cmd)

        self.audit.log("shell", {
            "cmd": cmd,
            "cwd": cwd,
            "dangerous": dangerous,
            "danger_match": matched,
        })

        if use_shell:
            proc = subprocess.run(
                cmd, shell=True, cwd=cwd,
                capture_output=True, text=True, timeout=timeout,
            )
        else:
            # 拆参数模式：cmd 应为 list；如果是 str 则按 shlex 拆分
            argv = cmd if isinstance(cmd, list) else shlex.split(cmd)
            proc = subprocess.run(
                argv, cwd=cwd,
                capture_output=True, text=True, timeout=timeout,
            )

        return {
            "action": "shell",
            "returncode": proc.returncode,
            "stdout": _truncate(proc.stdout, 200_000),
            "stderr": _truncate(proc.stderr, 200_000),
            "dangerous": dangerous,
            "danger_match": matched,
        }

    # ----------------------------------------------------------------- #
    def _file_read(self, msg):
        path = os.path.expanduser(msg.get("path", ""))
        if not path:
            raise ValueError("missing 'path'")

        self.audit.log("file_read", {"path": path})

        if not os.path.isfile(path):
            raise FileNotFoundError(path)

        # 大文件只读前 200KB，避免超 1MB 协议上限
        size = os.path.getsize(path)
        limit = 200_000
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read(limit)

        return {
            "action": "file_read",
            "path": path,
            "size": size,
            "truncated": size > limit,
            "content": content,
        }

    def _file_write(self, msg):
        path = os.path.expanduser(msg.get("path", ""))
        content = msg.get("content", "")
        append = bool(msg.get("append", False))
        if not path:
            raise ValueError("missing 'path'")

        self.audit.log("file_write", {"path": path, "bytes": len(content), "append": append})

        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        mode = "a" if append else "w"
        with open(path, mode, encoding="utf-8") as f:
            f.write(content)

        return {
            "action": "file_write",
            "path": path,
            "bytes": len(content),
            "append": append,
        }

    def _file_list(self, msg):
        path = os.path.expanduser(msg.get("path", "."))
        self.audit.log("file_list", {"path": path})

        if not os.path.isdir(path):
            raise NotADirectoryError(path)

        entries = []
        for name in sorted(os.listdir(path)):
            full = os.path.join(path, name)
            try:
                st = os.stat(full)
                entries.append({
                    "name": name,
                    "size": st.st_size,
                    "is_dir": os.path.isdir(full),
                    "mtime": int(st.st_mtime),
                })
            except OSError:
                entries.append({"name": name, "error": "stat_failed"})

        return {"action": "file_list", "path": path, "entries": entries}


def _truncate(s, limit):
    if len(s) <= limit:
        return s
    return s[:limit] + f"\n... [truncated, {len(s) - limit} more chars]"
