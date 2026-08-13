# DeepSeek Harness adapter

This adapter uses the official `@deepseek-ai/dsh-mcp-client` bridge. It starts
the existing MCP stdio server instead of duplicating the computer-use runtime.

## Configure

DeepSeek Harness requires Node.js `^22.19.0` or `>=24`. Install the official
bridge into the profile that will use computer-use-plus:

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

The adapter was verified on 2026-08-14 against DeepSeek Harness `master` and the published
`@deepseek-ai/dsh`/`@deepseek-ai/dsh-mcp-client` `0.1.0-rc.6`, Node 24, and an
actual headless Host turn. The Host discovered all six tools listed below.
Re-run that verification from a configured Harness profile with:

```powershell
$env:COMPUTER_USE_PLUS_DSH_NODE='C:\\path\\to\\node.exe'
$env:COMPUTER_USE_PLUS_DSH_BIN='C:\\path\\to\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'
node D:\projects\computer-use-plus\scripts\verify-deepseek-harness.js
```

The verification command uses the profile's normal model credentials solely to
ask the Host to list tools. It does not configure or read a computer-use-plus
AI key.

The verifier first validates that the overlay loads with `--dump-config`, then runs
a real Host turn which discovers all six tools and calls `computer_state`. It checks
`execution.backgroundOnly: true`, proving tool execution and result projection in
addition to discovery. The overlay sets the upstream bridge's documented reconnect
policy explicitly (500 ms to 30 s, 10 attempts), so an upstream default change cannot
silently change availability behavior.

If the project is elsewhere, set:

```powershell
$env:COMPUTER_USE_PLUS_ROOT='D:\projects\computer-use-plus'
```

The adapter enables `COMPUTER_USE_PLUS_TOOL_PROFILE=harness`. The MCP bridge
registers six stable, low-token names with its `mcp__computer_use_plus__`
namespace. Harness's current tool-presentation layer may show the same names
without that prefix in an agent reply; the six raw names remain:

- `mcp__computer_use_plus__shortcut_run`
- `mcp__computer_use_plus__computer_invoke`
- `mcp__computer_use_plus__computer_state`
- `mcp__computer_use_plus__computer_inspect`
- `mcp__computer_use_plus__computer_verify`
- `mcp__computer_use_plus__computer_cancel`

The internal tool-call router also accepts the six short presentation names
(`computer_state`, `shortcut_run`, and the other four) and canonicalizes them
before applying the normal validation, risk policy, and execution path.

The profile deliberately hides low-level compatibility and administration
tools. Run shortcuts first, inspect once only when needed, submit actions as one
batch, and verify the final state. A high-risk result returns a single-use
confirmation token; pass it back only after user approval.

No AI key is required by this adapter. Optional fast/organizing AI remains
configured on the computer-use-plus process as documented in `agent.md`.
