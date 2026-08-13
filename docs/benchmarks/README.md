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
