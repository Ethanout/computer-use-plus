# 受限 PTC

`computer.ptc` 只在 `intervention-agent` profile 注册，适合把多个本地工具调用组合成一次执行，减少外部 Agent 往返：

```js
const state = await tools.call('computer_state', {});
if (state.windows.length === 1) {
  return await tools.call('computer_invoke', { window: state.windows[0][0], actions: [{ kbseq: ['ESC'] }] });
}
return { needs_reasoning: 'window_ambiguous' };
```

代码在 Node `vm` 沙盒中运行，只能通过 `tools.call` 使用已注册工具。步骤、运行时间、代码大小和结果字节数均有限制；风险确认仍由 Engine 统一处理。PTC 不自动写入长期 shortcut，用户或主 AI 需要显式保存。
