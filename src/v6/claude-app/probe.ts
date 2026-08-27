import fs from 'node:fs';

import type { CcRegistry } from './cc-registry.js';
import type { InboxRegistry } from './inbox-registry.js';

/**
 * 开机自检探针。
 *
 * 为什么非要有:ccd 工具 / 深链 / 注册表 / socket 全是 app 内部实现,**无兼容承诺**
 * (预研 §6)。哪天换个版本悄悄改了格式,通道会变成"消息发出去石沉大海"——
 * 那是最糟的失败形态。探针的职责是把"坏了"变成一句人能看懂的话,
 * 让通道该降级降级、该喊人喊人,而不是哑死。
 *
 * 判定口径:
 * - **ok=false** 只给"这条路真的断了"(注册表读不到 / 网关不在线 / 一个收件箱都没有)
 * - **warn** 给"能跑但要盯着"(版本漂移 / 播了没敲首条)
 */

/** 已实测通过的 app 内置引擎版本。漂移不判死,只 warn。 */
export const VERIFIED_APP_VERSIONS = ['2.1.246'];

export interface ProbeCheck {
  name: string;
  ok: boolean;
  warn?: boolean;
  detail: string;
}

export interface ProbeReport {
  ok: boolean;
  checks: ProbeCheck[];
  at: number;
}

export interface ProbeDeps {
  registry: CcRegistry;
  inboxes: InboxRegistry;
  /** GET /claude-app/status 的返回;null = daemon 没跑 / 打不通 */
  busStats: Record<string, unknown> | null;
  verifiedVersions?: string[];
  now?: () => number;
}

export function runProbe(deps: ProbeDeps): ProbeReport {
  const now = deps.now ?? (() => Date.now());
  const checks: ProbeCheck[] = [];

  // 1. 引擎注册表 —— cwd → CLI id 的唯一活映射
  let engines: ReturnType<CcRegistry['listEngines']> | null = null;
  try {
    engines = deps.registry.listEngines();
  } catch {
    engines = null;
  }
  if (engines === null || !dirReadable(deps.registry)) {
    checks.push({
      name: '引擎注册表',
      ok: false,
      detail: `读不到 ${deps.registry.sessionsDir} —— 回程定位不了 transcript,claude-app 后端不可用`,
    });
  } else {
    checks.push({
      name: '引擎注册表',
      ok: true,
      detail: `${deps.registry.sessionsDir}:${engines.length} 个活引擎(0 个也正常,空闲 900s 会被放倒)`,
    });
  }

  // 2. app 版本指纹
  const verified = deps.verifiedVersions ?? VERIFIED_APP_VERSIONS;
  const versions = deps.registry.appVersions();
  if (versions.length === 0) {
    checks.push({
      name: 'app 版本',
      ok: true,
      warn: true,
      detail: `${deps.registry.appVersionsDir} 下一个版本目录都没有 —— app 可能没装,或者路径变了`,
    });
  } else {
    const drift = versions.filter((v) => !verified.includes(v));
    checks.push({
      name: 'app 版本',
      ok: true,
      warn: drift.length > 0,
      detail:
        drift.length > 0
          ? `装了 ${versions.join(', ')};已验证过的只有 ${verified.join(', ')} —— 新版本 ${drift.join(', ')} 的 ccd/深链/注册表行为未复验`
          : `${versions.join(', ')}(在已验证清单里)`,
    });
  }

  // 3. 网关 SSE
  const stats = deps.busStats;
  if (!stats) {
    checks.push({
      name: '网关连接',
      ok: false,
      detail: '拿不到总线状态 —— daemon 没在跑,或者 /claude-app/status 打不通',
    });
  } else if (stats.connected === true) {
    checks.push({ name: '网关连接', ok: true, detail: `在线,${String(stats.connections ?? 1)} 条 SSE 连接` });
  } else {
    checks.push({
      name: '网关连接',
      ok: false,
      detail: '网关会话不在线 —— 去 app 里重挂值班(话术见 docs/claude-app/GATEWAY.md)',
    });
  }

  // 4. 最近一次注入回执延迟
  const lastAckMs = typeof stats?.lastAckMs === 'number' ? (stats.lastAckMs as number) : -1;
  checks.push({
    name: '注入回执',
    ok: true,
    detail: lastAckMs >= 0 ? `上次 ${lastAckMs}ms` : '还没注入过(无数据)',
  });

  // 5. 收件箱台账
  const inboxes = deps.inboxes.list();
  if (inboxes.length === 0) {
    checks.push({
      name: '收件箱台账',
      ok: false,
      detail: '一个都没播种:cc2wechat claude-app seed --name <名字>',
    });
  } else {
    const unresolved = inboxes.filter((i) => i.localId == null).map((i) => i.name);
    const bound = inboxes.filter((i) => i.conversationId != null).length;
    checks.push({
      name: '收件箱台账',
      ok: true,
      warn: unresolved.length > 0,
      detail:
        unresolved.length > 0
          ? `${inboxes.length} 个(${bound} 个已绑微信会话);还没敲首条的:${unresolved.join(', ')}`
          : `${inboxes.length} 个(${bound} 个已绑微信会话),localId 全部已解析`,
    });
  }

  return { ok: checks.every((c) => c.ok), checks, at: now() };
}

/**
 * listEngines() 对"目录不存在"是静默返回 [] 的(那是给热路径用的容错),
 * 探针要的是相反的东西:分清"目录在但没引擎"(正常)和"目录压根读不到"(断了)。
 */
function dirReadable(registry: CcRegistry): boolean {
  try {
    return fs.statSync(registry.sessionsDir).isDirectory();
  } catch {
    return false;
  }
}

export function formatProbe(r: ProbeReport): string {
  const lines: string[] = [''];
  for (const c of r.checks) {
    const icon = !c.ok ? '❌' : c.warn ? '⚠️ ' : '✅';
    lines.push(`  ${icon} ${c.name}: ${c.detail}`);
  }
  lines.push('');
  return lines.join('\n');
}
