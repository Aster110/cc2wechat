import { planAlerts, formatLocal } from './alerts.js';
import { findExpiryIssues } from './expiry.js';
import { probeDaemon } from './probe.js';
import type {
  ExpiryEntry,
  Notifier,
  ProbeResult,
  RunSummary,
  WatchdogConfig,
  WatchdogDaemonConfig,
  WatchdogState,
} from './types.js';

export interface RunDeps {
  config: WatchdogConfig;
  /** 时钟注入：状态机的一切时间判断走这里，测试不用 sleep */
  now?: () => Date;
  probe?: (d: WatchdogDaemonConfig) => Promise<ProbeResult>;
  readExpiry?: () => ExpiryEntry[];
  state: { load(): WatchdogState; save(s: WatchdogState): void };
  notifier: Notifier;
  log?: (line: string) => void;
  /** true = 只算不发也不落状态，给演练/首次安装看效果用 */
  dryRun?: boolean;
}

/**
 * 跑一次。cron 每 2 分钟拉起来一次，跑完就退——不常驻。
 *
 * 常驻的看门狗会跟着被看护的进程一起死（同一台机 OOM、同一次 kill -9、同一个 launchd 崩），
 * 一次性运行模型让"看门狗自己活着"这件事由 cron/launchd 来保证。
 */
export async function runOnce(deps: RunDeps): Promise<RunSummary> {
  const { config } = deps;
  const now = deps.now ? deps.now() : new Date();
  const probe = deps.probe ?? ((d: WatchdogDaemonConfig) => probeDaemon(d, { timeoutMs: config.timeoutMs }));

  const probes = await Promise.all(config.daemons.map((d) => probe(d)));
  const expiry = findExpiryIssues(deps.readExpiry ? deps.readExpiry() : [], now);

  // dry-run 拿副本算：planAlerts 会就地推进 daemon 状态，
  // 直接拿原对象算的话，演练会把真状态改脏（收敛窗口被悄悄重置）
  const loaded = deps.state.load();
  const state = deps.dryRun ? (JSON.parse(JSON.stringify(loaded)) as WatchdogState) : loaded;
  const { alerts, heartbeat } = planAlerts({ config, probes, expiry, state, now });

  const sent: string[] = [];
  let failed = 0;
  const extraLogs: string[] = [];

  for (const alert of alerts) {
    if (deps.dryRun) {
      sent.push(alert.text);
      continue;
    }
    try {
      await deps.notifier.send(alert.text);
      alert.commit(state, now);
      sent.push(alert.text);
    } catch (err) {
      // 发不出去也不能把看门狗自己搞挂：记一行，去重时间戳不推进，下一轮重试
      failed += 1;
      extraLogs.push(
        `${formatLocal(now)} [${config.machine}] notify FAILED (${alert.kind}/${alert.key}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  if (!deps.dryRun) deps.state.save(state);

  const statuses = probes.map((p) => `${p.name}=${p.status}`).join(' ');
  const logLine =
    `${formatLocal(now)} [${config.machine}] ${statuses || '(无 daemon)'} | expiry=${expiry.length}` +
    ` | alerts sent=${sent.length} failed=${failed} | heartbeat=${heartbeat ? 'yes' : 'no'}`;

  if (deps.log) {
    deps.log(logLine);
    for (const l of extraLogs) deps.log(l);
  }

  return { probes, expiry, sent, failed, heartbeat, logLine };
}
