import type http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';

import { loginWithQR, loginWithQRWeb } from '../../auth.js';
import { getActiveAccount, saveAccount, type AccountData } from '../../store.js';
import { log, logError } from '../../utils.js';
import { loadConfig, type AppConfig } from '../../v5/core/config.js';

import { selectAgent } from '../agents/select.js';
import { isHttpAttachable } from '../claude-app/gateway-bus.js';
import type { AgentAdapter } from '../contracts.js';
import { startV6HealthServer } from '../health.js';
import { TurnRingBuffer } from '../poller.js';
import { InMemoryScheduler } from '../scheduler.js';
import { FileSessionStore } from '../session-store.js';

import { ChannelCore } from './core.js';
import { ConversationService } from './conversation-service.js';
import type { ChannelAdapter } from './contracts.js';
import { WeChatChannel, WECHAT_CHANNEL_NAME, type WeChatChannelOptions } from './wechat-channel.js';
import { WebChannel, WEB_CHANNEL_NAME } from './web-channel.js';

/**
 * adapter 模式的接线。
 *
 * **双开关渐进**:`CC2WECHAT_CHANNEL_CORE=adapter` 才走这里,缺省/其他值一律
 * 回 legacy(main.ts 里那条一字未动的老路)。真机回归绿了才谈翻默认。
 *
 * 一条硬约束:**只有真要挂微信通道时才去碰账号**。web-only 侧车跑在
 * 没有 ~/.cc2wechat、没有微信账号的机器上,那里不该冒出一个扫码二维码。
 */

const DRAIN_TIMEOUT_MS = 10_000;
const KNOWN_CHANNELS = new Set([WECHAT_CHANNEL_NAME, WEB_CHANNEL_NAME]);

/** 只有 'adapter' 这一个值开新路 —— 拼错、'1'、'true' 一律留在 legacy */
export function channelCoreEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.CC2WECHAT_CHANNEL_CORE ?? '').trim().toLowerCase() === 'adapter';
}

/** 逗号表选通道,缺省只挂微信(与现网形态一致) */
export function selectedChannels(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = (env.CC2WECHAT_CHANNELS ?? '').trim();
  if (!raw) return [WECHAT_CHANNEL_NAME];

  const out: string[] = [];
  for (const part of raw.split(',')) {
    const name = part.trim().toLowerCase();
    if (!name || out.includes(name)) continue;
    if (!KNOWN_CHANNELS.has(name)) {
      // 不认识就丢掉并告警 —— 静默当成微信会让人以为配置生效了
      logError(`[channels] 不认识的通道 "${name}",已跳过(可用:${[...KNOWN_CHANNELS].join(', ')})`);
      continue;
    }
    out.push(name);
  }
  return out;
}

export interface ChannelCoreHandle {
  /** 实际监听的端口(传 0 时由系统分配) */
  port: number;
  core: ChannelCore;
  conversations: ConversationService;
  channels: ChannelAdapter[];
  healthServer: http.Server;
  stop(): Promise<void>;
}

export interface BootstrapOptions {
  env?: NodeJS.ProcessEnv;
  port: number;
  /** 数据目录的家,缺省 os.homedir();测试注入 */
  home?: string;
  cwd?: string;
  config?: AppConfig;
  /** 测试注入;缺省按 env/config 选后端 */
  agent?: AgentAdapter;
  /** 测试注入;缺省"读账号文件,没有就扫码登录" */
  loadAccount?: (port: number) => Promise<AccountData>;
  /** 透给 WeChatChannel 的额外选项(测试注入 syncBuf 之类) */
  wechat?: Partial<WeChatChannelOptions>;
  startedAt?: string;
}

/**
 * 拿到可用账号:有存的就用,没有就走扫码登录。
 * legacy main.ts 与 adapter bootstrap 共用这一份 —— 登录逻辑只许有一处。
 */
