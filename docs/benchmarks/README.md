# 独立应用 Benchmark

这些 suite 只会在 Windows 专用执行桌面内启动配置的独立实例，不会附着到用户当前的 QQ、微信、Minecraft 或浏览器窗口。默认 dry-run；只有显式传入 `--execute` 才会启动应用。

## Edge

```powershell
node scripts/run-benchmark-suite.js docs/benchmarks/edge.json --execute
```

该测试使用项目 `.data` 下独立 Edge profile 和 CDP，不使用用户现有 profile。

## Minecraft、微信与 QQ

这两个应用的安装形态、登录状态和窗口进程名不稳定，因此必须由测试者显式提供独立实例的启动命令和预期窗口进程名。不要指向正在使用的实例。

```powershell
$env:COMPUTER_USE_PLUS_MINECRAFT_COMMAND = '"D:\\isolated\\Minecraft\\launcher.exe" --workDir "D:\\isolated\\Minecraft"'
$env:COMPUTER_USE_PLUS_MINECRAFT_WINDOW_PROCESS = 'javaw'
node scripts/run-benchmark-suite.js docs/benchmarks/minecraft.json --execute

$env:COMPUTER_USE_PLUS_WECHAT_COMMAND = '"D:\\isolated\\WeChat\\WeChat.exe"'
$env:COMPUTER_USE_PLUS_WECHAT_WINDOW_PROCESS = 'WeChat'
node scripts/run-benchmark-suite.js docs/benchmarks/wechat.json --execute

$env:COMPUTER_USE_PLUS_QQ_COMMAND = '"D:\\isolated\\QQ\\QQ.exe"'
$env:COMPUTER_USE_PLUS_QQ_WINDOW_PROCESS = 'QQ'
node scripts/run-benchmark-suite.js docs/benchmarks/qq.json --execute
```

一个成功运行会依次创建专用桌面、通过 Job Object 启动实例、等待目标窗口、读取一次紧凑 UI 快照，并对执行桌面进行诊断。完成后 runner 会销毁桌面并回收启动的进程树。

suite 可选 `setup` 和 `teardown`。`setup` 在计时任务前只运行一次，`teardown` 总会在任务结束后运行；两者不会混入每个任务的 P50/P95。`edge.json` 用此结构将浏览器冷启动与 10 次稳态 CDP 读取分开。2026-08-14 在该机器的专用执行桌面实测稳态 list + inspect：10/10 成功，P50 4 ms、P95 18 ms、0 token、0 截图、0 OCR。

结果样本会用任务前后的引擎指标差值记录实际 `screenshots`、`screenshotBytes`、`ocrCalls`、`ocrLatencyMs`、模型 token、classifier、shortcut、动作数和动作路由。无论 capture 是直接截图、OCR 还是结构化视觉的内部临时 PNG，均会计入真实字节数；直接调用 CDP 管理接口的任务以任务级 `strategy: "cdp"` 统计，不会虚构为动作路由计数。

Windows 本地路由的可重复性能验收使用自建 WinForms fixture，不读取或操作用户窗口：

```powershell
npm run benchmark:windows
```

它分别报告 UIA inspect、已命中 shortcut 和预热后 OCR 的成功率、P50/P95，并在结束时销毁专用执行桌面。

2026-08-14 本机实际结果：UIA inspect 20/20，P95 17.23 ms；已命中 shortcut 20/20，P95 67.88 ms；预热 OCR 5/5，P95 441.16 ms。三条路径均未调用模型，且 shortcut 的每个 UIA/Win32 动作结果是即时验证。该 fixture 基准用于回归与容量判断，不代表所有自绘应用的性能保证。

常见 UWP、商店版或启动器场景可能需要把命令包装为实际可执行的启动器命令；只要命令在专用桌面中能创建目标窗口即可。窗口进程名不含 `.exe`，大小写不敏感。

## 模型 Provider

## 多设备/多模式矩阵

矩阵 runner 将办公集显、游戏本和无 GPU VM 等 profile 统一跑过同一组 suite，默认只校验结构，不启动应用：

```powershell
npm run benchmark:matrix -- docs/benchmarks/matrix.example.json
npm run benchmark:matrix -- docs/benchmarks/matrix.example.json --execute --output .data/device-matrix.json
```

`--execute` 必须在每个 profile 已准备独立应用实例、专用桌面和必要模型后使用。结果按 profile 保存真实成功率、P50/P95、MCP 往返、token、截图字节、OCR、shortcut、恢复和失败原因；runner 不读取 API key 文件，也不会自动附着用户当前窗口。

## 长稳 smoke

对无副作用任务可以运行有界重复测试。runner 只允许 `computer.state` 和 `computer.inspect`，每次运行结束回收 Engine，并记录失败数、平均延迟、P50/P95、RSS/heap 增长和活动句柄数量。它不会自动模拟 24 小时；需要由测试者选择 `durationMs` 或 `iterations`，并在独立实例环境运行。可选的 `maxHeapGrowthBytes` 和 `maxActiveHandleGrowth` 会使超限运行返回失败：

```powershell
npm run benchmark:stability -- docs/benchmarks/stability.example.json --output .data/stability.json
```

默认示例为 1,000 次 `computer.state`，没有动作、点击、输入或消息发送能力。

复制并修改 `providers.example.json`，通过 `apiKeyEnv` 引用环境变量，不把 key 写入配置：

```powershell
$env:COMPUTER_USE_PLUS_BENCHMARK_API_KEY='...'
node scripts/benchmark-providers.js docs/benchmarks/providers.example.json --output .data/provider-benchmark.json
```

脚本对同一紧凑 UI 快照测试 native tool call 的标准与流式模式，输出成功率、端到端 P50/P95、首个完整 tool call 的 dispatch P50/P95、token 和按配置单价估算的费用。未配置 key 的 provider 会明确标记为跳过。受保护的 DeepSeek key 文件路径会被硬性拒绝。
