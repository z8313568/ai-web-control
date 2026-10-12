# AI Web Control

让 AI 网页版（DeepSeek 等）通过浏览器扩展**控制你的电脑**：执行命令、读写文件、控制浏览器。
**内网零外联**——不需要任何外部服务器，扩展 + 本地小程序即可。

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│ DeepSeek 网页   │────▶│  Chrome 扩展     │────▶│  本地 host      │
│ AI 输出工具调用 │     │  (MV3)           │     │  (Python)       │
│ (webctl 协议块) │     │  路由/安全/审计  │     │  shell/文件     │
└─────────────────┘     └──────────────────┘     └─────────────────┘
   不用改网页              注入 content script       Native Messaging
```

## 它怎么工作（一句话）

Chrome 扩展把 JS 注入到 DeepSeek 网页里（不用改网页），读 AI 的对话气泡；
AI 按约定格式输出 ```` ```webctl ```` 代码块，扩展解析后通过 Native Messaging
调本地 Python 程序执行命令/读写文件，结果反馈到网页上。

## 能力

| 能力 | 说明 |
|---|---|
| `shell` | 执行任意命令/脚本（完整 shell 权限） |
| `file_read` / `file_write` / `file_list` | 读写文件、列目录 |
| `browse` | 打开 URL、截当前页（走扩展 chrome.tabs，不经 host） |
| `notify` | 仅提示，不执行操作 |
| **网站适配** | 任意大模型网页可用——内置拾取工具选元素，无需改代码。详见 [docs/ADAPTERS.md](docs/ADAPTERS.md) |

**安全**：完整 Shell + 全量审计日志 + 危险关键字告警 + 一键总开关 + 速率限制。
详见 [docs/SECURITY.md](docs/SECURITY.md)。

## 快速开始（3 分钟）

```bash
git clone https://github.com/z8313568/ai-web-control.git
cd ai-web-control
```

### 1. 加载扩展
`chrome://extensions` → 开启开发者模式 → 加载已解压 → 选本仓库的 `extension/` 目录。
复制扩展 ID（应为 `ododehoieahlobpdadhhhgghgeojkfpd`，由 `manifest.json` 的 `key` 字段固定）。

### 2. 安装本地 host
```bash
# macOS
cd host && ./install-mac.sh ododehoieahlobpdadhhhgghgeojkfpd

# Windows (PowerShell)
cd host ; .\install-windows.ps1 -ExtensionId ododehoieahlobpdadhhhgghgeojkfpd
```

### 3. 验证
点扩展图标 → 侧边栏「Shell」标签 → 输入 `echo hello` → 执行。

### 4. 用 AI 网页控制
打开 `chat.deepseek.com` → 扩展自动把系统提示词填入输入框（顶部绿条提示）→
点发送让 AI 进入工具模式 → 对话「帮我打开计算器」→ 网页右下角弹出执行状态。

> DeepSeek 网页版没有"系统人设"功能，所以扩展用**自动注入**代替——
> 每个新对话自动填入提示词，点发送即可。详见 [docs/DEPLOY.md](docs/DEPLOY.md)。

## 项目结构

```
ai-web-control/
├── extension/                      Chrome 扩展（MV3）
│   ├── manifest.json               含固定 key，extensionId 恒定
│   ├── background.js               Service Worker：路由/安全闸
│   ├── sidepanel.{html,js}         侧边栏：手动执行/Shell/文件/网站配置/日志
│   └── content/
│       ├── protocol.js             webctl 协议解析
│       ├── ui.js                   网页上的状态气泡
│       ├── config.js               内置默认配置 + 系统提示词
│       ├── adapter.js              通用适配器（任意网站，读配置监听）
│       ├── picker.js               元素拾取工具（悬停高亮选元素）
│       ├── logger.js               全链路日志（写入 agentLog）
│       └── floating_taskbar.js     网页左上角浮动任务栏
├── host/                           Native Host（Python）
│   ├── ai_web_control_host.py      4字节协议 + 多线程分发
│   ├── executor.py                 shell/file 执行 + 危险关键字告警
│   ├── net_guard.py                无网络监听自检（零外联保证）
│   ├── audit.py                    JSONL 审计日志
│   ├── com.zcode.aiwebcontrol.json Native Messaging 清单模板
│   ├── install-mac.sh              macOS 一键安装
│   └── install-windows.ps1         Windows 一键安装
├── prompts/
│   └── deepseek-system-prompt.md   让 AI 按协议输出的提示词
├── docs/
│   ├── PROTOCOL.md                 工具调用协议规范
│   ├── DEPLOY.md                   部署指南（含企业批量推送）
│   ├── SECURITY.md                 安全模型
│   ├── ADAPTERS.md                 网站适配（拾取工具）
│   └── ANTIVIRUS.md                杀软兼容说明
└── tests/
    └── test_host.py                host 端端到端测试（9 项）
```

## 关键技术点

- **单次消息模式**：扩展用 `chrome.runtime.sendNativeMessage`（非长连接），
  无状态、抗 Service Worker 休眠——每次发一条收一条，SW 休眠不影响。
  （注：offscreen document 的 `NATIVE_COMMUNICATION` reason 在当前 Chrome 已不被
  接受，故不采用 offscreen 方案。）
- **固定 extensionId**：manifest 的 `key` 字段让 ID 在所有机器恒定，native host 的
  `allowed_origins` 可预填。
- **流式输出判定**：DeepSeek 逐字输出，用每个 markdown 容器独立 debounce 1200ms
  判定回复结束，再解析 webctl 块。
- **1MB 消息上限**：大文件/截图走"本地临时文件 + 路径传递"。
- **Windows 二进制模式**：host 用 `sys.stdin.buffer`，避免 CRLF 编码坑。

## 测试

```bash
python3 tests/test_host.py
```
应输出 9 项全过（退出码 0）：host 启动探测、ping/pong 握手、shell 执行与退出码透传、
`ls` 列目录、文件读写回环、文件列表、非法 action 拒绝、缺失 action 拒绝。

## 扩展到其他 AI 网页（内网/公网任意网站）

加通义/豆包或**内网自建 AI 网页**，**不需要写代码**：在侧边栏「网站配置」标签
用拾取工具选好输入框/发送按钮/输出区域即可，详见 [docs/ADAPTERS.md](docs/ADAPTERS.md)。

## 文档

- [网站适配（拾取工具）](docs/ADAPTERS.md) — 任意网站配置选择器
- [协议规范](docs/PROTOCOL.md)
- [部署指南](docs/DEPLOY.md)（含企业批量推送）
- [安全模型](docs/SECURITY.md)
- [杀软兼容](docs/ANTIVIRUS.md)

## 风险提示

- **完整 Shell 权限**风险大，AI 被诱导可能执行危险命令。有告警和审计，但**不阻断**。
  不可信的 AI 对话里请用侧边栏总开关关闭。
- **DeepSeek DOM 可能变**。`ds-markdown` 类名若改版，监听失效，需维护适配器。
- 面向个人电脑/开发机，**不要装在生产服务器上**。
