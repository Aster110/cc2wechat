# Waku DM channel（`waku-dm`）— 架构与故障排查

> 对应契约：`AGENT_BRIDGE_CONTRACT.md` §3（daemon 侧）。平台侧（§2：`agent_bridges` 表、`/agent-bridges/*` 路由、
> bridge JWT audience）由 waku 仓实现；本仓只消费它们。真源优先级：代码 > 本文 > 历史设计稿。

## 一句话

Waku 好友列表里的「AI 好友」= 一个马甲账号。用户给它发原生私信 → 平台照常落库并推到马甲自己的 per-user SSE 总线 →
本机 daemon 以马甲身份订阅总线，把文字交给本机 Codex（复用 V1 网关 Core + v6 AgentAdapter）→ 以马甲为 sender
`POST /chat/conversations/{id}/messages` 回信。桥上没有新传输机制：入站 = SSE，出站 = REST，鉴权 = 平台 JWT。

## 拓扑

```
 手机 App ──私信──► Waku 平台（chat 域落库 + fanout）
                          │  user:{persona} 总线
                          ▼
           GET /users/me/events (SSE, Last-Event-ID=user_seq)
                          │
  ┌───────────────────────┼──────────────────────────── daemon（本机，NAT 后纯出站）────┐
  │   sse-client ──帧──► adapter（过滤/游标/慢回执/心跳）──明文信封──► Core ingress        │
  │        ▲                  │                                        │ AclIdentityResolver │
  │  BridgeTokenProvider      │ send()                                 ▼                     │
  │  (abc_… → 1h JWT)         │                        orchestrator ──► LocalRunner ──► codex│
  │        │                  ▼                              ▲  outbox(SQLite)               │
  │   chat-client ◄── CoreDelivery（先落 outbox 再发，原 id 重投）◄──── final/error          │
  └────────┼─────────────────────────────────────────────────────────────────────────────────┘
           ▼
  POST /chat/conversations/{id}/messages  {client_msg_id, kind:text, body}
  POST /chat/conversations/{id}/read      {conv_seq}
  POST /agent-bridges/me/heartbeat        {agent_state, queued, running, capabilities}
```

模块（`src/gateway/`）：

| 文件 | 职责 |
|---|---|
| `channels/waku-dm/credential-provider.ts` | 两种凭证模式：bridge（`abc_…` 文件 → `POST /agent-bridges/token`）/ session（`auth.json` + `cli/auth/refresh` 原子写回） |
| `channels/waku-dm/sse-client.ts` | fetch + ReadableStream 的 SSE 解析与生存策略（30s 无字节判死、EOF 重连、401 换 token、指数退避 2s→60s） |
| `channels/waku-dm/chat-client.ts` | 唯一碰平台 DTO 的地方：send / read / heartbeat / me，401 只刷新一次，错误分类 |
| `channels/waku-dm/adapter.ts` | ChannelAdapter：入站过滤与游标、出站切片与回执映射、心跳与 health、慢回执 |
| `core/identity.ts` | `IdentityResolver` 策略：V1 = pairing 行现查；waku-dm = `OWNER_USER_IDS` ACL |
| `core/ingress.ts` | 明文信封分支：receipt 幂等 → 命令（/new /stop /exit /help）或 turn；服务端代数 |
| `core/dm-commands.ts` | 命令词表（复用 v6 `matchCommand`）与回执文案 |
| `bootstrap/waku-dm.ts` | 配置读取 + 组装 + `[turn]` 日志接线 |

## 三幕

1. **入站**：SSE 帧 `event: chat.message` → 解析 `data`（单行 JSON）→ 过滤：自回显（sender = 马甲）、非 dm、已撤回、
   `source=agent_bridge`（别的 bot）、冷启动旧历史（无游标且 `created_at < 启动−60s`）；非文字消息回一句「暂时只支持文字」
   （每会话 60s 一次）。剩下的变成 `{channel:'waku-dm', routeId: conversation_id, messageId, principalRef: sender_user_id, text}`
   交给 Core。**游标只在 sink 返回后推进**（落在 V1 的 `mailbox_cursors` 表，collection=`waku_dm_user_events`，`last_created_at` 列存 user_seq）。
2. **Core**：`AclIdentityResolver` 判 owner → admin endpoint（`isAdminPrincipal` 再判一次，两道闸）；陌生人默认 deny（静默：不留 receipt、不回话）。
   `inbox_receipts(pairingId=sender, messageId)` 去重。文本命令翻成 control：`/stop` → 抢占 abort；`/new` `/exit` → **同会话提代**
   （`startNew(previousConversationId === conversationId)` → generation+1，旧 codex thread binding 失效，队列清空）；`/help` → 直接回文本。
   普通文字 → turn，代数由服务端记（`authorize()` 现查），Waku 会话 id 不变。
