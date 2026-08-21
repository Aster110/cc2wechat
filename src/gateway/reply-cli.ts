#!/usr/bin/env node
/**
 * `waku-dm-reply` —— Agent 在一轮**中途**往 Waku 私聊里发东西的口子。
 *
 *   waku-dm-reply --text "先给你看个东西"
 *   waku-dm-reply --image /tmp/shot.png
 *   waku-dm-reply --card cnt_abc --launch-ctx '{"room":"ABCD"}'
 *   waku-dm-reply --conversation conv_01J… --video /tmp/demo.mp4 --text "跑起来了"
 *
 * 为什么要有它：一轮结束时的 final 只能说一次话。Agent 干活干到一半想「先把这张图发过去」
 * 就得有个中途出口——这正是 cc2wechat 微信版 `cc2wechat-reply` 的位置。
 *
 * **与微信版的关键差别：不猜会话。** 微信版靠「ctx 目录里 mtime 最新的那个文件」当当前会话，
 * 两个人同时聊天时会把 A 的图发给 B。这里只认两种来源：
 *   1. `--conversation`（Agent 的提示词前缀里就有：`[Waku私聊 conv=…]`）
 *   2. daemon 侧「当前唯一正在跑的 turn」——**恰好一条**才算数，0 条或多条一律 400。
 *
 * 传输是回环 HTTP：`POST http://127.0.0.1:<health-port>/admin/reply`，与 `/admin/pair-grant`
 * 同一个只听 127.0.0.1 的运维口。端口发现顺序：`WAKU_GATEWAY_HEALTH_PORT` → state dir 下的
 * `health.port`（daemon 启动时写）→ 缺省 18092。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 只从 dm-paths 取常量：这条 CLI 只发一次 HTTP POST，不该把 bootstrap 整条依赖链
// （sqlite / codex agent / registry）拖进进程。
import { DEFAULT_DM_HEALTH_PORT, DEFAULT_DM_STATE_DIR_NAME, HEALTH_PORT_FILE } from './dm-paths.js';

export interface ReplyCliAttachment {
  kind: 'image' | 'video' | 'audio' | 'card' | 'file';
  path?: string;
  contentId?: string;
  caption?: string;
  launchCtx?: Record<string, string>;
}

export interface ReplyCliRequest {
  conversationId?: string;
  text?: string;
  attachments?: ReplyCliAttachment[];
}

const USAGE = `用法：waku-dm-reply [--conversation <conv_id>] [--text <文本>] [附件…]

  --text <文本>              发一段文字（也可以直接把 [[send-image: …]] 标记写在文本里）
  --image <路径>             发图片（PNG/JPEG/GIF/WEBP）
  --video <路径>             发视频（有 ffmpeg 时自动抽封面、量时长）
  --audio <路径>             发语音（需要 ffprobe 量时长，否则会明确告诉你没发出去）
  --card <cnt_id>            发一张 playable 卡片（内容必须已发布且 visibility=public/friends）
  --launch-ctx <json>        跟在 --card 后面：进入 playable 时带的启动上下文，值必须是字符串
  --caption <文本>           跟在附件后面：这条附件的说明文字
  --conversation <conv_id>   指定会话；不给就用"当前唯一正在跑的那一轮"的会话
                             （会话 id 就在提示词前缀里：[Waku私聊 conv=…]）

同一条命令可以带多个附件，按命令行出现顺序发送。
`;

/** 附件类附加旋钮（--launch-ctx / --caption）作用在**最近一个**附件上。 */
export function parseReplyArgs(argv: readonly string[]): ReplyCliRequest {
  const request: ReplyCliRequest = {};
  const attachments: ReplyCliAttachment[] = [];

  const needValue = (flag: string, value: string | undefined): string => {
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    return value;
  };
  const last = (flag: string): ReplyCliAttachment => {
    const entry = attachments.at(-1);
    if (entry === undefined) throw new Error(`${flag} must follow an attachment flag (--image/--video/--audio/--card)`);
    return entry;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    switch (arg) {
      case '--text':
        request.text = needValue(arg, value);
        index += 1;
        break;
      case '--conversation':
      case '--conv':
        request.conversationId = needValue(arg, value);
        index += 1;
        break;
      case '--image':
      case '--video':
      case '--audio':
      case '--file': {
        const kind = arg.slice(2) as 'image' | 'video' | 'audio' | 'file';
        attachments.push({ kind, path: path.resolve(needValue(arg, value)) });
        index += 1;
        break;
      }
      case '--card':
        attachments.push({ kind: 'card', contentId: needValue(arg, value) });
        index += 1;
        break;
      case '--launch-ctx': {
        const raw = needValue(arg, value);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new Error('--launch-ctx must be a JSON object, e.g. \'{"room":"ABCD"}\'');
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('--launch-ctx must be a JSON object');
        }
        const ctx: Record<string, string> = {};
        for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
          ctx[key] = typeof entry === 'string' ? entry : String(entry);
        }
        last(arg).launchCtx = ctx;
        index += 1;
        break;
      }
      case '--caption':
        last(arg).caption = needValue(arg, value);
        index += 1;
        break;
      case '--help':
      case '-h':
        // 用法不是错误：走 stdout、退出码 0，别让 `--help | less` 看起来像失败。
        process.stdout.write(USAGE);
        process.exit(0);
        break;
      default:
        throw new Error(`unknown flag: ${arg}\n\n${USAGE}`);
    }
  }

  if (attachments.length > 0) request.attachments = attachments;
  if (request.text === undefined && attachments.length === 0) {
    throw new Error(`nothing to send\n\n${USAGE}`);
  }
  return request;
}

