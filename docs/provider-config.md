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

禁止配置受保护的敏感 key 文件。用户可以拒绝远程 provider 配置，服务会继续使用本地能力。
