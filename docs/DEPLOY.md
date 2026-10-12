# 部署指南

本系统为**内网零外联**设计：扩展 + 本地 host，不依赖任何外部服务器。
每台电脑两步即可启用。

## 架构回顾

```
DeepSeek 网页 ──content script 注入──> Chrome 扩展 ──Native Messaging──> 本地 host (Python)
         (AI 输出 webctl 协议块)        (路由/安全闸)                     (shell/文件/审计)
```

---

## 开发机部署（开发者模式，最快）

适合自己试用或小范围验证。

### 第 1 步：加载扩展

1. 打开 Chrome → 地址栏输入 `chrome://extensions`
2. 右上角开启「**开发者模式**」
3. 点「**加载已解压的扩展程序**」
4. 选本仓库的 `extension/` 目录
5. 复制扩展的 ID（应为 `ododehoieahlobpdadhhhgghgeojkfpd`，由 manifest 的 key 字段固定）

### 第 2 步：安装 Native Host

**macOS：**
```bash
cd host
./install-mac.sh ododehoieahlobpdadhhhgghgeojkfpd
```

**Windows（PowerShell）：**
```powershell
cd host
.\install-windows.ps1 -ExtensionId ododehoieahlobpdadhhhgghgeojkfpd
```

> 如果执行 PowerShell 脚本被策略拦截，先：
> `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`

### 第 3 步：验证

1. 点浏览器工具栏的扩展图标 → 打开侧边栏
2. 「Shell」标签 → 输入 `echo hello` → 执行
3. 看到 `hello` 输出即连通

### 第 4 步：用 AI 网页控制

> **重要说明**：DeepSeek 网页版**没有"系统人设/自定义指令"功能**（已用浏览器实测确认，
> 截图可见界面只有"深度思考/智能搜索"开关，无 persona/instruction 入口）。
> 提示词无法跨对话持久生效，因此扩展提供了**自动注入**机制。

1. 打开 `https://chat.deepseek.com`
2. 扩展会自动检测到新对话（输入框为空），把系统提示词填入输入框
   —— 顶部会弹出绿色提示"已填入系统提示词，请点击发送"
   （侧边栏有「自动注入提示词」开关，默认开，可关）
3. 你只需点「发送」，让 AI 进入工具调用模式（AI 会回"设定已收到"）
4. 之后在对话里说「帮我打开计算器」→ AI 输出 webctl 块 → 自动执行
5. 网页右下角会弹出执行状态气泡

**换新对话时**：扩展会再次自动填入提示词，重复步骤 3 即可。
**手动方式（可选）**：若不想用自动注入，可自己复制 `prompts/deepseek-system-prompt.md`
内容，粘到新对话第一条消息里发送，效果相同。

---

## 企业内网批量部署（推荐）

适合给一群用户统一推送。利用 Chrome 企业策略，用户无感安装。

### 关键：固定 extensionId

本扩展的 `manifest.json` 已写入 `key` 字段，因此 extensionId 在所有机器上恒定为
`ododehoieahlobpdadhhhgghgeojkfpd`。这让 native host 的 `allowed_origins` 可以预先填好，
无需每台机器单独配。

### 打包 .crx

> **本仓库不提供打包私钥**（`*.pem` 已被 `.gitignore` 排除，公开仓库不安全携带签名私钥）。
> 上面「开发机部署」路线（加载已解压）**不需要**私钥，extensionId 由 `manifest.json`
> 的 `key` 字段固定。仅当你需要打包 `.crx` 做内网分发时，才需要自己生成一份私钥。

**路线 A：保持现有 extensionId（`ododehoie...`）**
需要与仓库 `manifest.json` 中 `key` 字段配对的原始私钥。若你手上没有，请走路线 B。

**路线 B：生成自己的 key 对（推荐给企业）**
```bash
# 1. 生成新私钥（Chrome 打包时也会自动产出 extension.pem）
openssl genrsa -out extension-key.pem 2048

# 2. 打包（产出 extension.crx）
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --pack-extension=./extension \
  --pack-extension-key=./extension-key.pem

# 3. 读出新的 extensionId 并同步给 native host
#    chrome://extensions 加载 extension.crx 后复制 ID，然后：
cd host && ./install-mac.sh <你的新 extensionId>
```
注意：路线 B 换私钥后，`manifest.json` 里的 `key` 字段需一并更新为新公钥，
否则 crx 与已解压加载的 ID 不一致；下文所有 `ododehoie...` 出现处都替换为你的新 ID。

### 自建 CRX 更新服务器（内网 HTTP）

在内网任意 HTTP 服务器上放：

```
https://intranet.example.com/crx/extension.crx        # 打包好的扩展
https://intranet.example.com/crx/updates.xml          # 更新清单
```

`updates.xml` 示例：
```xml
<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='ododehoieahlobpdadhhhgghgeojkfpd'>
    <updatecheck codebase='https://intranet.example.com/crx/extension.crx' version='0.1.0' />
  </app>
</gupdate>
```

### 用企业策略强制安装

**macOS**（配置描述文件 `.mobileconfig`）：
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>ExtensionSettings</key>
  <dict>
    <key>ododehoieahlobpdadhhhgghgeojkfpd</key>
    <dict>
      <key>installation_mode</key>
      <string>force_installed</string>
      <key>update_url</key>
      <string>https://intranet.example.com/crx/updates.xml</string>
    </dict>
  </dict>
</dict>
</plist>
```
用 MDM（如 Jamf）下发到目标 Mac。

**Windows**（注册表或组策略）：
```
HKLM\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist
  1 = "ododehoieahlobpdadhhhgghgeojkfpd;https://intranet.example.com/crx/updates.xml"
```
通过 GPO 推送。

### 批量装 Native Host

把 `host/` 目录和安装脚本打包，通过 MDM/SCCM/登录脚本推送到每台机器并执行。
macOS 用 `install-mac.sh`，Windows 用 `install-windows.ps1`，都用固定的 extensionId。

---

## 卸载

**扩展：** chrome://extensions → 移除。
**Host（macOS）：** 删除 `~/Library/Application Support/ai-web-control/` 和
  `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.zcode.aiwebcontrol.json`。
**Host（Windows）：** 删除 `%LOCALAPPDATA%\ai-web-control\`，删注册表项
  `HKCU\SOFTWARE\Google\Chrome\NativeMessagingHosts\com.zcode.aiwebcontrol`。

## 审计日志位置

所有操作（含参数摘要、是否命中危险模式）写入 JSONL：
- macOS：`~/Library/Logs/ai-web-control/audit-YYYYMMDD.jsonl`
- Windows：`%LOCALAPPDATA%\ai-web-control\logs\audit-YYYYMMDD.jsonl`
- Linux：`~/.local/share/ai-web-control/logs/audit-YYYYMMDD.jsonl`
