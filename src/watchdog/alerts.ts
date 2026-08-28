import type {
  DaemonStatus,
  ExpiryFinding,
  ProbeResult,
  WatchdogConfig,
  WatchdogState,
} from './types.js';
import { DEFAULT_HEARTBEAT_HOUR } from './paths.js';

/** 同一 daemon 同一故障类别的收敛窗口：30 分钟内只发一条 */
export const CONVERGE_MS = 30 * 60 * 1000;

/** 本地日期 key，用于"每天最多一次"这类判断 */
export function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function formatLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${dayKey(d)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function formatDuration(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60000));
  if (totalMin < 60) return `${totalMin}m`;
  return `${Math.floor(totalMin / 60)}h${totalMin % 60}m`;
}

const STATUS_LABEL: Record<DaemonStatus, string> = {
  ok: '正常',
  down: '敲不通 /health —— 进程没了 / 端口不通 / 非 200',
  degraded: 'agent 自报不健康',
  'error-streak': '最近几轮全部失败',
};

const STATUS_EMOJI: Record<DaemonStatus, string> = {
  ok: '✅',
  down: '🔴',
  degraded: '🟠',
  'error-streak': '🟠',
};

/**
 * 一条待发报警。
 *
 * `commit` 只在**真的发出去之后**调用——去重时间戳跟着"送达"走而不是跟着"尝试"走，
 * 否则飞书抽风的那一次会把这条报警彻底吞掉（30 分钟内不再重试）。
 */
export interface AlertPlan {
  kind: 'fault' | 'recovery' | 'expiry' | 'heartbeat';
  key: string;
  text: string;
  commit(state: WatchdogState, now: Date): void;
}

export interface PlanInput {
  config: WatchdogConfig;
  probes: ProbeResult[];
  expiry: ExpiryFinding[];
  state: WatchdogState;
  now: Date;
}

export interface PlanOutput {
  alerts: AlertPlan[];
  heartbeat: boolean;
}

function faultText(cfg: WatchdogConfig, p: ProbeResult, now: Date, sinceMs?: number): string {
  const lines = [
    `${STATUS_EMOJI[p.status]} [${cfg.machine}] ${p.name} 异常`,
    `类别: ${p.status} — ${STATUS_LABEL[p.status]}`,
    `端口: ${p.port}`,
  ];
  if (p.detail) lines.push(`详情: ${p.detail}`);
  if (p.account) lines.push(`账号: ${p.account}`);
  if (typeof p.uptime === 'number') lines.push(`daemon uptime: ${Math.round(p.uptime)}s`);
  if (sinceMs !== undefined) lines.push(`已持续: ${formatDuration(now.getTime() - sinceMs)}`);
  lines.push(`时间: ${formatLocal(now)}`);
  return lines.join('\n');
}

/**
 * 报警状态机。**纯计算 + 就地推进 daemon 状态**，时间从 `now` 注入，测试不用 sleep。
 *
 * 三条规则：
 * 1. 30 分钟收敛：同一 daemon 同一类别 30 分钟内只发一条，持续故障每 30 分钟带时长重发
 * 2. 恢复播报：故障 → ok 时发一条"已恢复（故障持续 Xm）"
 * 3. 每日安好心跳：heartbeatHour 之后第一次全绿运行发一条，证明报警管道本身还活着
 *
 * 注意状态提交的两种口径：
 * - 故障态（status/since）**无条件**推进：故障时长要从第一次发现开始算
 * - 恢复态只在恢复消息**发送成功后**提交：发失败就留在故障态，下一轮自然重试恢复播报
 */
export function planAlerts(input: PlanInput): PlanOutput {
  const { config, probes, expiry, state, now } = input;
  const nowMs = now.getTime();
  const alerts: AlertPlan[] = [];

  for (const p of probes) {
    const prev = state.daemons[p.name];

    if (p.status === 'ok') {
      if (!prev) {
        state.daemons[p.name] = { status: 'ok', since: nowMs };
        continue;
      }
      if (prev.status === 'ok') continue;
      // 故障 → ok：恢复播报（提交延迟到发送成功之后）
      const since = prev.since;
      alerts.push({
        kind: 'recovery',
        key: p.name,
        text: [
          `✅ [${config.machine}] ${p.name} 已恢复（故障持续 ${formatDuration(nowMs - since)}）`,
          `之前类别: ${prev.status}`,
          `时间: ${formatLocal(now)}`,
        ].join('\n'),
        commit(s) {
          s.daemons[p.name] = { status: 'ok', since: nowMs };
        },
      });
      continue;
    }

    // 故障态
    const isNewCategory = !prev || prev.status !== p.status;
    if (isNewCategory) {
      // 新故障（或换了类别）：since 归零重算，去重时间戳清空 —— 必须立刻喊
      state.daemons[p.name] = { status: p.status, since: nowMs };
      alerts.push({
        kind: 'fault',
        key: `${p.name}:${p.status}`,
        text: faultText(config, p, now),
        commit(s) {
          const cur = s.daemons[p.name];
          if (cur) cur.lastNotifiedAt = nowMs;
        },
      });
      continue;
    }

    // 同类别持续：30 分钟收敛（上次没发成功的话 lastNotifiedAt 为空，这里立刻重试）
    const last = prev.lastNotifiedAt;
    const due = last === undefined || nowMs - last >= CONVERGE_MS;
    if (!due) continue;
    alerts.push({
      kind: 'fault',
      key: `${p.name}:${p.status}`,
      text: faultText(config, p, now, prev.since),
      commit(s) {
        const cur = s.daemons[p.name];
        if (cur) cur.lastNotifiedAt = nowMs;
      },
    });
  }

  // 凭证到期：同一条目每天最多一条
  const today = dayKey(now);
  for (const f of expiry) {
    if (state.expiryNotified[f.name] === today) continue;
    const head =
      f.level === 'expired'
        ? `🔴 [${config.machine}] 凭证已过期: ${f.name}`
        : `⚠️ [${config.machine}] 凭证即将到期: ${f.name}（还有 ${f.daysLeft} 天）`;
    const lines = [head, `到期日: ${f.expiresAt}`];
    if (f.note) lines.push(`备注: ${f.note}`);
    lines.push(`时间: ${formatLocal(now)}`);
    alerts.push({
      kind: 'expiry',
      key: `expiry:${f.name}`,
      text: lines.join('\n'),
      commit(s) {
        s.expiryNotified[f.name] = today;
      },
    });
  }

  // 每日安好心跳：证明"报警管道"本身没死——只有故障通道会说话的系统，
  // 沉默永远有两种解释（没事 / 看门狗自己也挂了），这条心跳负责消歧
  const allGreen = probes.every((p) => p.status === 'ok') && expiry.length === 0;
  const hour = config.heartbeatHour ?? DEFAULT_HEARTBEAT_HOUR;
  const heartbeatDue = allGreen && now.getHours() >= hour && state.lastHeartbeatDay !== today;
  if (heartbeatDue) {
    const list = probes.map((p) => `  ✅ ${p.name} (:${p.port})`).join('\n');
    alerts.push({
      kind: 'heartbeat',
      key: 'heartbeat',
      text: [`💚 [${config.machine}] watchdog 心跳：全部正常`, list, `时间: ${formatLocal(now)}`]
        .filter(Boolean)
        .join('\n'),
      commit(s) {
        s.lastHeartbeatDay = today;
      },
    });
  }

  return { alerts, heartbeat: heartbeatDue };
}
