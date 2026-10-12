#!/usr/bin/env python3
"""
模拟 Chrome 的 Native Messaging 协议，对 host 做端到端测试。

不依赖 Chrome，直接用 subprocess 启动 host，按 4 字节帧协议收发，
验证 shell / file / ping / 错误处理都能正常工作。

用法：cd host && python3 ../tests/test_host.py
（或从任意目录运行，脚本会自动定位 host.py）
"""

import json
import os
import struct
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
HOST_DIR = os.path.join(os.path.dirname(HERE), "host")
HOST_PY = os.path.join(HOST_DIR, "ai_web_control_host.py")


def send(proc, msg):
    body = json.dumps(msg).encode("utf-8")
    proc.stdin.write(struct.pack("<I", len(body)))
    proc.stdin.write(body)
    proc.stdin.flush()


def recv(proc, timeout=10):
    """读一条消息。读不到返回 None。"""
    deadline = time.time() + timeout
    header = b""
    while len(header) < 4 and time.time() < deadline:
        chunk = proc.stdout.read(4 - len(header))
        if not chunk:
            time.sleep(0.05)
            continue
        header += chunk
    if len(header) < 4:
        return None
    n = struct.unpack("<I", header)[0]
    body = b""
    while len(body) < n and time.time() < deadline:
        chunk = proc.stdout.read(n - len(body))
        if not chunk:
            time.sleep(0.05)
            continue
        body += chunk
    return json.loads(body.decode("utf-8"))


def main():
    proc = subprocess.Popen(
        [sys.executable, HOST_PY],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, cwd=HOST_DIR,
    )
    try:
        # host 不再主动发 ready 握手（适配 sendNativeMessage 单次消息模式）。
        # 用 ping 作为连通性检查，回复里带 platform/capabilities。
        failures = 0
        print("[ok] host 已启动（无 ready 握手，改用 ping 探测）")
        # --- ping ---
        send(proc, {"type": "ping", "id": "p1"})
        m = recv(proc)
        if m and m.get("type") == "pong" and m.get("id") == "p1":
            print(f"[ok] ping/pong")
        else:
            print(f"[FAIL] ping -> {m}"); failures += 1

        # --- shell: 简单命令 ---
        send(proc, {"id": "s1", "action": "shell",
                    "cmd": "echo hello-aiweb"})
        m = recv(proc)
        if (m and m.get("ok") and "hello-aiweb" in m["data"]["stdout"]
                and m["data"]["returncode"] == 0):
            print(f"[ok] shell echo -> rc={m['data']['returncode']}")
        else:
            print(f"[FAIL] shell echo -> {m}"); failures += 1

        # --- shell: 非零退出码 ---
        send(proc, {"id": "s2", "action": "shell",
                    "cmd": "exit 7"})
        m = recv(proc)
        if (m and m.get("ok") and m["data"]["returncode"] == 7):
            print(f"[ok] shell exit 7 -> rc={m['data']['returncode']}")
        else:
            print(f"[FAIL] shell exit 7 -> {m}"); failures += 1

        # --- shell: 跨平台命令（macOS/Linux 都有 ls） ---
        send(proc, {"id": "s3", "action": "shell",
                    "cmd": "ls /", "timeout": 5})
        m = recv(proc)
        if (m and m.get("ok") and "bin" in m["data"]["stdout"]):
            print(f"[ok] shell ls /")
        else:
            print(f"[FAIL] shell ls / -> {m}"); failures += 1

        # --- file_write + file_read 回环 ---
        tmp = os.path.join(tempfile.gettempdir(), "aiweb_test_{}.txt".format(int(time.time())))
        send(proc, {"id": "fw1", "action": "file_write",
                    "path": tmp, "content": "line1\nline2\n"})
        m = recv(proc)
        if not (m and m.get("ok")):
            print(f"[FAIL] file_write -> {m}"); failures += 1
        else:
            send(proc, {"id": "fr1", "action": "file_read", "path": tmp})
            m = recv(proc)
            if (m and m.get("ok") and m["data"]["content"] == "line1\nline2\n"):
                print(f"[ok] file_write + file_read roundtrip")
            else:
                print(f"[FAIL] file_read -> {m}"); failures += 1
            os.remove(tmp)

        # --- file_list ---
        send(proc, {"id": "fl1", "action": "file_list", "path": HOST_DIR})
        m = recv(proc)
        names = [e["name"] for e in m["data"]["entries"]] if m and m.get("ok") else []
        if "ai_web_control_host.py" in names:
            print(f"[ok] file_list ({len(names)} entries)")
        else:
            print(f"[FAIL] file_list -> {m}"); failures += 1

        # --- 未知 action ---
        send(proc, {"id": "u1", "action": "bogus"})
        m = recv(proc)
        if (m and not m.get("ok") and "unknown action" in m.get("detail", "")):
            print(f"[ok] unknown action rejected")
        else:
            print(f"[FAIL] unknown action -> {m}"); failures += 1

        # --- 缺 action ---
        send(proc, {"id": "u2", "type": "request"})
        m = recv(proc)
        if (m and not m.get("ok") and m.get("error") == "missing_action"):
            print(f"[ok] missing action rejected")
        else:
            print(f"[FAIL] missing action -> {m}"); failures += 1

        print()
        if failures == 0:
            print("🎉 所有测试通过。host 端就绪。")
            return 0
        else:
            print(f"❌ {failures} 项失败")
            return 1

    finally:
        proc.stdin.close()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
        stderr = proc.stderr.read().decode("utf-8", "replace")
        if stderr.strip():
            print("\n--- host stderr ---")
            print(stderr)


if __name__ == "__main__":
    sys.exit(main())
