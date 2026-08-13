# DeepSeek Harness adapter

This adapter uses the official `@deepseek-ai/dsh-mcp-client` bridge. It starts
the existing MCP stdio server instead of duplicating the computer-use runtime.

## Configure

DeepSeek Harness currently requires Node.js `^22.19.0` or `>=24`. Install the
official bridge into the profile that will use computer-use-plus:

```powershell
npx @deepseek-ai/dsh plugin --profile headless add @deepseek-ai/dsh-mcp-client
```

The bridge package currently has no `dsh.bundle`, so installing it adds the
dependency but does not create a plugin entry. This `cordis.yml` is a valid
top-level `insert` overlay and can be passed directly to DSH:

```powershell
npx @deepseek-ai/dsh --profile headless --patch D:\projects\computer-use-plus\adapters\deepseek-harness\cordis.yml "list available computer-use tools"
```

To preserve it across runs, merge its single `insert` patch into the profile's
`$DSH_HOME/profiles/<name>/cordis.patch.yml` without overwriting other patches.

Validate composition loading without an API key:

```powershell
npx @deepseek-ai/dsh --profile headless --patch D:\projects\computer-use-plus\adapters\deepseek-harness\cordis.yml --dump-config
```

The adapter overlay was parsed successfully against `@deepseek-ai/dsh` and
`@deepseek-ai/dsh-mcp-client` `0.1.0-rc.6`. On 2026-08-13, a full headless Host
startup through `npx` was blocked before MCP discovery by missing dependencies
inside the upstream preview install (`typebox`, OpenTelemetry exporter base,
and Domino). This is an upstream Harness packaging issue, not a
computer-use-plus MCP initialization failure. Use Node.js 22.19+ or 24+, install
the profile dependencies with pnpm, and re-run the command as Harness releases
are updated.

If the project is elsewhere, set:

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
