# computer-use-plus

[![test](https://github.com/Ethanout/computer-use-plus/actions/workflows/test.yml/badge.svg)](https://github.com/Ethanout/computer-use-plus/actions/workflows/test.yml)

低 token、低延迟的 Windows computer-use MCP 服务。服务按“预测记忆 -> Windows UIA/Win32 或浏览器 CDP Accessibility Tree -> 本地坐标 OCR -> 严格结构化视觉”逐级选择识别方式，在本地完成语义定位、输入执行、动作批处理、验证和记忆更新。

## 环境

- Windows 10/11
- Node.js 20 或更高版本
- PowerShell 5.1（系统自带即可）

当前运行时不依赖 npm 第三方包，也不要求安装 .NET SDK。首次创建专用桌面时，PowerShell 5.1 会用系统自带 C# 编译器生成约十几 KB 的本地代理，并按源码哈希缓存在数据目录。

## 启动

在项目目录执行：

```powershell
npm start
```

服务使用 MCP JSON-RPC stdio，每行接收一个 JSON 请求并输出一行 JSON 响应。MCP 客户端配置示例：

```json
{
  "mcpServers": {
    "computer-use-plus": {
      "command": "node",
      "args": ["D:/projects/computer-use-plus/src/index.js"]
    }
  }
}
```

本地记忆、隔离代理和运行日志默认写入项目下的 `.data/`，可通过 `COMPUTER_USE_PLUS_DATA_DIR` 指定目录。Windows 默认启用 `backgroundOnly`：`computer.state`、`computer.inspect` 和 `computer.act` 都只操作专用执行桌面。仅调试旧的前台模式时可设置 `COMPUTER_USE_PLUS_EXECUTION_MODE=foregroundAllowed`。

## Optional Streamable HTTP runtime

stdio remains the default. To share one engine, model worker, and memory across MCP hosts, start the HTTP endpoint with an explicit token:

```powershell
$env:COMPUTER_USE_PLUS_HTTP_PORT='8765'
$env:COMPUTER_USE_PLUS_HTTP_TOKEN='replace-with-a-local-token'
$env:COMPUTER_USE_PLUS_TOOL_PROFILE='fast-agent'
node src/index.js
```

Use `POST http://127.0.0.1:8765/mcp` with `Authorization: Bearer <token>`. The runtime returns `MCP-Session-Id` and keeps task/runtime state per session. Multiple connection profiles can be configured with `COMPUTER_USE_PLUS_HTTP_CONNECTIONS` as a JSON array of `{token, profile, allowedWindows}` objects. The unauthenticated `/health` endpoint only returns liveness and session count; it never returns tokens, provider data, or user input.

## 当前工具

- `agent.run`：默认高层入口。提交 `goal`、窗口/窗口作用域和时间、动作、节点预算，本地 Agent 连续选择 shortcut、UIA/OCR/视觉或可选快速 AI，只返回紧凑结果。
- `agent.status` / `agent.cancel` / `agent.capabilities`：查询异步任务、取消后续动作和读取非敏感能力。结果不包含截图、完整 UI 树、底层动作数组或 API key。
- `computer.state`：窗口、焦点、能力、记忆统计、运行指标和专用执行桌面状态；`includeUi: true` 时返回一次可直接操作的紧凑 UI 快照、短期 `ref` 和最近状态转换。
- `computer.inspect`：按窗口和文本/角色查询 UIA 元素；UIA 找不到目标时可对隔离窗口执行 `PrintWindow` 截图并交给本地 OCR，截图只在 `.data` 中短暂存在。
- `computer.wait`：按窗口标题/进程/类名或元素文本/角色等待出现或消失，减少跨应用流程中的固定延迟。
- `computer.screenshot`：默认只返回最多 20 个窗口的边界元数据；传 `mode: "image"` 才返回短期 base64 图像。`coordinateGrid: true` 会在图片内边缘绘制窗口相对坐标标尺，并返回屏幕原点与刻度，便于精确定位。
- `computer.act`：批量执行 `click`、`setValue`、`hotkey`、`keys` 和 `wait`。
- `computer.fast`：可选的低延迟 AI 只规划并执行当前动作，不写长期记忆。
- `computer.shortcut`：由主 AI 显式保存、列出、运行或整理命名动作链；支持单窗口和独立的跨窗口作用域。
- `computer.execution`：创建、启动应用、查看状态或销毁 Windows 专用执行桌面；`diagnose` 会只读返回该 desktop 的窗口、启动根进程和 Job Object 内存活进程。该桌面不会被切换到用户前台。
- `computer.browser`：使用项目 `.data` 下的独立浏览器 profile，通过 CDP 页面目标、Accessibility Tree 和 DOM 边界操作公开页面；支持 `launch`、`list`、`inspect`、`click`、`setValue`、`keys`、受限 `permission` 和 `stop`，不会连接用户现有浏览器 profile。profile 与下载目录必须位于项目 data 目录；站点权限只接受明确的 http(s) origin 和 `granted`/`denied`/`prompt` 设置。

只向外部 Agent 暴露最低 token 工具面时设置：

```powershell
$env:COMPUTER_USE_PLUS_TOOL_PROFILE='fast-agent'
node src/index.js
```

`intervention-agent` pause/intervention example:

```powershell
$env:COMPUTER_USE_PLUS_TOOL_PROFILE='intervention-agent'
$env:COMPUTER_USE_PLUS_AGENT_ALLOWED_WINDOWS='[{"process":"qq"}]'
node src/index.js
```

Set `pauseBeforeActions: true` on `agent.run`, then use the latest `revision` with `agent.internal`. Supported operations are `inspect`, `pause`, `resume`, `replace-action`, `skip-action`, `cancel`, `select-window`, and `audit`. Replacement actions are revalidated against the action schema and risk policy; audit responses contain only redacted metadata. The current stdio allowlist is service-scoped; connection tokens and true per-connection isolation remain part of the persistent HTTP runtime.

该 profile 只注册四个 `agent.*` 高层工具。确实需要内部干预的独立连接可改用 `intervention-agent`，额外注册 `agent.internal`；它当前支持读取任务、按 revision 取消任务，以及从任务已经返回的歧义窗口候选中选择一个继续执行。默认 profile 和 `fast-agent` 均不注册该接口，未注册工具也无法通过隐藏调用绕过。

高层调用示例：

```json
{"goal":"打开 QQ 联系人","windowScope":{"process":"QQ"},"budget":{"maxSeconds":3,"maxActions":8,"maxNodes":30}}
```

多个窗口同时匹配时返回 `needs_reasoning: "window_ambiguous"` 和紧凑候选，不会猜测窗口。高风险动作继续返回原有一次性确认令牌；取消只能立即阻止尚未开始的动作，已经进入单个系统驱动调用的动作会在该调用返回后停止后续步骤。

QQ 等 WebView/自绘控件可能没有 `InvokePattern`；UIA 找到目标但调用模式不受支持时，执行层会自动回退到目标边界坐标点击，并在结果中报告 `win32.click.invoke-fallback`。

服务端在每次 `computer.act` 后自动更新底层 UI 定位记忆，模型不能直接改写定位器和状态转换统计；主 AI 可以通过 `computer.shortcut` 显式管理可复用动作链。
后台维护达到候选、变更量或空闲阈值且配置了整理 AI 时，会自动生成待审 proposal；它不会自动 merge、rename、archive 或删除 shortcut。待审数量通过 `computer.state.memory.organization.pendingProposals` 可见，主 AI 或用户仍需显式应用。
`computer.state.metrics` 只负责累计动作策略、OCR 次数与耗时、截图次数和实际图像字节数，用于成本/延迟评估；直接截图和 OCR/结构化视觉产生的内部临时 PNG 都按实际文件字节计量。它不是动作链本体。供模型一次规划完整链路的数据来自 `computer.state.snapshot`、最近 `transitions` 和已保存的 `computer.shortcut`。
缓存定位器失效时，服务会自动降权并先用原始 UIA 查询重新发现，只有 UIA 失败才进入 OCR，OCR 无法消歧且视觉 provider 已配置时才进入结构化视觉；代理启动时还会清理过期临时截图、旧日志和旧版本代理二进制。

## 一次规划与 Shortcut

先获取一次 action-ready 快照：

```json
{"window":"123","includeUi":true,"maxNodes":30,"includeTransitions":true}
```

模型随后可以用快照中的 `ref` 一次提交完整动作链：

```json
{"window":"123","actions":[{"click":{"ref":"s1n1"}},{"wait":{"seconds":0.3}},{"click":{"ref":"s1n2"}}]}
```

高层等待统一使用秒并允许小数，`0.3` 表示 300 毫秒。只有精确键盘时间轴 `kbops.at` 保留毫秒；执行层会把秒换算为整数毫秒。

`computer.fast` 可显式传 `"stream": true`。服务会持续读取模型响应，并在首个 native tool call 的参数成为完整 JSON 时立即送入原有执行和高风险确认链，不等待模型流结束；同一规划响应只执行第一个工具调用。默认不启用，便于兼容不支持流式 tool call 的 provider。

主 AI 可以显式保存模板化 shortcut，后续复用不需要再次调用 AI。可选 AI 配置和用户拒绝时的跳过流程见 [agent.md](D:/projects/computer-use-plus/agent.md)。快速 AI 与整理 AI 使用同一个 API key，不配置也不影响本地功能：

```powershell
$env:COMPUTER_USE_PLUS_AI_KEY_FILE='C:\path\to\provider-key.txt'
$env:COMPUTER_USE_PLUS_AI_BASE_URL='https://api.openai.com/v1'
$env:COMPUTER_USE_PLUS_AI_MODEL='gpt-4o-mini'
```

```json
{"action":"save","scope":"single","window":"123","name":"切换资源包","params":{"name":"objmc","mywait":0.3},"actions":[{"wait":{"seconds":"{{mywait}}"}}]}
{"action":"run","window":"123","name":"切换资源包","params":{"name":"objmc","mywait":0.3}}
```

跨窗口动作使用窗口别名和独立的有序窗口路径，不会与单窗口记忆竞争：

```json
{"action":"save","scope":"cross","name":"下载并打开","windows":{"browser":"123","explorer":"456"},"actions":[{"window":"browser","click":{"text":"Download"}},{"window":"explorer","click":{"text":"Open"}}]}
```

## DeepSeek Harness 与 Benchmark

DeepSeek Harness overlay、安装和真实 Host 验证见 [adapter 文档](adapters/deepseek-harness/README.md)。配置好 Harness profile 后可运行 `npm run verify:harness`，严格核对六个低 token MCP 工具是否被发现。

Edge、Minecraft、微信、QQ 独立实例的 benchmark 配置见 [benchmark 文档](docs/benchmarks/README.md)。所有 suite 默认 dry-run，真实启动必须显式传 `--execute`；Minecraft、微信和 QQ 还要求用户指定独立实例命令，绝不自动附着当前前台实例。旧配置迁移见 [migration.md](docs/migration.md)。

`organize` 默认只返回本地脚本无法确定的候选；明确传入 `useAi:true` 才调用共享 API key 的整理 AI，但默认只返回 proposal，不会修改长期记忆。主 AI 可以通过 `apply` 明确执行 `merge`、`rename` 或 `archive`；也可以在请求 AI 整理时同时传入 `applyAi:true`，明确应用 AI proposal。状态中的 `memory.organization.due` 仅表示达到低频整理阈值，不会自动在每次操作后调用 AI。

## 开发验证

```powershell
npm test
```

`npm test` 包含专用执行桌面的真实 Windows 集成测试，适合有交互桌面的本机。GitHub-hosted Windows runner 不具备可捕获的隔离 desktop，因此 CI 运行 `npm run test:ci`：覆盖全部单元测试、FFmpeg 本地媒体流程、MCP stdio 协议和 Harness 工具档；专用桌面端到端验收仍在真实 Windows 桌面环境执行。

无 Windows UIA 环境时可用模拟驱动验证协议和动作事务：

```powershell
$env:CUP_MOCK='1'
npm start
```

## 已知范围

视觉 provider 通过可选 API key 启用；它只接收受限局部截图，并且必须返回布局 schema，不能直接返回动作。预测快照保存节点摘要、环境兼容条件和验证统计，不保存长期截图。隔离模式禁止全局物理坐标输入，代理会拒绝不属于专用 desktop 的 HWND；优先使用 UIA Pattern，原生 HWND 控件降级为窗口消息，OCR/视觉坐标点击也转换为隔离窗口消息。`wait.state` 暂时会明确返回不支持，避免将未经验证的延迟误报为成功。

## 专用执行桌面

专用桌面会在第一次状态查询或动作时自动创建，也可以显式创建后启动应用：

```json
{"action":"create"}
{"action":"launch","commandLine":"notepad.exe"}
```

专用桌面中的 agent 通过命名管道受主服务管理，不调用 `SwitchDesktop`，因此不会抢占用户正在使用的桌面。窗口枚举、UIA 检查、点击、ValuePattern 输入和键盘序列都由该 agent 执行；启动的进程会在恢复运行前加入带 `KILL_ON_JOB_CLOSE` 的 Windows Job Object，销毁或异常退出时由内核回收整个进程树。

紧凑键盘动作示例：

```json
{"window":"12345","actions":[{"kbseq":["w","a","a","s"]}]}
{"window":"12345","actions":[{"kbops":[{"op":"w","at":0},{"op":"a","at":1000},{"op":"s","at":2000},{"op":"d","at":3000}]}]}
```

`kbops.at` 是相对本批动作起点的绝对毫秒值，服务端会转换为相邻按键间延迟，模型不需要重复计算等待动作。

## Native tool-call 快速路径

快速 AI 优先返回协议级工具调用，而不是可见的长文本 JSON。MCP 客户端也可以直接调用 `computer.invoke` 或 `shortcut.run`：

```json
{"window":"123","shortcut_id":"switch_resource_pack","params":{"name":"objmc","wait_seconds":5}}
```

服务端会在本地校验参数、解析 shortcut、执行 UIA/CDP/OCR 路径，并只返回增量结果。旧的 `computer.act` 和 JSON actions 仍然兼容。

支持 OpenAI-compatible chat completions、Responses、Anthropic Messages 和 Gemini function calling。provider 不会直接执行电脑动作，所有动作都经过本地窗口、权限和风险校验。

需要时可把 provider 调用放到独立 Node worker，避免远程 key 和 provider 网络错误进入 MCP 主进程。worker 只从配置文件内部解析 key，父进程 IPC 只传任务参数；未配置 profile 时本地 UIA、OCR、shortcut 和 MCP 仍可用：

```powershell
$env:COMPUTER_USE_PLUS_PROVIDER_WORKER='1'
npm start
```

worker 也可通过 `new ComputerEngine({ providerWorker: true })` 启用。它支持 ready 握手、协议版本校验、请求超时、崩溃限次重启和关闭时 pending 请求回收。状态只返回 provider 的公开元数据（model、protocol、是否已配置），不会回显 key 或 key 文件路径。

可选组件 manifest 也可以声明受管理的本地 worker：`runtime.entrypoint` 必须是组件版本目录内的相对路径，启动、请求和停止通过 intervention-only 的 `agent.components` 完成。激活新版本或卸载前会先停止旧 worker；没有 runtime 声明的模型组件不会被隐式执行。

本地 action-ID 路由支持注入可选分类器。确定性的名称、ID 和别名匹配始终优先；只有未命中时才调用分类器。分类器只能从当前窗口作用域已有 shortcut 中返回一个 ID，默认置信度阈值为 `0.85`，未知 ID 或低置信度结果会被拒绝并回退到快速 AI/常规观察。`computer.state.metrics` 会记录 `classifierCalls`、`classifierHits` 和 `classifierLatencyMs`。

## Benchmark

```powershell
npm run benchmark -- .data/benchmark-samples.json .data/benchmark-summary.json
```

样本支持 `application`、`strategy`、`success`、`latencyMs`、token、MCP 往返、截图次数/字节和失败原因，输出 P50/P95、成功率、分应用统计和累计成本。

## 真实应用 Benchmark Suite

`docs/benchmarks/` 内置 Edge、Minecraft、微信的声明式 smoke suite。默认只做 `dry-run`：校验 Windows 平台、独立应用启动命令和步骤结构，不启动应用，也不会操作用户前台桌面。

```powershell
npm run benchmark:suite -- docs/benchmarks/edge.json
```

在已配置独立应用启动命令后，才可显式执行（会创建专用执行桌面，并且执行 suite 中的操作）：

```powershell
npm run benchmark:suite -- docs/benchmarks/edge.json --execute --output .data/edge-benchmark.json
```

基准可使用顶层 `setup`/`teardown`：前者只启动一次且不计入任务延迟，后者无论任务结果都会执行。这使浏览器冷启动与稳态 UIA/CDP/OCR 路径的 P50/P95 分开，避免把启动时间当作单步定位延迟。

`npm run benchmark:windows` 会在专用桌面启动仓库自建 WinForms fixture，测量实际 UIA、已命中 shortcut 和预热 OCR 路径。2026-08-14 本机结果为 UIA P95 17.23 ms、shortcut P95 67.88 ms、OCR P95 441.16 ms，均不使用模型 token；它不读取或操作用户当前窗口。

真实执行需要将 runner 接入 MCP 客户端，并显式提供独立实例启动配置。使用以下环境变量作为前置条件，而不是复用用户现有实例：

- `COMPUTER_USE_PLUS_BROWSER_EXECUTABLE`
- `COMPUTER_USE_PLUS_MINECRAFT_COMMAND`
- `COMPUTER_USE_PLUS_WECHAT_COMMAND`
- `COMPUTER_USE_PLUS_QQ_COMMAND`

## 验证与风险策略

`computer.verify` 支持窗口指纹、标题、元素状态、CDP URL 与允许目录内文件的断言。每项结果包含 `expected`、`actual`、`passed`。

高风险动作默认需要一次性确认令牌。可通过 `COMPUTER_USE_PLUS_RISK_POLICY_FILE` 指向 JSON 策略文件；示例见 [risk-policy.example.json](docs/risk-policy.example.json)。策略可按进程和窗口标题匹配并给出 `allow`、`confirm` 或 `deny`，跨窗口 shortcut 以整条动作链生成确认摘要。

## DeepSeek Harness

DeepSeek Harness 可通过官方 `@deepseek-ai/dsh-mcp-client` 直接连接本服务。Harness 当前要求 Node.js `^22.19.0` 或 `>=24`。先为目标 profile 安装 bridge 依赖，再把 [adapters/deepseek-harness/cordis.yml](D:/projects/computer-use-plus/adapters/deepseek-harness/cordis.yml) 作为 `--patch` 传入；它是可直接加载的 `insert` overlay。项目不位于默认位置时设置 `COMPUTER_USE_PLUS_ROOT`。

适配档只公开六个高层、下划线命名的工具，避免 Harness 对点号工具名进行哈希化：`shortcut_run`、`computer_invoke`、`computer_state`、`computer_inspect`、`computer_verify`、`computer_cancel`。完整配置和调用原则见 [adapter README](D:/projects/computer-use-plus/adapters/deepseek-harness/README.md)。
