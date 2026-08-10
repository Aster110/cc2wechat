import { log } from '../../utils.js';
import type { AgentAdapter } from '../contracts.js';
import { CodexExecAgent } from './codex-exec.js';
import { ClaudeSdkAgent } from './claude-sdk.js';

export interface AgentConfigLike {
  backend?: string;
}

/**
 * 后端选择:env CC2WECHAT_BACKEND > config.backend。
 * 两台生产机都设的 `CC2WECHAT_BACKEND=codex`,语义必须一比一保住。
 *
 * `codex-persistent` 是给常驻 codex 实现留的 switch 位(另一条线在做),
 * 现在先退回一次性 spawn,并打一行 warn 让运维知道自己拿到的不是常驻版。
 */
export function selectAgent(env: NodeJS.ProcessEnv, config: AgentConfigLike = {}): AgentAdapter {
  const name = (env.CC2WECHAT_BACKEND ?? config.backend ?? 'claude-code').trim().toLowerCase();

  switch (name) {
    case 'codex':
      return new CodexExecAgent();
    case 'codex-persistent':
      log('[warn] backend=codex-persistent 尚未实现，暂用一次性 spawn 的 codex agent 顶上');
      return new CodexExecAgent();
    case 'claude-code':
    case 'claude':
      return new ClaudeSdkAgent();
    default:
      log(`[warn] 未知 backend "${name}"，回退到 claude-code`);
      return new ClaudeSdkAgent();
  }
}
