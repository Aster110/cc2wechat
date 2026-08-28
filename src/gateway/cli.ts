/**
 * 运维小 CLI：`node dist/gateway/cli.js <command>`。
 *
 * 两条命令：
 *
 *   pair-grant   签发一次性配对码（打印一次，之后库里只剩 hash）
 *   health       打印 daemon 的健康快照
 *
 * **两条都是通过回环 HTTP 找正在跑的 daemon 办的，不是自己开一份状态。**
 * 原因在配对码本身：它从不落库，pr_ 路由要靠它当场算出来并登记进 daemon 的
 * 轮询集合。CLI 自己签一张，daemon 那头根本不会去听那条路由 ——
 * 玩家扫了码，等到的是永远的静默。
 */
import { loadGatewayConfig, loadOpsEndpoint, type IssuedGrant } from './bootstrap/waku.js';

interface CliOptions {
  endpointId?: string;
  scopes?: string[];
  ttlMs?: number;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--endpoint' && value !== undefined) {
      options.endpointId = value;
      index += 1;
    } else if (arg === '--scopes' && value !== undefined) {
      options.scopes = value.split(',').map((item) => item.trim()).filter((item) => item.length > 0);
      index += 1;
    } else if (arg === '--ttl-ms' && value !== undefined) {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('--ttl-ms must be a positive integer');
      options.ttlMs = parsed;
      index += 1;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown flag: ${arg}`);
    }
  }
  return options;
}

interface OpsEndpoint {
  host: string;
  port: number;
}

function baseUrl(endpoint: OpsEndpoint): string {
  return `http://${endpoint.host}:${endpoint.port}`;
}

async function call(endpoint: OpsEndpoint, path: string, method: 'GET' | 'POST', body?: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl(endpoint)}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error(
      `cannot reach the gateway daemon at ${baseUrl(endpoint)} — is it running? ` +
        '(start it with `node dist/gateway/server.js`)',
    );
  }
  const text = await response.text();
  const parsed: unknown = text.length === 0 ? null : JSON.parse(text);
  if (!response.ok) {
    const code =
      typeof parsed === 'object' && parsed !== null && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : `http_${response.status}`;
    throw new Error(`gateway refused the request: ${code}`);
  }
  return parsed;
}

function printGrant(grant: IssuedGrant): void {
  const minutes = Math.max(0, Math.round((grant.expiresAt - Date.now()) / 60_000));
  process.stdout.write(
    [
      '',
      '  一次性配对码（只显示这一次，daemon 里也只留 hash）：',
      '',
      `    ${grant.token}`,
      '',
      `  握手路由 : ${grant.pairRouteId}`,
      `  endpoint : ${grant.endpointId}`,
      `  scopes   : ${grant.scopes.join(', ')}`,
      `  有效期   : 约 ${minutes} 分钟（过期后重新签发即可）`,
      '',
      '  把上面这串码填进 Playable 的配对框。daemon 重启会让未完成的配对失效——',
      '  码只活在进程内存里，重启后重新签一张就行。',
      '',
    ].join('\n'),
  );
}

const USAGE = `用法：node dist/gateway/cli.js <command>

  pair-grant [--endpoint <id>] [--scopes a,b] [--ttl-ms <n>]
             签发一次性配对码并登记到正在跑的 daemon（打印一次；仅 waku-mailbox 通道）
  health     打印 daemon 健康快照（waku-mailbox / waku-dm 都可用）

配置走 WAKU_GATEWAY_* 环境变量：health 只看 WAKU_GATEWAY_CHANNEL（决定缺省端口：
waku-mailbox=18091、waku-dm=18092）与 WAKU_GATEWAY_HEALTH_PORT；pair-grant 需要 V1 全量配置
（至少 WAKU_GATEWAY_RUNTIME_JS）。
`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === undefined || command === 'help' || command === '--help') {
    process.stdout.write(USAGE);
    return;
  }

  if (command === 'pair-grant') {
    // 配对码是 V1 信箱通道的概念：要全量 V1 配置（它会在缺 RUNTIME_JS 时说人话）。
    const config = loadGatewayConfig(process.env);
    const options = parseArgs(rest);
    const grant = (await call({ host: config.healthHost, port: config.healthPort }, '/admin/pair-grant', 'POST', options)) as IssuedGrant;
    printGrant(grant);
    return;
  }

  if (command === 'health') {
    // health 对两种通道都能用：只需要知道 daemon 在哪个回环端口听。
    const health = await call(loadOpsEndpoint(process.env), '/health', 'GET');
    process.stdout.write(`${JSON.stringify(health, null, 2)}\n`);
    return;
  }

  throw new Error(`unknown command: ${command}\n\n${USAGE}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