export async function ensureAccount(port: number): Promise<AccountData> {
  const existing = getActiveAccount(port);
  if (existing) return existing;

  console.log('  No saved credentials. Starting login...');
  const isHeadless = !process.env.DISPLAY && !process.env.BROWSER && process.platform !== 'darwin';
  const result = isHeadless ? await loginWithQR() : await loginWithQRWeb();
  saveAccount({
    accountId: result.accountId.replace(/@/g, '-').replace(/\./g, '-'),
    token: result.token,
    baseUrl: result.baseUrl,
    savedAt: new Date().toISOString(),
    port,
  });
  return getActiveAccount(port)!;
}

export async function bootstrapChannelCore(opts: BootstrapOptions): Promise<ChannelCoreHandle> {
  const env = opts.env ?? process.env;
  const names = selectedChannels(env);
  const wantWeChat = names.includes(WECHAT_CHANNEL_NAME);

  // 账号只在真要挂微信时才碰:web-only 侧车所在的机器可能压根没有 ~/.cc2wechat
  const loadAccount = opts.loadAccount ?? ensureAccount;
  const account = wantWeChat ? await loadAccount(opts.port) : null;

  const config = opts.config ?? loadConfig();
  const cwd = opts.cwd ?? config.cwd ?? process.cwd();
  // 没有微信账号时会话表按端口命名,别硬编一个假 accountId
  const accountId = account?.accountId ?? `local-${opts.port}`;

  const agent = opts.agent ?? selectAgent(env, config, { accountId });
  const store = new FileSessionStore({
    accountId,
    legacyPort: String(opts.port),
    ...(opts.home ? { dir: path.join(opts.home, '.cc2wechat') } : {}),
  });
  const scheduler = new InMemoryScheduler({
    onError: (err) => logError(`scheduler task failed: ${err instanceof Error ? err.message : String(err)}`),
  });
  const turns = new TurnRingBuffer(20);
  const conversations = new ConversationService({ wechatAccountId: account?.accountId });

  let core: ChannelCore | null = null;
  const healthServer = startV6HealthServer(opts.port, {
    account,
    agent,
    scheduler,
    turns,
    cwd,
    startedAt: opts.startedAt ?? new Date().toISOString(),
    channels: () => core?.channelHealth() ?? [],
  });
  if (!healthServer.listening) await once(healthServer, 'listening');
  const port = (healthServer.address() as { port: number } | null)?.port ?? opts.port;

  // 鸭子类型:哪个后端想挂 HTTP 就自己实现 attachHttp,bootstrap 不必认识具体是谁
  if (isHttpAttachable(agent)) {
    agent.attachHttp(healthServer);
    log(`claude-app 网关总线已挂上:GET http://127.0.0.1:${port}/claude-app/events`);
  }

  const channels: ChannelAdapter[] = [];
  for (const name of names) {
    if (name === WECHAT_CHANNEL_NAME) {
      channels.push(
        new WeChatChannel({
          account: account!,
          home: opts.home,
          reply: config.reply,
          ...opts.wechat,
        }),
      );
    } else if (name === WEB_CHANNEL_NAME) {
      const web = new WebChannel({ home: opts.home, env });
      web.attach(healthServer);
      channels.push(web);
    }
  }

  core = new ChannelCore({ channels, agent, scheduler, store, conversations, turns, cwd });
  await core.start();
  log(`Channel Core(adapter 模式)已启动:${names.join(', ') || '(没有可用通道)'}`);

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await core!.stop();
    healthServer.close();
    try {
      await Promise.race([scheduler.drain(), new Promise((r) => setTimeout(r, DRAIN_TIMEOUT_MS))]);
    } catch (err) {
      logError(`drain failed: ${String(err)}`);
    }
    try {
      await agent.shutdown();
    } catch (err) {
      logError(`agent shutdown failed: ${String(err)}`);
    }
  };

  return { port, core, conversations, channels, healthServer, stop };
}
