# hindsight-zcode-local

Durable, time-aware memory for **ZCode** via [Hindsight](https://github.com/vectorize-io/hindsight), reusing the **exact same banks** as the `pi` coding agent.

This is the ZCode counterpart to [`hindsight-pi-local`](https://github.com/buihongduc132/hindsight-pi-local). Both read the same `~/.hindsight/config.json` and resolve **identical bank IDs**, so any fact `pi` retained is recallable from ZCode and vice-versa.

## What it provides

A ZCode plugin that bundles:

1. **MCP tools** (exposed to the ZCode agent):
   - `hindsight_search` — recall (raw durable-memory hits)
   - `hindsight_context` — reflect (synthesized answer across memories)
   - `hindsight_retain` — store a durable fact
   - `hindsight_banks` — list connected banks with fact counts / top tags / entities

2. **Slash commands**: `/hindsight-search`, `/hindsight-context`, `/hindsight-retain`, `/hindsight-banks`

3. **Skill**: `hindsight-usage` — query strategy + budgets + memory-type guidance

## How banks are shared with pi

Bank ID resolution mirrors `hindsight-pi-local`'s `deriveBankId` **exactly**, with the same precedence:

1. `mappings[cwd]` (explicit map in config)
2. `.hindsight.json` `bankId` (walking up parent dirs)
3. `config.bankId` (explicit override)
4. strategy: `global` / `pi-session` / `per-directory` / `per-repo` (default)

Config precedence (highest first):

1. environment variables (`HINDSIGHT_*`)
2. project `.hindsight/config.json` (walking parents)
3. project `.hindsight/config.toml` (walking parents)
4. global `~/.hindsight/config.json`
5. global `~/.hindsight/config.toml`

ZCode-specific overrides may live under `host.pi.zcode` in the config file, layered on top of the shared `host.pi` defaults.

## Install

Add the plugin dir to ZCode's plugin `dirs` in `~/.zcode/cli/config.json`:

```json
{
  "plugins": {
    "dirs": [
      "/home/bhd/Documents/Projects/bhd/hindsight-zcode-local"
    ]
  }
}
```

ZCode discovers `.zcode-plugin/plugin.json`, launches the MCP server on demand (`node src/mcp-server.js`), and registers the tools/commands/skills.

## Run the server directly

```bash
node src/mcp-server.js
# speaks MCP stdio JSON-RPC
```

## Test

```bash
node --test test/*.test.js   # unit tests (no server needed)
node scripts/smoke.js         # end-to-end against a live Hindsight server
```

## Configuration

Everything is driven by `~/.hindsight/config.json` (shared with pi). Minimal example:

```json
{
  "baseUrl": "http://localhost:24300",
  "apiKey": "sk-...",
  "bankStrategy": "per-repo",
  "recallTypes": ["observation", "experience"]
}
```

## Architecture

```
src/
  mcp-server.js   # zero-dependency MCP stdio JSON-RPC server (the plugin entrypoint)
  client.js       # Hindsight HTTP API client (recall/reflect/retain/banks/tags/entities)
  config.js       # config resolution (mirrors pi's extensions/config.ts)
  bank.js         # bank ID derivation (mirrors pi's extensions/session.ts)
  git.js          # git helper for repo/branch derivation
  format.js       # output formatting (mirrors pi's message-format.ts)
  types.d.ts      # shared type declarations (JSDoc aid)
```

Zero runtime dependencies — plain Node stdlib, so it runs on the system Node without `npm install`. The MCP protocol (JSON-RPC 2.0 over stdio) is implemented from spec rather than via `@modelcontextprotocol/sdk`, matching the transport ZCode uses.

## License

MIT
