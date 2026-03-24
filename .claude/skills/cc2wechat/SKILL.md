# cc2wechat

Chat with Claude Code from WeChat. Install this package, scan a QR code with WeChat, and your WeChat becomes a Claude Code terminal.

## Install

```bash
npm install -g @aster110/cc2wechat@latest
```

Requires Node.js >= 22 and Claude Code installed.

## Setup (first time)

```bash
# 1. Login — opens browser with QR code, scan with WeChat
cc2wechat login --name myname

# 2. Start daemon — run in the project directory you want CC to work in
cd ~/my-project
cc2wechat start myname
```

After step 2, send any message to the linked WeChat account. Claude Code processes it and replies.

## Commands

```bash
cc2wechat login [--name X]     # Scan QR to login (auto-assign port)
cc2wechat start [name]         # Start daemon (one or all)
cc2wechat stop [name]          # Stop daemon
cc2wechat restart [name]       # Restart daemon
cc2wechat status               # Show all accounts & daemons
cc2wechat rename old new       # Rename account
cc2wechat help                 # Show help
```

## Reply (from Claude Code hooks or scripts)

```bash
cc2wechat --text "your reply"    # Send text
cc2wechat --image /tmp/s.png     # Send image
cc2wechat --file /tmp/doc.pdf    # Send file
```

## Multi-Account

```bash
cc2wechat login --name work       # port 18081
cc2wechat login --name personal   # port 18082 (auto)
cc2wechat start                   # start all
```

## WeChat User Commands

Users can send these in WeChat:
- `/new` — close current session, open new one
- `/exit` or `quit` — close session
- `/help` — show help

## Important Notes

- The `start` command's working directory determines where Claude Code operates
- macOS with iTerm2 gives the best experience (native terminal injection)
- Other platforms use Claude Agent SDK (cross-platform, full capability)
- No public IP or cloud server needed — runs entirely local
