// 带外看门狗的公共类型。
//
// 为什么要有这套东西：微信桥挂掉的时候，它唯一的嘴（微信）也一起挂了——
// 带内报警等于没报警。看门狗是**进程外**的独立小程序，cron 拉起来跑一次就退，
// 只干一件事：从外面敲 daemon 的 /health，不对劲就走飞书 webhook 这条带外通道喊人。

/** 单个被看护的 daemon */
export interface WatchdogDaemonConfig {
  name: string;
  port: number;
  /** 默认 127.0.0.1——看门狗只看本机，跨机各自装一个 */
  host?: string;
}

export interface WatchdogConfig {
  /** 机器名，进报警文案，用来区分是哪台在喊 */
  machine: string;
  /** 飞书自定义机器人 webhook */
  webhook: string;
  daemons: WatchdogDaemonConfig[];
  /** 凭证到期表路径，缺省 ~/.cc2wechat/credentials-expiry.json；文件不存在 = 跳过 */
  expiryFile?: string;
  /** 每天几点之后发"安好心跳"（本地时区），缺省 9 */
  heartbeatHour?: number;
  /** 状态文件路径，缺省 ~/.cc2wechat/watchdog-state.json */
  stateFile?: string;
  /** 运行日志路径，缺省 ~/.cc2wechat/watchdog.log */
  logFile?: string;
  /** 单次 /health 探测超时，缺省 5000ms */
  timeoutMs?: number;
}

/** 探测结论四态 */
export type DaemonStatus = 'ok' | 'down' | 'degraded' | 'error-streak';

export interface ProbeResult {
  name: string;
  port: number;
  status: DaemonStatus;
  /** 人读的原因，进报警文案 */
  detail?: string;
  /** /health 里带的上下文，报警时一起给出去 */
  account?: string;
  uptime?: number;
}

/** credentials-expiry.json 的一条 */
export interface ExpiryEntry {
  name: string;
  /** YYYY-MM-DD（按本地时区解释）或任何 Date 能解析的串 */
  expiresAt: string;
  note?: string;
}

export type ExpiryLevel = 'warn' | 'expired';

export interface ExpiryFinding extends ExpiryEntry {
  level: ExpiryLevel;
  /** 距到期天数，已过期为负 */
  daysLeft: number;
}

/** 单个 daemon 的报警状态机状态 */
export interface DaemonState {
  status: DaemonStatus;
  /** 进入当前状态的时刻（ms）——恢复播报的"故障持续 Xm"从这里算 */
  since: number;
  /** 上次真正发出去报警的时刻（ms）；发送失败不写，让下一轮重试 */
  lastNotifiedAt?: number;
}

export interface WatchdogState {
  version: 1;
  daemons: Record<string, DaemonState>;
  /** 凭证条目 -> 上次提醒的日期 key（YYYY-MM-DD，本地时区），实现"每天最多一次" */
  expiryNotified: Record<string, string>;
  /** 上次发安好心跳的日期 key */
  lastHeartbeatDay?: string;
}

export interface Notifier {
  send(text: string): Promise<void>;
}

export interface RunSummary {
  probes: ProbeResult[];
  expiry: ExpiryFinding[];
  /** 成功发出去的报警文案 */
  sent: string[];
  /** 发送失败的条数（失败只记日志，不 crash，也不推进去重时间戳） */
  failed: number;
  heartbeat: boolean;
  logLine: string;
}
