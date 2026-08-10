#!/usr/bin/env node
// CC calls this from Bash: cc2wechat-reply --image /path/to/file
// Or: cc2wechat-reply --text "hello"

import fs from 'node:fs';
import { sendMessage, uploadAndSendMedia } from './wechat-api.js';
import { resolveReplyContext } from './v6/reply-context.js';

const args = process.argv.slice(2);

// v6 起 ctx 只存路由(~/.cc2wechat/ctx/,0700)，token 现查 accounts-<port>.json；
// /tmp 的老格式在 v5 并存期继续兜底。
const resolved = resolveReplyContext();

if (!resolved) {
  console.error('No active WeChat context. cc2wechat daemon must be running.');
  process.exit(1);
}

const ctx = resolved!;

async function main(): Promise<void> {
  if (args[0] === '--image' || args[0] === '--file') {
    const filePath = args[1];
    if (!filePath || !fs.existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      process.exit(1);
    }
    await uploadAndSendMedia({
      token: ctx.token,
      toUser: ctx.userId,
      contextToken: ctx.contextToken,
      filePath,
      baseUrl: ctx.baseUrl,
    });
    console.log(`Sent: ${filePath}`);
  } else if (args[0] === '--text') {
    const text = args.slice(1).join(' ');
    await sendMessage(ctx.token, ctx.userId, text, ctx.contextToken, ctx.baseUrl);
    console.log(`Sent: ${text.slice(0, 50)}...`);
  } else {
    console.log('Usage: cc2wechat-reply --image <path> | --text <message>');
  }
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
