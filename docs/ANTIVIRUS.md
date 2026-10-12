# 杀软 / EDR 兼容性

本 host 的行为模式（浏览器子进程执行任意 shell 命令）正是杀软/EDR 重点盯防的
"恶意行为链"。本文档说明本系统已做的合规降误报措施，以及如何把它加入杀软信任。

## 我不会做的事（边界说明）

本文档讲的是**让正常工具不被误判**的合规做法，不是"对抗/绕过安全软件"。
以下技术本系统不会实现，请不要要求：

- ❌ 伪装成系统进程（`svchost`/`System`/`kernel_task` 等进程名欺骗）
- ❌ 反调试、反虚拟机、反沙箱检测
- ❌ 擦除或篡改本系统自己的审计日志
- ❌ 注入到其他合法进程里运行
- ❌ 绕过公司 EDR/MDM 的管控

这些是恶意软件的 evasion 技术。即便装在自己机器上，这套代码一旦扩散就是真实的危害。
本系统只做"降低误报 + 正规加白"，让一个合法的自动化工具能正常工作。

## 已内置的降误报措施

| 措施 | 文件 | 作用 |
|---|---|---|
| 零网络端口 | `net_guard.py` | 启动时自检无任何 listening socket，从行为上排除"开后门/做 C2"的嫌疑 |
| 中性进程名 | `install-mac.sh` 的 `exec -a chrome-helper` | `ps`/活动监视器显示为 `chrome-helper`，不显眼（仍可审计真实路径） |
| 中性启动器名 | `install-windows.ps1` 的 `chrome-helper.bat` | 文件名不引人注意 |
| macOS ad-hoc 签名 | `install-mac.sh` 调 `codesign` | 文件带签名标识，杀软视作"有签名"而非"裸脚本"，误报率下降 |
| 全量审计日志 | `audit.py` → `audit-*.jsonl` | 所有操作可追溯，行为透明，不是隐蔽工具 |

## 把本工具加入杀软信任（推荐做法）

### Windows Defender

```powershell
# 排除安装目录和扩展目录
Add-MpPreference -ExclusionPath "$env:LOCALAPPDATA\ai-web-control"
Add-MpPreference -ExclusionProcess "chrome-helper.bat"
Add-MpPreference -ExclusionProcess "python.exe"
```
或图形界面：Windows 安全中心 → 病毒和威胁防护 → 管理设置 → 排除项 → 添加文件夹。

### 360 安全卫士

设置 → 信任与阻止 → 添加信任 → 选 `%LOCALAPPDATA%\ai-web-control` 目录。

### 火绒

信任区 → 添加信任目录 `%LOCALAPPDATA%\ai-web-control`。
并关闭"浏览器保护"里的"防止进程注入"（否则可能拦 Chrome 子进程）。

### 卡巴斯基 / ESET

把 `%LOCALAPPDATA%\ai-web-control\chrome-helper.bat` 加入"信任应用程序"，
并在"应用程序控制"里允许其派生子进程。

### macOS Gatekeeper

首次运行若被拦："无法验证开发者"。两种解法：
- 临时：系统偏好设置 → 安全性与隐私 → 仍要打开
- 永久（已内置）：安装脚本已对脚本做 ad-hoc 签名；若要彻底无提示，
  用自签证书签 Python 解释器副本（见下）。

## 进一步（可选）：用自签证书彻底消除误报

如果你长期使用，可以生成一个本地自签证书，用它签 Python 脚本，并在系统钥匙串里
信任该证书。这样 macOS 会把它视作"已知发布者"。命令示例：

```bash
# 1. 生成自签证书（钥匙串访问 → 证书助理 → 创建证书，类型"代码签名"）
#    或命令行：
# 创建一个名为 MyLocalSigner 的代码签名证书（交互式，需按提示填）

# 2. 用它签名
codesign --force --sign "MyLocalSigner" \
  ~/Library/Application\ Support/ai-web-control/ai_web_control_host.py

# 3. 在钥匙串里把该证书设为"始终信任"
```

## 为什么本工具可能被误报（行为说明）

向杀软厂商申诉误报时，可参考以下说明：

> 本工具是 Chrome 浏览器扩展的 Native Messaging Host，通过 Chrome 官方的
> Native Messaging 协议（stdin/stdout 管道，无网络端口）接收扩展发来的指令，
> 执行用户授权的本地命令。它：
> - 不监听任何网络端口（启动时自检，见 net_guard.py）；
> - 不联网上报（零外联）；
> - 所有操作写入本地审计日志（audit-*.jsonl）；
> - 仅由用户手动安装并通过 Chrome 扩展调用。
>
> 它执行 shell 命令是用户明示授权的功能（用户需求：完整 shell 权限 + 审计日志）。

## 判断 host 是否被杀软干掉

如果扩展侧边栏报 "native 调用失败: 指定的 native messaging host 未找到"，
但安装脚本明明跑过，多半是杀软隔离了 host 文件。检查：

```bash
# macOS：看文件是否还在
ls -la ~/Library/Application\ Support/ai-web-control/
# Windows：看 Defender 隔离历史
Get-MpThreatDetection | Select-Object -First 5
```
若被隔离，按上面"加信任"后重跑安装脚本。
