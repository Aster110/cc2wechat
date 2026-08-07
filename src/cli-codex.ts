#!/usr/bin/env node
// cx2wechat / codex2wechat —— codex 后端的 CLI 别名入口。
// 与 cc2wechat 同一套代码,唯一区别:默认 backend=codex(可被显式 env 覆盖)。
process.env.CC2WECHAT_BACKEND ??= 'codex';
void import('./cli.js');