3. **出站**：orchestrator 的 `final`/`error` → CoreDelivery 先落 outbox → adapter `send()`：`stripMarkdown` + 按字符 ≤3900 切片，
   `client_msg_id = <messageId>` 或 `<messageId>:<index>`（服务端 `UNIQUE(sender, client_msg_id)` ⇒ 重投幂等）→ 发完 `POST …/read`。
   `progress`/`ack`/`status` 在私聊里没有对应物，直接 `sent`。

回执映射：2xx → `sent`；429（读 `Retry-After`）/ 5xx / 408 → `retryable`；401 → 换 token 重放一次，仍 401 → `retryable`；
403（`not_friends`/`not_member`）/ 404 / 400 → `permanent-failure`；写请求网络断 → `unknown`（可能已落库，原 id 重投）。

## 环境变量

| 变量 | 含义 | 默认 |
|---|---|---|
| `WAKU_GATEWAY_CHANNEL` | `waku-dm`；缺省 `waku-mailbox`（V1 行为不变） | `waku-mailbox` |
| `WAKU_GATEWAY_API_BASE` | v1 base，如 `https://waku-core-api-yyvdcgnhha-uc.a.run.app/api/v1` | session 模式从 auth.json `api_base` 读；否则必填 |
| `WAKU_GATEWAY_BRIDGE_CREDENTIAL_FILE` | 0600 文件，内容 `abc_…`（`waku agent-friend credential issue <bridge_id> --write <path>`） | — |
| `WAKU_GATEWAY_AUTH_PATH` | 备选 session 模式：一个能登录的真账号 auth.json（与 CREDENTIAL_FILE 二选一，都给 → 启动失败） | — |
| `WAKU_GATEWAY_OWNER_USER_IDS` | 逗号分隔 Waku user_id → `admin-bypass` | 必填（默认 deny 时） |
| `WAKU_GATEWAY_DEFAULT_TIER` | 非 owner 的落点：`deny`（静默）或 `chat-only` / `sandbox-workspace` / `repo-pr`；非 deny 必须给 `GUEST_WORKSPACE_DIR` | `deny` |
| `WAKU_GATEWAY_GUEST_WORKSPACE_DIR` | guest endpoint 的 cwd（绝对路径） | — |
| `WAKU_GATEWAY_STATE_DIR` | SQLite / master key / app-server pid | `~/.waku-gateway-dm` |
| `WAKU_GATEWAY_HEALTH_PORT` | 回环运维口 | `18092` |
| `WAKU_GATEWAY_WORKSPACE_DIR` | owner endpoint 的 cwd（Codex 工作目录） | `process.cwd()` |
| `WAKU_GATEWAY_AGENT_BACKEND` | `codex`（常驻 app-server）/ `claude-sdk` | `codex` |
| `WAKU_GATEWAY_CODEX_HOME` / `WAKU_GATEWAY_CODEX_EFFORT` | 透传给 codex | — |
| `WAKU_GATEWAY_HEARTBEAT_INTERVAL_MS` | bridge 心跳间隔 | `30000` |
| `WAKU_GATEWAY_SSE_IDLE_TIMEOUT_MS` | 无字节判死阈值 | `30000` |
| `WAKU_GATEWAY_COLD_START_GRACE_MS` | 冷启动丢弃多旧的回放 | `60000` |
| `CC2WECHAT_ACK_MS` | 慢回执「收到，正在处理…」阈值，`0` 关闭 | `60000` |
| `WAKU_GATEWAY_NODE_ID` / `ENDPOINT_ID` / `TRUST_TIER` / `WORKSPACE_POLICY_ID` / `RUNNER_PROFILE_ID` / `QUEUE_CAP` / `OUTBOX_TTL_MS` / `FLUSH_INTERVAL_MS` | 沿用 V1 | 沿用 |

## Runbook

```bash
cd ~/AIproject/wechat-cc-channel && npm run build

export WAKU_GATEWAY_CHANNEL=waku-dm
export WAKU_GATEWAY_API_BASE=https://waku-core-api-yyvdcgnhha-uc.a.run.app/api/v1
export WAKU_GATEWAY_BRIDGE_CREDENTIAL_FILE=$HOME/.waku-gateway-dm/bridge.credential   # chmod 600
export WAKU_GATEWAY_OWNER_USER_IDS=usr_8c8b6c0329f140cd8dc78dfcff7ddeec
export WAKU_GATEWAY_STATE_DIR=$HOME/.waku-gateway-dm
export WAKU_GATEWAY_HEALTH_PORT=18092
export WAKU_GATEWAY_WORKSPACE_DIR=$HOME/AIproject/polyverse_samantha
export WAKU_GATEWAY_AGENT_BACKEND=codex
export WAKU_GATEWAY_CODEX_HOME=$HOME/.codex
node dist/gateway/server.js

# 健康
WAKU_GATEWAY_CHANNEL=waku-dm WAKU_GATEWAY_HEALTH_PORT=18092 node dist/gateway/cli.js health
curl -s http://127.0.0.1:18092/health | jq '{core, channel, credential, outbox, queues}'

# 只读 SSE smoke（session 模式，用自己的账号订阅 15 秒，只打印事件名与 seq）
WAKU_GATEWAY_CHANNEL=waku-dm WAKU_GATEWAY_AUTH_PATH=$HOME/.config/waku/auth.json \
WAKU_GATEWAY_OWNER_USER_IDS=usr_8c8b6c0329f140cd8dc78dfcff7ddeec WAKU_GATEWAY_WORKSPACE_DIR=/tmp \
node dist/gateway/server.js --sse-smoke 15

# 金线
PERSONA_USER_ID=<persona_user_id> node scripts/golden-e2e-dm.mjs
```

