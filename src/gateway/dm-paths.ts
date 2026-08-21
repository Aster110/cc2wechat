/**
 * waku-dm daemon 的落脚点常量。
 *
 * 单独一个文件、**没有任何 import**，因为 `waku-dm-reply` 只想知道"端口写在哪"，
 * 不想为此把 bootstrap 整条依赖链（sqlite / codex agent / registry）拉进一个
 * 只发一次 HTTP POST 的 CLI 进程——那会让每次调用都打印一行 SQLite 实验特性警告，
 * 还平白多花几百毫秒。
 */

/** `~/<这个名字>` 是 waku-dm 的缺省 state dir（与 V1 信箱 daemon 分家，可同机并跑）。 */
export const DEFAULT_DM_STATE_DIR_NAME = '.waku-gateway-dm';

/** daemon 启动时把回环端口写进 `<stateDir>/<这个名字>`，退出时删掉。 */
export const HEALTH_PORT_FILE = 'health.port';

/** waku-dm 通道的缺省运维端口（V1 信箱是 18091）。 */
export const DEFAULT_DM_HEALTH_PORT = 18092;
