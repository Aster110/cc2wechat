# cc2wechat

Chat with your coding agent from WeChat. Scan a QR code, and your WeChat becomes a terminal for
**Claude Code** (`cc2wechat`) or **Codex** (`cx2wechat`).

## Install

```bash
npm install -g @aster110/cc2wechat@latest
```

Requires Node.js >= 22, plus whichever agent you want to drive:
[Claude Code](https://docs.anthropic.com/en/docs/claude-code) or
[Codex CLI](https://github.com/openai/codex) (`npm i -g @openai/codex`, then `codex login`).

## Quick Start

### 1. Login (scan WeChat QR code)

```bash
cc2wechat login --name myname
```

A browser page opens with a QR code. Scan it with WeChat, confirm on your phone. Done.

### 2. Start the daemon

```bash
# Run this in the project directory you want Claude Code to work in
cd ~/my-project
cc2wechat start myname
```

Now send a message to the linked WeChat account — Claude Code will process it and reply.

### 3. Stop

```bash
cc2wechat stop myname
```

## Driving Codex instead of Claude Code

Same daemon, different backend. Use the `cx2wechat` alias (identical CLI, just defaults to the
codex backend):

```bash
cx2wechat login --name mybox
cd ~/my-project && cx2wechat start mybox
```

Or keep using `cc2wechat` and pick the backend explicitly:

```bash
CC2WECHAT_BACKEND=codex cc2wechat start mybox
```

Notes:

- Codex is driven through `codex exec --json` with
  `--dangerously-bypass-approvals-and-sandbox`, so run it where you accept full-access execution
  (a disposable VM or a machine you own).
- Session continuity uses codex thread ids, mapped from bridge sessions in
  `~/.cc2wechat/codex-threads-<port>.json`. `/new` and `/exit` drop the mapping so the next
  message starts a fresh codex thread.
- Codex reads `AGENTS.md` for context. On a remote box, tell it where it is — otherwise "check my
  machine" gets answered about the wrong machine. A `$CODEX_HOME/AGENTS.md` covering host
  identity, that replies land in WeChat (so keep them short), and that permissions are already
  granted goes a long way.
- Turns are slower than Claude Code (minutes with high reasoning effort). Cap it per channel with
  `CC2WECHAT_CODEX_EFFORT=medium`, which overrides `model_reasoning_effort` without touching your
  `config.toml`.

## Multi-Account

Each account gets its own port, fully isolated:

```bash
cc2wechat login --name work      # port 18081
cc2wechat login --name personal  # port 18082 (auto-assigned)

cc2wechat start                  # start all
cc2wechat stop                   # stop all
cc2wechat status                 # show all
```

## WeChat Commands

Users can send these commands in WeChat:

| Command | Effect |
|---------|--------|
| `/new` | Close current session, open a new one |
| `/exit` or `quit` | Close current session |
| `/help` | Show help |

With the codex backend, `/new` and `/exit` drop the stored thread mapping, so the next message
opens a fresh codex thread.

## CLI Reference

```
cc2wechat login [--name X]     Scan QR to login
cc2wechat start [name]         Start daemon (one or all)
cc2wechat stop [name]          Stop daemon (one or all)
cc2wechat restart [name]       Restart daemon
cc2wechat status               Show all accounts & daemons
cc2wechat rename old new       Rename an account

cc2wechat --text "hello"       Reply to current WeChat context
cc2wechat --image /tmp/s.png   Send image
cc2wechat --file /tmp/f.pdf    Send file

cc2wechat web [name]           Open ttyd Web Terminal in browser
cc2wechat help                 Show help
cc2wechat --version            Show version
```

`cx2wechat` (alias: `codex2wechat`) takes the exact same commands — it only changes the default
backend to codex.

## Configuration

Optional config file at `~/.claude/channels/wechat-channel/config.json`:

```json
{
  "delivery": "auto",
  "backend": "claude-code",
  "port": 18081
}
```

### Environment overrides

Handy when one daemon should differ from the global config (e.g. a codex box alongside your
Claude Code daemons):

| Variable | Effect |
|----------|--------|
| `CC2WECHAT_BACKEND` | `claude-code` (default), `codex` (persistent app-server), `codex-exec` (one-shot spawn escape hatch), or `claude-app` (drive Claude desktop app sessions — see [docs/claude-app/](docs/claude-app/GATEWAY.md)) |
| `CC2WECHAT_DELIVERY` | Same values as `delivery` below |
| `CC2WECHAT_ENGINE` | `v5` / `v6` — force an engine; the ultimate rollback switch |
| `CC2WECHAT_CODEX_EFFORT` | Overrides codex `model_reasoning_effort` for this channel only |
| `CC2WECHAT_PORT` | Which account/port this daemon serves |
| `CODEX_HOME` | Point codex at a separate auth/config dir (multi-account isolation) |
| `CC2WECHAT_TURN_TIMEOUT_MS` / `CC2WECHAT_SESSION_TTL_MS` / `CC2WECHAT_MAX_CONCURRENT` / `CC2WECHAT_QUEUE_CAP` | v6 tunables: per-turn timeout (disabled by default; `0` disables it), idle session TTL (12h), global concurrency (2), per-conversation queue cap (5) |

### Delivery modes

Since v5.2.0 the headless **v6 engine** is the default. `delivery` now mostly decides which engine you get:

| Value | Behavior |
|-------|----------|
| `"auto"` / `"sdk"` / `"pipe"` / unset | v6 engine: headless `Channel → Core → Agent`, persistent sessions, `/stop`, preemptive commands |
| `"tmux"` | v5 legacy engine: tmux session management (requires `tmux`). Auto-starts ttyd Web Terminal for browser access. |
| `"terminal"` | v5 legacy engine: macOS iTerm AppleScript |

Note the behavior change: `"auto"` used to probe iTerm/tmux first; it now always means headless v6. Web-terminal workflows must opt in with `"tmux"` explicitly.

To force tmux delivery on macOS (useful for headless/SSH):

```json
{
  "delivery": "tmux"
}
```

## How It Works

```
WeChat App  -->  iLink Bot API (long-poll)  -->  cc2wechat daemon  -->  Claude Code / Codex
                                                      |                       |
                                                      v                       v
WeChat App  <--  iLink Bot API (send)       <--  Reply via WeChat API   ttyd Web Terminal
                                                                        (tmux delivery only)
```

- **No public IP needed** — the daemon polls out, nothing needs to reach in
- **No cloud server required** — though a server works fine, and is the point when you want a
  remote dev box you can drive from your phone
- **Multi-session** — each WeChat user gets their own agent session; per-user serial queues keep
  ordering without ever blocking the poll loop
- **Auto markdown strip** — Claude's markdown output is cleaned for WeChat plain text
- **Auto chunking** — long messages are split at 3900 chars

## Architecture (v6)

Single-process `Channel → Core → Agent` pipeline (`src/v6/`):

- **Channel**: the WeChat iLink protocol layer (long-poll, media crypto, send)
- **Core**: orchestration — per-conversation serial scheduler with global slots and bounded
  queues, preemptive control commands (`/new` `/stop` `/exit` act immediately, never queued
  behind a long turn), session store (one atomic JSON table: conversation → provider session,
  port-independent, auto-migrates v5 thread maps), typing heartbeat, slow-turn ack, per-turn
  timings exposed at `/health` (loopback only)
- **Agent**: each agent owns its own execution mode behind one interface —
  `run(req, signal): AsyncIterable<AgentEvent>` plus `reset`/`health`/`shutdown`:
  - `codex` — **persistent** `codex app-server` child, multi-session by threadId, disk resume
    after restarts, `turn/interrupt` for `/stop`, auto-degrades to one-shot exec after repeated
    daemon failures (measured: follow-up turns ~13.5s → ~3.3s vs spawn-per-message)
  - `codex-exec` — one-shot `codex exec --json` per turn; replies as soon as the turn completes
    instead of waiting ~3.8s for process teardown
  - `claude-code` — Claude Agent SDK session pool (processes stay warm between messages)

Core only ever sees five standardized `AgentEvent`s — raw codex/Claude protocol shapes never
leak past the agent file, so provider protocol changes stay one-file fixes.

The v5 Delivery×Backend engine is still shipped for the tmux/iTerm web-terminal workflows and as
a rollback path (`CC2WECHAT_ENGINE=v5`).

Message handling is non-blocking: each conversation gets a serial queue, but the long-poll loop
never waits on the agent. This matters for slow backends — blocking the poll loop makes the
platform consider the bot offline. See [docs/codex-backend.md](docs/codex-backend.md) for the
failure modes this cost us to learn.

### `claude-app` backend (V1, experimental)

`CC2WECHAT_BACKEND=claude-app` routes WeChat messages into **Claude desktop app sessions** instead
of spawning a CLI: a single *gateway* session in the app holds an SSE connection to the daemon and
does nothing but `send_message` into per-contact *inbox* sessions; replies are read back by the
daemon straight from the transcript jsonl (zero extra tokens). Inbox sessions are seeded by hand
once — the app has no zero-confirmation "create session" path — and are woken automatically after
that.

- Gateway contract, on-call/re-attach script, failure table: [docs/claude-app/GATEWAY.md](docs/claude-app/GATEWAY.md)
- Seeding an inbox: [docs/claude-app/SEEDING.md](docs/claude-app/SEEDING.md)
- CLI: `cc2wechat claude-app seed --name X`, `cc2wechat claude-app status`

Channel-level failures (gateway offline, no inbox seeded) degrade to the codex backend so WeChat
never goes silent; per-turn failures surface as errors instead of silently switching who answers.

## Web Terminal

When using tmux delivery, cc2wechat can expose Claude Code sessions via [ttyd](https://github.com/tsl0922/ttyd) Web Terminal, allowing you to watch or interact with Claude Code from a browser.

```bash
# Open web terminal for a specific account
cc2wechat web myname
```

The daemon automatically starts a ttyd instance for each tmux session. The URL is shown in `cc2wechat status` output.

**Note**: ttyd 1.7.7+ defaults to read-only mode. The daemon starts ttyd with `-W` flag to enable write access. Install ttyd via `brew install ttyd` (macOS) or your package manager.

## Requirements

- Node.js >= 22
- Claude Code CLI, or Codex CLI (`codex login` done on *that* machine — auth files don't copy
  between machines, see [docs/codex-backend.md](docs/codex-backend.md))
- macOS recommended (iTerm delivery for best experience)
- Linux supported via tmux delivery (install tmux first); on a headless server the SDK delivery
  needs nothing extra
- Falls back to SDK/Pipe delivery if neither iTerm nor tmux available

## License

MIT