`/health` 的 `channel` 块：`{type:'waku-dm', state: running|degraded|disabled|stopped, cursor, lastEventAt, lastHeartbeatAt,
reconnects, tokenState: ready|stale|degraded|unloaded, selfUserId, sseState}`；`credential` 块：`{mode, ok, state, expiresInSec}`。

## 日志四件套

| 事件 | 形状 |
|---|---|
| 入站 | `<- usr_8c8b: 请只回答这个暗号本身：ZX123456`（sender 前 8 字符 + 正文前 50 字符） |
| 每轮 | `[turn] conv=conv_01J0 agent=codex queue=3ms first=812ms total=4021ms outcome=final` |
| 传输 | `sse stream ended cleanly, reconnecting in 1000ms` / `sse rejected (http_401); credentials invalidated…` / `sse no bytes for 30000ms…` / `sse connect failed (network:TypeError), retry in 2000ms (failures=1)` |
| 发送失败 | `send failed conv=conv_01J00000 msg=0198f4c1 chunk=1/1: not_friends (HTTP 403)` |

## 故障排查

| 症状 | 看哪里 | 处置 |
|---|---|---|
| 启动即退 `bridge_credential_insecure_file` | 凭证文件权限 | `chmod 600 <file>` |
| 启动即退 `bridge_token_unauthenticated` | 凭证已吊销/过期 | `waku agent-friend credential issue <bridge_id> --write <path>` 重签 |
| health `channel.state=disabled` | 平台把 bridge 置为 disabled（心跳回包） | `waku agent-friend set <bridge_id> --status active`，重启 daemon |
| `credential.state=degraded` 且日志反复 `sse rejected (http_401)` | token 换不出来：凭证吊销 / 网络 | 同上；session 模式看 `waku login` |
| 用户发了没回音，日志有 `dropped … acl_denied` | 发送者不在 `OWNER_USER_IDS` | 加 id 重启；或配 `DEFAULT_TIER` + `GUEST_WORKSPACE_DIR` |
| 回复发不出，`send failed … not_friends (HTTP 403)` | owner 取关了马甲（dm 要互关） | 重新关注；outbox 行已标 failed 不会再重投 |
| 冷启动后老消息没被回复 | 设计：无游标时 `created_at < 启动−60s` 的回放全部丢弃 | 要让它处理，重启前把游标清掉不会有用（还是冷启）；重发即可 |
| 想从头重放 | `mailbox_cursors` 表 `waku_dm_user_events` 行 | 删该行 + 删对应 `inbox_receipts`（否则 duplicate）——一般不需要 |
| `/new` 后 Codex 仍记得上下文 | `conversations.generation` 没 +1 | 看 `[turn]` 前是否有「已开启新对话」回执；`sqlite3 gateway.db 'select * from conversations'` |
| 心跳 403 | session 模式（真账号不是 bridge 身份） | 预期：session 模式心跳自动关闭；用 bridge 模式 |

## 与契约的偏差（实现时的最小改动决策）

1. `InboundEnvelope` 做成 `waku | waku-dm` 的判别联合，而不是单一形状加可选字段：V1 代码与 532 个测试的类型零改动。
2. `/new` = `ConversationService.startNew(previousConversationId === conversationId)` 的 renew 分支（同会话 generation+1）。
   V1 客户端从不发这种形状（它们 new 时总铸新 id），原「重开已有会话被拒」语义原样保留。
3. 游标复用 `mailbox_cursors` 表（不加 migration）：`last_created_at` 列承载 user_seq。
4. `progress` 仍会经 outbox（Core 不知道通道能力）→ adapter 立刻 `sent`；outbox 行数会随 Codex 进度事件增长（V1 同样不 GC），登记为债。
5. 慢回执与「只支持文字」提示直发 REST、不走 outbox：一次性提示丢了没代价，重投反而刷屏。
6. 出站 `final` 后的 `POST /read` 用该会话**最后一条入站**的 `conv_seq`（adapter 内存里记），重启后首条回复前没有值则跳过。
7. 契约的 `kind !== text` 提示与 ACL 的 guest 档都已实现，但 guest 档要求显式 `GUEST_WORKSPACE_DIR`（契约没写，安全需要）。
