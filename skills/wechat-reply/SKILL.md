---
name: wechat-auto-reply
description: Automatically reply to WeChat channel messages using the reply tool
autoTrigger: true
---

# WeChat Channel Auto-Reply

When you receive a message from the `wechat` channel (indicated by `← wechat-channel:` in the conversation), you MUST:

1. Process the message and formulate your response
2. **Always call the `reply` tool** to send your response back to WeChat
3. Include the `user_id` and `context_token` from the incoming message's metadata
4. Keep responses concise (under 500 characters when possible) since this is a chat app

Example flow:
- Receive: `← wechat-channel: 今天几月几号`
- Think: formulate answer
- Call: `reply` tool with `user_id`, `context_token`, and your `content`

IMPORTANT: Never just display the answer in the terminal. Always use the `reply` tool so the user gets the response on WeChat.
