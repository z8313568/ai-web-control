"""
网络自检（net_guard）。

本 host 的设计契约：只通过 stdin/stdout 管道与 Chrome 通信，**绝不**打开任何
网络监听 socket。这是"跨机器扫描检测不到"的根本保证——没有任何端口可供扫描。

本模块做防御性自检：启动时和每次执行命令前，断言当前进程没有持有任何
listening socket。如果将来代码被误改引入了网络监听，会立刻 abort 并告警，
而不是悄悄变成一个网络服务。

这不是"隐藏网络服务"——而是"保证根本没有网络服务可被扫描"。
"""

import socket
import sys
import threading

_lock = threading.Lock()


def assert_no_listening_sockets():
    """扫描当前进程的文件描述符表，确认没有任何 listening TCP/UDP socket。

    实现：枚举 fd，尝试用 getsockname + SO_ACCEPTCONN 判断。
    若发现监听 socket，抛 RuntimeError 中止启动。
    """
    found = []
    # 逐个 fd 探测。fd 编号可能不连续，扫到上限 1024 足够。
    import errno
    for fd in range(0, 1024):
        try:
            s = socket.fromfd(fd, socket.AF_INET, socket.SOCK_STREAM)
        except OSError:
            # 这个 fd 不是 socket 或已关闭，正常
            continue
        try:
            # 是否处于监听状态
            listening = s.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN)
            if listening:
                try:
                    name = s.getsockname()
                except OSError:
                    name = "?"
                found.append(("listening", name))
            s.detach()  # 不要关掉原 fd，只是借用探测
        except OSError:
            s.detach()
            continue

    if found:
        # 严重违规：进程开了监听 socket，违反设计契约。中止。
        raise RuntimeError(
            f"[net_guard] 网络契约被违反：检测到 {len(found)} 个监听 socket: {found}。"
            "本 host 设计上不应有任何网络监听，请检查代码是否被篡改。"
        )


def check_on_startup():
    """启动时自检。失败则退出进程（exit 13），绝不带网络暴露面运行。"""
    try:
        with _lock:
            assert_no_listening_sockets()
    except RuntimeError as e:
        sys.stderr.write(str(e) + "\n")
        sys.exit(13)
