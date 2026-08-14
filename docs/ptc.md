<<<<<<< HEAD
# 受限 PTC 与脚本

`computer.ptc` 仅在 `intervention-agent` profile 注册。它适合把多个已注册的本地工具调用组合成一次执行，减少外部 Agent 的往返：
=======
# 受限 PTC

`computer.ptc` 只在 `intervention-agent` profile 注册，适合把多个本地工具调用组合成一次执行，减少外部 Agent 往返：
>>>>>>> origin/main

```js
const state = await tools.call('computer_state', {});
if (state.windows.length === 1) {
<<<<<<< HEAD
  return await tools.call('computer_invoke', {
    window: state.windows[0].id,
    actions: [{ kbseq: ['ESC'] }]
  });
=======
  return await tools.call('computer_invoke', { window: state.windows[0][0], actions: [{ kbseq: ['ESC'] }] });
>>>>>>> origin/main
}
return { needs_reasoning: 'window_ambiguous' };
```

<<<<<<< HEAD
PTC 使用 Node `vm` 沙盒，只能调用注册工具；代码、步骤、运行时间和输出字节数均有上限。它不能访问 `process`、`require`、文件系统或任意网络，也不会自动写入长期 shortcut。

## 临时脚本

同一个高级 profile 还提供 `computer.script`，用于短期 JavaScript、Windows PowerShell，或在用户明确安装 Python 后运行 Python。每次任务使用 `.data/scripts/<task-id>` 工作区，默认结束时删除；传入 `keepWorkspace: true` 才保留以便诊断。

能力必须显式声明：

- `window-control`：调用受注册的 `computer.state`、`computer.inspect`、`computer.invoke`、`shortcut.run`、`computer.verify`、`computer.wait` 和 `computer.cancel`。
- `filesystem`：只允许读写当前任务工作区，禁止通过 `..` 逃逸。
- `process`：允许启动受限 PowerShell/Python 子进程；必须同时声明 `filesystem`，并先完成一次性风险确认。
- `network`：作为显式高风险能力保留；默认拒绝，不能通过脚本绕过统一确认链。

所有脚本都有超时、输出上限、代码大小、步骤/进程限制。子进程使用最小化环境，不传入 API key；超时或输出超限时立即终止并返回结构化错误。默认 MCP profile 不暴露脚本工具，以保持低 token 工具面。
=======
代码在 Node `vm` 沙盒中运行，只能通过 `tools.call` 使用已注册工具。步骤、运行时间、代码大小和结果字节数均有限制；风险确认仍由 Engine 统一处理。PTC 不自动写入长期 shortcut，用户或主 AI 需要显式保存。
>>>>>>> origin/main
