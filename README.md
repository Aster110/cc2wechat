# cc2wechat

Chat with Claude Code from WeChat. Scan a QR code, and your WeChat becomes a Claude Code terminal.

## Install

```bash
npm install -g @aster110/cc2wechat@latest
```

Requires Node.js >= 22 and [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed.

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

## Configuration

Optional config file at `~/.claude/channels/wechat-channel/config.json`:

```json
{
  "delivery": "auto",
  "backend": "claude-code",
  "port": 18081
}
```

### Delivery modes

| Value | Behavior |
|-------|----------|
| `"auto"` | Auto-detect: iTerm (macOS) > tmux > SDK > Pipe |
| `"terminal"` | Force macOS iTerm AppleScript |
| `"tmux"` | Force tmux session management (requires `tmux` installed). Auto-starts ttyd Web Terminal for browser access. |
| `"sdk"` | Force Claude Agent SDK |
| `"pipe"` | Force CLI stdin/stdout pipe |

To force tmux delivery on macOS (useful for headless/SSH):

```json
{
  "delivery": "tmux"
}
```

## How It Works

```
WeChat App  -->  iLink Bot API (long-poll)  -->  cc2wechat daemon  -->  Claude Code (tmux)
                                                      |                       |
                                                      v                       v
WeChat App  <--  iLink Bot API (send)       <--  Reply via WeChat API   ttyd Web Terminal
                                                                        (browser access)
```

- **No public IP needed** — runs entirely on your local machine
- **No cloud server** — WeChat messages are polled directly from iLink API
- **Multi-session** — each WeChat user gets their own Claude Code session (iTerm on macOS, tmux on Linux)
- **Auto markdown strip** — Claude's markdown output is cleaned for WeChat plain text
- **Auto chunking** — long messages are split at 3900 chars

## Architecture (v5)

Delivery x Backend decoupled architecture:

- **Delivery**: how to send messages to Claude Code
  - Terminal (macOS iTerm AppleScript injection)
  - Tmux (Linux/macOS tmux session management)
  - SDK (Claude Agent SDK, cross-platform)
  - Pipe (CLI stdin/stdout)
- **Backend**: which AI to use (Claude Code, extensible)
- **Router**: zero if/else at runtime, everything resolved at boot

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
- Claude Code CLI installed
- macOS recommended (iTerm delivery for best experience)
- Linux supported via tmux delivery (install tmux first)
- Falls back to SDK/Pipe delivery if neither iTerm nor tmux available

## License

MIT
