# wechat-cc-channel

WeChat channel plugin for Claude Code. Bridges WeChat messages (via iLink Bot API) into your local Claude Code session.

## Architecture

```
WeChat user sends message
    |
    v
iLink Bot API (ilinkai.weixin.qq.com)
    |  long-poll /ilink/bot/getupdates
    v
wechat-cc-channel (MCP server, stdio)
    |  server.notification('notifications/claude/channel')
    v
Claude Code session processes the message
    |  Claude calls the reply tool
    v
MCP server -> /ilink/bot/sendmessage -> WeChat user
```

## Quick Start

```bash
# Install dependencies
npm install

# Build
npm run build

# Run with Claude Code (development mode)
claude --dangerously-load-development-channels server:wechat-channel
```

## First-time Setup

1. Start Claude Code with the channel loaded
2. Claude will see "No saved account" — ask it to run the `login` tool
3. Scan the QR code with WeChat
4. Done! Messages will flow in automatically

## Tools

| Tool | Description |
|------|-------------|
| `login` | Scan QR code to connect WeChat account |
| `reply` | Reply to a WeChat message (auto-strips markdown, auto-chunks long text) |

## Storage

Credentials stored in `~/.claude/channels/wechat-channel/`:
- `accounts.json` — saved account tokens
- `sync-buf-{accountId}.txt` — long-poll cursor (resume position)

## Key Details

- Messages longer than 3900 chars are automatically chunked
- Markdown is stripped to plain text for WeChat
- Typing indicators are sent while processing
- Session expiry (errcode -14) triggers automatic pause and retry
- All logs go to stderr (won't interfere with MCP stdio)

## License

MIT
