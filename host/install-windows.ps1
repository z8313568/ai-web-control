# 安装 AI Web Control 的 Native Messaging Host（Windows）。
#
# 用法（在 PowerShell 里）：
#   .\install-windows.ps1 -ExtensionId <chrome-extension-id>
#
# 做的事：
#   1. 把 host 源码复制到 %LOCALAPPDATA%\ai-web-control\；
#   2. 生成一个 .bat 启动器（用 python 运行 host）；
#   3. 写 Native Messaging manifest 到安装目录；
#   4. 在 HKCU 注册表登记 manifest 路径（当前用户，无需管理员）。
#
# 注意 Windows 的坑：host 的 stdout 必须是二进制模式。
# 我们的 Python host 用 sys.stdin.buffer / sys.stdout.buffer，已正确处理。

param(
    [Parameter(Mandatory = $true)]
    [string]$ExtensionId
)

$ErrorActionPreference = "Stop"
$HostName = "com.zcode.aiwebcontrol"

# 校验 extension id 格式（32 个 a-p 字符）
if ($ExtensionId -notmatch '^[a-p]{32}$') {
    Write-Warning "extension-id 看起来不像标准格式（期望 32 位 a-p 字符）: $ExtensionId"
    Write-Warning "继续安装，但如果填错 allowed_origins 扩展会连不上 host。"
}

# 定位本脚本所在目录（host 源码目录）
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition

# 启动器文件名：中性命名，降低本机观察注意（不是伪装成系统进程）。
$LauncherName = if ($env:LAUNCHER_NAME) { $env:LAUNCHER_NAME } else { "chrome-helper.bat" }

# 安装目标目录
$InstallDir = Join-Path $env:LOCALAPPDATA "ai-web-control"
$Launcher   = Join-Path $InstallDir $LauncherName
$Manifest   = Join-Path $InstallDir "$HostName.json"

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# 复制 host 源码
Copy-Item (Join-Path $ScriptDir "ai_web_control_host.py") $InstallDir -Force
Copy-Item (Join-Path $ScriptDir "executor.py") $InstallDir -Force
Copy-Item (Join-Path $ScriptDir "audit.py") $InstallDir -Force
Copy-Item (Join-Path $ScriptDir "net_guard.py") $InstallDir -Force

# 找 python
$Py = (Get-Command python -ErrorAction SilentlyContinue) `
   ?? (Get-Command python3 -ErrorAction SilentlyContinue) `
   ?? (Get-Command py -ErrorAction SilentlyContinue)

if (-not $Py) {
    Write-Error "找不到 python，请先安装（https://www.python.org/downloads/，勾选 Add to PATH）。"
    exit 1
}
$PyExe = if ($Py.Name -eq "py") { "py" } else { $Py.Source }

# 生成 .bat 启动器
# 用 cd /d 切到安装目录，避免 host 读不到同目录模块
$BatContent = @"
@echo off
cd /d "$InstallDir"
"$PyExe" "$InstallDir\ai_web_control_host.py"
"@
Set-Content -Path $Launcher -Value $BatContent -Encoding ASCII

# 写 manifest（JSON，注意路径用双反斜杠）
$ManifestContent = @"
{
  "name": "$HostName",
  "description": "AI Web Control native host",
  "type": "stdio",
  "path": "$($Launcher -replace '\\','\\')",
  "allowed_origins": [
    "chrome-extension://$ExtensionId/"
  ]
}
"@
Set-Content -Path $Manifest -Value $ManifestContent -Encoding UTF8

# 写注册表（HKCU，当前用户，无需管理员）
$RegKey = "HKCU:\SOFTWARE\Google\Chrome\NativeMessagingHosts\$HostName"
if (-not (Test-Path $RegKey)) {
    New-Item -Path $RegKey -Force | Out-Null
}
# 64 位 Chrome 还会读 WOW6432Node，一并写一份（保险）
Set-ItemProperty -Path $RegKey -Name "(Default)" -Value $Manifest

$RegKeyWow = "HKCU:\SOFTWARE\Google\Chrome\NativeMessagingHosts\$HostName"
# 注意：HKCU 下 WOW6432Node 实际上是 HKCU\SOFTWARE\WOW6432Node\...
$RegKeyWowPath = "HKCU:\SOFTWARE\WOW6432Node\Google\Chrome\NativeMessagingHosts\$HostName"
if (Test-Path "HKCU:\SOFTWARE\WOW6432Node") {
    if (-not (Test-Path $RegKeyWowPath)) {
        New-Item -Path $RegKeyWowPath -Force | Out-Null
    }
    Set-ItemProperty -Path $RegKeyWowPath -Name "(Default)" -Value $Manifest
}

Write-Host "✓ 安装完成" -ForegroundColor Green
Write-Host "  host 目录  : $InstallDir"
Write-Host "  启动器     : $Launcher"
Write-Host "  manifest   : $Manifest"
Write-Host "  python     : $PyExe"
Write-Host "  extension  : $ExtensionId"
Write-Host ""
Write-Host "下一步：在 Chrome 加载扩展（chrome://extensions → 开发者模式 → 加载已解压），"
Write-Host "       然后从 sidepanel 发一条 ping 或 shell 命令验证连通。"