/** env → state dir 的 `health.port` → 缺省端口。 */
export function resolveHealthPort(env: NodeJS.ProcessEnv = process.env): number {
  const fromEnv = (env['WAKU_GATEWAY_HEALTH_PORT'] ?? '').trim();
  if (fromEnv.length > 0) {
    const parsed = Number.parseInt(fromEnv, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const stateDir = (env['WAKU_GATEWAY_STATE_DIR'] ?? '').trim() || path.join(os.homedir(), DEFAULT_DM_STATE_DIR_NAME);
  try {
    const parsed = Number.parseInt(fs.readFileSync(path.join(stateDir, HEALTH_PORT_FILE), 'utf8').trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  } catch {
    /* daemon 没跑 / 没写成：退到缺省端口，连不上时的报错已经说清楚了 */
  }
  return DEFAULT_DM_HEALTH_PORT;
}

export async function postReply(port: number, request: ReplyCliRequest, fetchImpl: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const url = `http://127.0.0.1:${port}/admin/reply`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
  } catch {
    throw new Error(`cannot reach the waku-dm daemon at ${url} — is it running? (WAKU_GATEWAY_CHANNEL=waku-dm node dist/gateway/server.js)`);
  }
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text.length === 0 ? null : JSON.parse(text);
  } catch {
    parsed = null;
  }
  const record = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  if (!response.ok) {
    const detail = typeof record['message'] === 'string' ? record['message'] : String(record['error'] ?? `http_${response.status}`);
    throw new Error(`daemon refused the reply: ${detail}`);
  }
  return record;
}

async function main(): Promise<void> {
  const request = parseReplyArgs(process.argv.slice(2));
  const port = resolveHealthPort();
  const result = await postReply(port, request);
  process.stdout.write(
    `sent to ${String(result['conversationId'] ?? '?')} (status=${String(result['status'] ?? '?')}, attachments=${String(result['attachments'] ?? 0)})\n`,
  );
}

// 被 import 当模块用时（单测）不跑 main；也别被同名的微信版 `dist/reply-cli.js` 误触发。
const invokedDirectly = process.argv[1] !== undefined && /gateway[/\\]reply-cli(\.[cm]?[jt]s)?$/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
