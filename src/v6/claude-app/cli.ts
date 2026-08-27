import { CcRegistry } from './cc-registry.js';
import { InboxRegistry } from './inbox-registry.js';
import { formatProbe, runProbe } from './probe.js';
import { formatSeedReport, seedInbox } from './seed.js';

/**
 * `cc2wechat claude-app <seed|status>` 的实现。
 *
 * 放在这里而不是 src/cli.ts 里,是因为 cli.ts 顶层就跑 argv 解析 + switch,
 * 引它一下就会执行 —— 没法测。cli.ts 那边只留一行分发。
 */

export interface ClaudeAppCliDeps {
  argv: string[];
  port: number;
  accountId?: string;
  /** 台账目录,缺省 ~/.cc2wechat */
  dataDir?: string;
  /** 收件箱根目录,缺省 ~/cc-wechat */
  root?: string;
  inboxes?: InboxRegistry;
  registry?: CcRegistry;
  /** 拉 daemon 的 /claude-app/status;null = 打不通 */
  fetchStatus?: (port: number) => Promise<Record<string, unknown> | null>;
  openUrl?: (url: string) => void;
  out?: (line: string) => void;
}

const USAGE = `
  cc2wechat claude-app — Claude desktop app 会话后端

    cc2wechat claude-app seed --name <名字> [--root <目录>] [--no-open] [--force]
        播种一个收件箱:建目录 + 写 CLAUDE.md/settings.json + 发深链 + 登记台账。
        最后一步(在 app 里敲首条消息)必须人做,一次,终身。

    cc2wechat claude-app status [--port <端口>]
        自检探针 + 收件箱台账 + 网关连接状态。

  文档: docs/claude-app/SEEDING.md(播种) / docs/claude-app/GATEWAY.md(网关值守)
`;

function flag(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : '';
}

async function defaultFetchStatus(port: number): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/claude-app/status`);
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function runClaudeAppCli(deps: ClaudeAppCliDeps): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const sub = deps.argv[0];
  const inboxes = deps.inboxes ?? new InboxRegistry({ accountId: deps.accountId ?? 'default', dir: deps.dataDir });
  const registry = deps.registry ?? new CcRegistry();

  if (sub === 'seed') {
    const name = flag(deps.argv, '--name');
    if (!name) {
      out('  用法: cc2wechat claude-app seed --name <名字>');
      out(USAGE);
      return 1;
    }
    try {
      const r = await seedInbox({
        name,
        root: flag(deps.argv, '--root') ?? deps.root ?? undefined,
        inboxes,
        openUrl: deps.openUrl,
        open: !deps.argv.includes('--no-open'),
        force: deps.argv.includes('--force'),
      });
      out(formatSeedReport(r));
      return 0;
    } catch (err) {
      out(`  ❌ ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  if (sub === 'status') {
    const portFlag = flag(deps.argv, '--port');
    const port = portFlag ? Number.parseInt(portFlag, 10) : deps.port;
    const fetchStatus = deps.fetchStatus ?? defaultFetchStatus;
    const busStats = await fetchStatus(port);

    out('');
    out(`  🦞 claude-app 后端状态 (port ${port})`);
    const report = runProbe({ registry, inboxes, busStats });
    out(formatProbe(report));

    const list = inboxes.list();
    if (list.length > 0) {
      out('  收件箱台账:');
      for (const i of list) {
        const bind = i.conversationId ? `会话 ${i.conversationId}` : '未绑定';
        const lid = i.localId ?? '（待人工敲首条 → localId 未解析）';
        out(`    · ${i.name}  ${i.cwd}`);
        out(`        localId: ${lid}`);
        out(`        绑定: ${bind}   generation: ${i.generation}`);
      }
      out('');
    } else {
      out('  还没有收件箱。播种: cc2wechat claude-app seed --name <名字>');
      out('');
    }

    if (!busStats) {
      out('  提示: 拿不到 /claude-app/status —— daemon 没在跑,或者不是 claude-app 后端');
      out('        起 daemon: CC2WECHAT_BACKEND=claude-app cc2wechat start');
      out('');
    }
    return report.ok ? 0 : 1;
  }

  out(USAGE);
  return 1;
}
