# computer-use-plus 配置向导

这是可选配置，不配置 API key 也可以使用 Windows 专用执行桌面、UIA、OCR、批量动作和本地记忆。

## 可选 AI

快速 AI 只负责当前任务的动作规划和执行，不会自动写入长期 shortcut。整理 AI 使用同一套 API key，只在低频整理或主 AI 明确调用整理接口时使用。

主 AI 在首次需要远程 AI 时，应先询问用户是否愿意配置。推荐让用户自行创建一个只包含 key 的文本文件，然后把文件路径交给本地进程配置；不要要求用户把 key 直接粘贴到对话中。

PowerShell 示例：

```powershell
$env:COMPUTER_USE_PLUS_AI_KEY_FILE='C:\path\to\provider-key.txt'
$env:COMPUTER_USE_PLUS_AI_BASE_URL='https://api.openai.com/v1'
$env:COMPUTER_USE_PLUS_AI_MODEL='gpt-4o-mini'
```

也可以直接使用环境变量：

```powershell
$env:COMPUTER_USE_PLUS_AI_API_KEY='your-api-key'
```

`COMPUTER_USE_PLUS_FAST_*` 变量仍兼容，但新配置优先使用不区分用途的 `COMPUTER_USE_PLUS_AI_*` 变量。API key 只在进程内存中使用，不写入 `.data`、日志、MCP 响应或状态输出。

### 隔离 provider worker（可选）

如果希望把 provider 网络请求和 key 解析放到独立进程，可设置：

```powershell
$env:COMPUTER_USE_PLUS_PROVIDER_WORKER='1'
```

worker 会读取同一 data 目录中的 provider 配置，并在每次配置 revision 变化后重新加载。父进程只发送目标、快照和参数，不发送 key；worker 的错误只以稳定错误码返回。worker 不可用时不要关闭本地能力，调用方应继续使用 UIA、CDP、OCR、shortcut 或返回 `needs_reasoning`。

## 用户拒绝时

用户不愿创建文件、提供路径或配置 key 时，必须允许跳过。不要重复索要，也不要因为缺少 key 阻止本地功能；此时快速 AI 和 AI 整理保持关闭，继续使用本地规则。

## 整理策略

本地脚本负责窗口作用域隔离、特征匹配、聚类、TTL、容量上限和回收区。AI 整理只处理本地规则无法确定的候选，并且不应在每次动作后调用。建议按候选数量、变更次数或空闲周期触发。`organize` 默认只返回 AI proposal；只有主 AI 明确传入 `applyAi: true`，或传入人工审核后的 `apply` 操作，才会修改长期记忆。

## Native tool-call

快速 AI 优先使用协议级 tool call。模型可以调用 `computer.invoke` 或 `shortcut.run`，不需要输出 Markdown 或普通文本 JSON。provider 层支持 OpenAI-compatible、Responses、Anthropic 和 Gemini 的工具调用格式，统一转换为本地 `tool_call` 事件；服务端负责参数限制、窗口作用域、风险确认和实际执行。

高风险动作第一次调用会返回一次性 `confirm_token`；用户确认后将该 token 原样传回。token 绑定具体窗口和动作，120 秒后过期，不能复用。

不要让配置向导自动扫描磁盘寻找 API key，也不要读取 `C:\重要的资料\身份认证和各种key\deepseek.txt`。请用户自行创建只包含 key 的文件并配置 `COMPUTER_USE_PLUS_AI_KEY_FILE`；拒绝配置时可跳过，所有本地能力仍可用。
