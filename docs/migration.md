# 迁移说明

## 项目位置

旧工作目录可保留为历史副本；所有新的 MCP 与 Harness 配置应指向：

```text
D:\projects\computer-use-plus
```

不要复制 `.data`、浏览器 profile、截图、媒体文件或任何 key 文件到仓库。新的数据目录会由服务自动创建。

## MCP 客户端

普通 MCP 客户端继续使用点号工具名，例如 `computer.state`、`computer.invoke` 和 `shortcut.run`。将其 command/cwd 更新为项目根目录：

```json
{
  "mcpServers": {
    "computer-use-plus": {
      "command": "node",
      "args": ["src/index.js"],
      "cwd": "D:/projects/computer-use-plus"
    }
  }
}
```

旧的 `computer.act` 保持兼容；新工作流优先使用 `shortcut.run`、`computer.invoke`、`computer.state`、`computer.inspect`、`computer.verify` 和 `computer.cancel`。

## DeepSeek Harness

Harness 使用下划线工具名，因为官方 bridge 将 MCP 工具注册为
`mcp__computer_use_plus__<rawName>`。把
`adapters/deepseek-harness/cordis.yml` 作为 `--patch` 传入，不需要复制或修改服务源码。它公开的 six-tool profile 是：

- `shortcut_run`
- `computer_invoke`
- `computer_state`
- `computer_inspect`
- `computer_verify`
- `computer_cancel`

安装官方 bridge 并验证：

```powershell
npx @deepseek-ai/dsh plugin --profile headless add @deepseek-ai/dsh-mcp-client
$env:COMPUTER_USE_PLUS_ROOT='D:\projects\computer-use-plus'
npx @deepseek-ai/dsh --profile headless --patch D:\projects\computer-use-plus\adapters\deepseek-harness\cordis.yml --dump-config
```

## 可选 AI 与实例 benchmark

不要迁移或扫描旧 key。可选 AI 仅通过 `agent.md` 中的环境变量或用户明确指定的 key 文件配置。

Edge 使用项目内独立 profile；Minecraft、微信、QQ 必须分别提供独立实例的命令和窗口进程名。不要把当前前台或已登录实例作为 benchmark 目标。
