export type EngineName = 'v5' | 'v6';

export interface EngineConfigLike {
  delivery?: string;
}

/**
 * 生产回退开关。
 *
 * - `CC2WECHAT_ENGINE=v5|v6` 一票定音(出事时最快的止血手段)
 * - 否则看投递形态:`tmux` / `terminal` 是 v5 独有的能力(Web 终端场景),继续走 v5
 * - 其余(sdk / pipe / auto / 没设)走 v6 —— 两台生产机都是 `CC2WECHAT_DELIVERY=sdk`
 */
export function selectEngine(env: NodeJS.ProcessEnv, config: EngineConfigLike = {}): EngineName {
  const explicit = (env.CC2WECHAT_ENGINE ?? '').trim().toLowerCase();
  if (explicit === 'v5' || explicit === 'v6') return explicit;

  const delivery = (env.CC2WECHAT_DELIVERY ?? config.delivery ?? '').trim().toLowerCase();
  if (delivery === 'tmux' || delivery === 'terminal') return 'v5';
  return 'v6';
}

export const ENGINE_ENTRY: Record<EngineName, string> = {
  v5: './v5/main.js',
  v6: './v6/main.js',
};

export interface StartEngineOptions {
  env: NodeJS.ProcessEnv;
  config?: EngineConfigLike;
  /** 注入点:生产传 (s) => import(s),测试拿它验证路由到哪个入口 */
  importer: (specifier: string) => Promise<unknown>;
}

export async function startEngine(opts: StartEngineOptions): Promise<EngineName> {
  const engine = selectEngine(opts.env, opts.config ?? {});
  await opts.importer(ENGINE_ENTRY[engine]);
  return engine;
}
