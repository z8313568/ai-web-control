# 工具调用协议（webctl）

这是 AI 网页输出与扩展之间的约定。AI 在普通回复中嵌入特定格式的代码块，
扩展的 content script 解析这些块并执行，全程不需要 AI 网页配合。

## 格式

工具调用是 AI 回复里的 fenced code block，语言标记为 `webctl`：

````markdown
我来帮你打开计算器：

```webctl
{"id":"t1","action":"shell","cmd":"open -a Calculator"}
```

已为你执行上面的命令。
````

## 解析规则

- content script 用正则 `/```webctl\s*\n([\s\S]*?)```/g` 匹配所有块；
- 每块是一个 JSON 对象；
- `id` 可选（不提供则自动生成），用于把执行结果反馈给对应的调用；
- `action` 必填，必须在支持列表内；
- 格式错误的块**不会**让解析中断，而是作为错误项反馈到 UI 气泡，方便调试 AI 输出。

## 支持的 action

### `shell` — 执行命令/脚本

```json
{"action":"shell","cmd":"ls -la ~/Desktop","timeout":30,"cwd":"/tmp"}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `cmd` | string \| string[] | 命令。字符串默认走 shell（支持管道、变量）；数组走 exec 模式（更安全） |
| `timeout` | number | 可选，秒，默认 30 |
| `cwd` | string | 可选，工作目录 |
| `shell` | bool | 可选，默认 true。设 false 则按参数拆分执行 |

返回：`{returncode, stdout, stderr, dangerous, danger_match}`

### `file_read` — 读文件

```json
{"action":"file_read","path":"~/Documents/note.txt"}
```

返回：`{path, size, truncated, content}`（最多读前 200KB）

### `file_write` — 写文件

```json
{"action":"file_write","path":"~/Documents/note.txt","content":"hello","append":false}
```

| 字段 | 说明 |
|---|---|
| `path` | 目标路径，`~` 会展开到家目录 |
| `content` | 要写入的文本（UTF-8） |
| `append` | 可选，true 则追加，默认 false 覆盖 |

返回：`{path, bytes, append}`

### `file_list` — 列目录

```json
{"action":"file_list","path":"~/Documents"}
```

返回：`{path, entries:[{name, size, is_dir, mtime}, ...]}`

### `browse` — 浏览器自动化（不经 host，走扩展 chrome.tabs）

```json
{"action":"browse","op":"open","url":"https://example.com","active":true}
{"action":"browse","op":"screenshot","format":"jpeg","quality":80}
```

| op | 说明 |
|---|---|
| `open` | 新标签页打开 url |
| `screenshot` | 截当前激活标签页，返回 data URL |

返回：
- `open`: `{tabId, url}`
- `screenshot`: `{tabId, dataUrl}`

### `notify` — 仅提示（不执行任何操作）

```json
{"action":"notify","message":"任务已完成"}
```

用于 AI 向用户传达状态，不调用任何能力。

## 安全

- **完整 Shell 权限**：按设计 `shell` action 可执行任意命令（用户需求）。
- **危险关键字告警**：命中 `rm -rf /`、`mkfs`、`dd if=`、`shutdown` 等模式时，
  结果会带 `dangerous: true` 和 `danger_match` 字段，UI 气泡变橙色警告，
  但**不阻断**执行。
- **全量审计**：所有 action 调用（含参数摘要、dangerous 标记）写入
  host 端 `audit-YYYYMMDD.jsonl`。
- **总开关**：侧边栏可一键停用扩展（停用后所有 exec 请求被拒）。
- **速率限制**：单来源每秒最多 5 条 exec 请求，防止 AI 失控刷命令。

## 与 AI 的配合（提示词）

让 AI 按本协议输出，需要在对话里注入一段系统提示词
（见 `prompts/deepseek-system-prompt.md`）。AI 不需要支持 function calling，
只要能按格式输出 markdown 代码块即可——因此适用于任意大模型网页。
