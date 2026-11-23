# Crewmind

Free, encrypted team memory for AI coding assistants. It catches conflicting decisions before they become conflicting code.

> **Status:** early development (milestone M1 of 8). Not usable yet.

GitHub syncs code. Crewmind syncs the _why_: decisions, constraints and in-flight work. It delivers them to whichever AI assistant each teammate uses (Claude Code, Cursor, Windsurf and others) at the moment they start a related task. Memory is stored encrypted inside your own Git repo, so there's no server and no account.

## Repository layout

| Path            | What                                                                                  |
| --------------- | ------------------------------------------------------------------------------------- |
| `packages/core` | `@crewmind/core`: schemas, canonical JSON, IDs (later crypto, ranking, scanner). MIT. |
| `packages/cli`  | `crewmind`: the CLI and MCP server. MIT.                                              |

## Development

Requires Node ≥ 22.13 and pnpm (via corepack: `corepack enable pnpm`).

```sh
pnpm install
pnpm check      # lint + typecheck + tests + build
pnpm test:watch
node packages/cli/dist/index.js --help
```
