# Provider 配置

Provider 配置保存在数据目录的 `providers.json`，只保存环境变量名或密钥文件路径引用，不保存 API key 内容。未配置 provider 时，本地 shortcut、UIA、CDP、OCR 和规则路由仍可使用。

CLI：

```powershell
npm run provider -- list
npm run provider -- set fast --base-url https://api.openai.com/v1 --model gpt-4o-mini --protocol openai --api-key-env OPENAI_API_KEY
npm run provider -- activate fast
npm run provider -- test fast
npm run provider -- remove fast
```

`test` 是唯一会主动发起远程请求的命令，必须由用户显式执行。管理 API 位于认证后的 `POST /admin/providers`，通过 revision 防止并发覆盖；响应和 `list` 均不会返回 key、环境变量名或密钥文件路径。

常驻 Engine 会按配置 revision 热重载激活 profile；管理 API 写入后立即重载，CLI 或其他进程写入则由轮询发现。注入测试 client 时不会被自动替换。`computer.state.metrics` 记录模型调用次数、输入/输出 token、按 profile 价格计算的估算 USD 成本和重载次数。

禁止配置受保护的敏感 key 文件。用户可以拒绝远程 provider 配置，服务会继续使用本地能力。

## 可选模型 Worker

HTTP runtime 默认不启动额外进程。需要隔离模型进程时设置：

```powershell
$env:COMPUTER_USE_PLUS_WORKER_COMMAND = 'C:\path\to\worker.exe'
$env:COMPUTER_USE_PLUS_WORKER_ARGS = '["--stdio"]'
$env:COMPUTER_USE_PLUS_WORKER_PROTOCOL = '1'
$env:COMPUTER_USE_PLUS_WORKER_MAX_RESTARTS = '3'
```

Worker 必须通过 Node IPC 发送 `{type:"ready",protocolVersion:"1"}` 握手；崩溃重启受时间窗口和次数限制，版本不匹配会拒绝启动。健康检查只返回运行状态、PID、版本和重启计数。
