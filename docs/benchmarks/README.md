# 独立应用 Benchmark

这些 suite 只会在 Windows 专用执行桌面内启动配置的独立实例，不会附着到用户当前的 QQ、微信、Minecraft 或浏览器窗口。默认 dry-run；只有显式传入 `--execute` 才会启动应用。

## Edge

```powershell
node scripts/run-benchmark-suite.js docs/benchmarks/edge.json --execute
```

该测试使用项目 `.data` 下独立 Edge profile 和 CDP，不使用用户现有 profile。

## Minecraft 与微信

这两个应用的安装形态、登录状态和窗口进程名不稳定，因此必须由测试者显式提供独立实例的启动命令和预期窗口进程名。不要指向正在使用的实例。

```powershell
$env:COMPUTER_USE_PLUS_MINECRAFT_COMMAND = '"D:\\isolated\\Minecraft\\launcher.exe" --workDir "D:\\isolated\\Minecraft"'
$env:COMPUTER_USE_PLUS_MINECRAFT_WINDOW_PROCESS = 'javaw'
node scripts/run-benchmark-suite.js docs/benchmarks/minecraft.json --execute

$env:COMPUTER_USE_PLUS_WECHAT_COMMAND = '"D:\\isolated\\WeChat\\WeChat.exe"'
$env:COMPUTER_USE_PLUS_WECHAT_WINDOW_PROCESS = 'WeChat'
node scripts/run-benchmark-suite.js docs/benchmarks/wechat.json --execute
```

一个成功运行会依次创建专用桌面、通过 Job Object 启动实例、等待目标窗口、读取一次紧凑 UI 快照，并对执行桌面进行诊断。完成后 runner 会销毁桌面并回收启动的进程树。

结果样本会用任务前后的引擎指标差值记录实际 `screenshots`、`screenshotBytes`、`ocrCalls`、`ocrLatencyMs`、模型 token、classifier、shortcut、动作数和动作路由。直接调用 CDP 管理接口的任务以任务级 `strategy: "cdp"` 统计，不会虚构为动作路由计数。

常见 UWP、商店版或启动器场景可能需要把命令包装为实际可执行的启动器命令；只要命令在专用桌面中能创建目标窗口即可。窗口进程名不含 `.exe`，大小写不敏感。

## 模型 Provider

复制并修改 `providers.example.json`，通过 `apiKeyEnv` 引用环境变量，不把 key 写入配置：

```powershell
$env:COMPUTER_USE_PLUS_BENCHMARK_API_KEY='...'
node scripts/benchmark-providers.js docs/benchmarks/providers.example.json --output .data/provider-benchmark.json
```

脚本对同一紧凑 UI 快照测试 native tool call 的标准与流式模式，输出成功率、端到端 P50/P95、首个完整 tool call 的 dispatch P50/P95、token 和按配置单价估算的费用。未配置 key 的 provider 会明确标记为跳过。受保护的 DeepSeek key 文件路径会被硬性拒绝。
