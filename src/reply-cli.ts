#!/usr/bin/env node
// CC calls this from Bash: cc2wechat-reply --image /path/to/file
// Or: cc2wechat-reply --text "hello"

import fs from 'node:fs';
import { sendMessage, uploadAndSendMedia } from './wechat-api.js';

const args = process.argv.slice(2);
const contextPath = '/tmp/cc2wechat-context.json';

if (!fs.existsSync(contextPath)) {
  console.error('No active WeChat context. cc2wechat must be running.');
  process.exit(1);
}

const ctx = JSON.parse(fs.readFileSync(contextPath, 'utf-8')) as {
  token: string;
  baseUrl?: string;
  userId: string;
  contextToken: string;
};

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
