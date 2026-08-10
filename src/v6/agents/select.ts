import { log } from '../../utils.js';
import type { AgentAdapter } from '../contracts.js';
import { CodexExecAgent } from './codex-exec.js';
import { CodexAppServerAgent } from './codex-app-server.js';
import { ClaudeSdkAgent } from './claude-sdk.js';

export interface AgentConfigLike {
  backend?: string;
}

/**
 * 后端选择:env CC2WECHAT_BACKEND > config.backend。
 *
 * 2026-08-10 起 `codex` 指向**常驻** app-server 版 —— 两台生产机的 env 都是
 * `CC2WECHAT_BACKEND=codex`,所以"部署即常驻",这正是这次重构要的效果
 * (实测同 thread 追加一轮 13.5s → 1.6s)。
 *
 * `codex-exec` 是逃生口:app-server 出了协议级问题时,把 env 改成 codex-exec
 * 就回到一次性 spawn 的老路,不用回滚版本。
 * 常驻版自己还带一层降级(连续 3 次起不来自动走 exec),这个 switch 是给人用的那层。
 */
export function selectAgent(env: NodeJS.ProcessEnv, config: AgentConfigLike = {}): AgentAdapter {
  const name = (env.CC2WECHAT_BACKEND ?? config.backend ?? 'claude-code').trim().toLowerCase();

  switch (name) {
    case 'codex':
    case 'codex-persistent':
      return new CodexAppServerAgent({ env });
    case 'codex-exec':
      log('[warn] backend=codex-exec：走一次性 spawn 的逃生口，每轮多花十几秒');
      return new CodexExecAgent();
    case 'claude-code':
    case 'claude':
      return new ClaudeSdkAgent();
    default:
      log(`[warn] 未知 backend "${name}"，回退到 claude-code`);
      return new ClaudeSdkAgent();
  }
}
