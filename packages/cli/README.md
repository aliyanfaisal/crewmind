# crewmind

> **Pre-alpha, under active development. Not usable yet.**

Free, encrypted team memory for AI coding assistants. It catches conflicting decisions before they become conflicting code.

GitHub syncs code. Crewmind syncs the _why_: decisions, constraints and in-flight work. It delivers them to whichever AI assistant each teammate uses (Claude Code, Cursor, Windsurf and others) at the moment they start a related task.

- **No server and no account.** Memory is stored inside your own Git repo, in a hidden ref.
- **End-to-end encrypted and signed.** Only your team can read it, not even the Git host.
- **Decision Conflict Radar.** It warns you when your AI is about to contradict a teammate's decision on another branch.

## Status

This version only contains the CLI skeleton (`crewmind --version`, `crewmind status`). Follow development for the first usable release.

Requires Node.js ≥ 22.13.

## License

MIT
