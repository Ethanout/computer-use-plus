# DeepSeek Harness adapter

This adapter uses the official `@deepseek-ai/dsh-mcp-client` bridge. It starts
the existing MCP stdio server instead of duplicating the computer-use runtime.

## Configure

Copy or include the entry from `cordis.yml` in the Harness composition. If the
project is elsewhere, set:

```powershell
$env:COMPUTER_USE_PLUS_ROOT='D:\projects\computer-use-plus'
```

The adapter enables `COMPUTER_USE_PLUS_TOOL_PROFILE=harness`. Harness therefore
sees six stable, low-token tools:

- `mcp__computer_use_plus__shortcut_run`
- `mcp__computer_use_plus__computer_invoke`
- `mcp__computer_use_plus__computer_state`
- `mcp__computer_use_plus__computer_inspect`
- `mcp__computer_use_plus__computer_verify`
- `mcp__computer_use_plus__computer_cancel`

The profile deliberately hides low-level compatibility and administration
tools. Run shortcuts first, inspect once only when needed, submit actions as one
batch, and verify the final state. A high-risk result returns a single-use
confirmation token; pass it back only after user approval.

No AI key is required by this adapter. Optional fast/organizing AI remains
configured on the computer-use-plus process as documented in `agent.md`.
