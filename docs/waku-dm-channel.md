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
| `channels/waku-dm/adapter.ts` | ChannelAdapter：入站过滤与游标、出站切片与回执映射、心跳与 health、慢回执、媒体标记 |
| `channels/waku-dm/media-store.ts` | 入站媒体落盘：体积 / 时限 / TTL 三道闸，扩展名判定，失败降级 |
| `channels/waku-dm/media-probe.ts` | 出站媒体探测：图片头读宽高（纯函数）、ffprobe 取时长/宽高、ffmpeg 抽封面与可选转码 |
| `channels/waku-dm/attachment-sender.ts` | 一条附件 → 一条真消息：上传（带缓存）+ 按 kind 组 payload + 失败分类 |
| `core/attachments.ts` | `[[send-…]]` 标记词法（通道无关，Agent 面向的公开契约） |
| `reply-cli.ts` | `waku-dm-reply`：回环 HTTP 中途发图/发卡；不猜会话 |
| `core/identity.ts` | `IdentityResolver` 策略：V1 = pairing 行现查；waku-dm = `OWNER_USER_IDS` ACL |
| `core/ingress.ts` | 明文信封分支：receipt 幂等 → 命令（/new /stop /exit /help）或 turn；服务端代数 |
| `core/dm-commands.ts` | 命令词表（复用 v6 `matchCommand`）与回执文案 |
| `bootstrap/waku-dm.ts` | 配置读取 + 组装 + `[turn]` 日志接线 |

## 三幕

1. **入站**：SSE 帧 `event: chat.message` → 解析 `data`（单行 JSON）→ 过滤：自回显（sender = 马甲）、非 dm、已撤回、
   `source=agent_bridge`（别的 bot）、冷启动旧历史（无游标且 `created_at < 启动−60s`）。
   `text` / `image` / `video` / `voice` / `playable_card` 五种 kind 都进处理链（媒体先下载，见「媒体与附件协议」）；
   其余（sticker / 未知）回一句提示（每会话 60s 一次）。剩下的变成
   `{channel:'waku-dm', routeId: conversation_id, messageId, principalRef: sender_user_id, text, mediaPaths}` 交给 Core。
   **游标只在 sink 返回后推进**（落在 V1 的 `mailbox_cursors` 表，collection=`waku_dm_user_events`，`last_created_at` 列存 user_seq）。
2. **Core**：`AclIdentityResolver` 判 owner → admin endpoint（`isAdminPrincipal` 再判一次，两道闸）；陌生人默认 deny（静默：不留 receipt、不回话）。
   `inbox_receipts(pairingId=sender, messageId)` 去重。文本命令翻成 control：`/stop` → 抢占 abort；`/new` `/exit` → **同会话提代**
   （`startNew(previousConversationId === conversationId)` → generation+1，旧 codex thread binding 失效，队列清空）；`/help` → 直接回文本。
   普通文字 → turn，代数由服务端记（`authorize()` 现查），Waku 会话 id 不变。
   交给 Agent 的正文带前缀 `[Waku私聊 conv=<conversation_id>] `（类比微信通道的 `[微信]`）——Agent 靠它才能用
   `waku-dm-reply --conversation <id>` 中途发图/发卡。
3. **出站**：orchestrator 的 `final`/`error` → CoreDelivery 先落 outbox → adapter `send()`：
   **先发附件**（每条一个 `client_msg_id = <messageId>:att<i>`），再发正文（`stripMarkdown` + 按字符 ≤3900 切片，
   `client_msg_id = <messageId>` 或 `<messageId>:<index>`）；服务端 `UNIQUE(sender, client_msg_id)` ⇒ 重投幂等 → 发完 `POST …/read`。
   `progress`/`ack`/`status` 在私聊里没有对应物，直接 `sent`。

回执映射：2xx → `sent`；429（读 `Retry-After`）/ 5xx / 408 → `retryable`；401 → 换 token 重放一次，仍 401 → `retryable`；
403（`not_friends`/`not_member`）/ 404 / 400 → `permanent-failure`；写请求网络断 → `unknown`（可能已落库，原 id 重投）。


## 媒体与附件协议

### 入站：URL → 本机路径 → Agent

平台在 `chat.message` 帧里给的是**匿名可 GET 的公开 GCS URL**（`image.url` / `payload.url`）。
Agent（codex）只吃本机路径，所以 daemon 下载它。

| kind | 帧里的字段 | 下载 | 进 Core 的正文标记 |
|---|---|---|---|
| `text` | `body` | — | 原文 |
| `image` | `image: {asset_id,url,width,height}` | ✅ | `[Image: /abs/path.png]`（失败 → `[Image]`） |
| `video` | `payload: {asset_id,url,width?,height?,duration_ms?,poster_url?}` | ✅ | `[Video: /abs/path.mp4]` |
| `voice` | `payload: {asset_id,url,duration_ms,waveform?}` | ✅ | `[Voice: /abs/path.m4a]` |
| `playable_card` | `card: {content_id,title,cover_url,author_name,project_id,share_url}` | ❌（没有二进制） | `[Card: <title> content_id=cnt_… author=… share_url=…]` |
| 其它（`sticker`…） | — | — | 不进 Core，回一句提示（每会话 60s 一次） |

标记词汇与微信通道的 `extractText` **同源**（`[Image: path]`），Agent 已经认得。有 caption 时
caption 在前、标记在后，换行分隔。路径同时进 `mediaPaths` 一路贯通到 `RunnerRequest`，
codex app-server 的 `buildTurnInput` 据此发出 `localImage` / `localAudio` 块。

落盘位置 `<state>/media/<conversation_id>/<message_id>-<idx>.<ext>`（0700 目录 + 0600 文件），
扩展名判定顺序：`Content-Type` → 魔数 → 按 kind 兜底。**三道闸**：

| 闸 | 值（env 可调） | 行为 |
|---|---|---|
| 体积 | 图片 16 MiB / 音视频 100 MiB | 先看 `Content-Length` 直接拒；没有就边读边数，超了立刻掐断并删半截文件 |
| 时限 | 60s | `AbortSignal.timeout`；挂住的连接会堵死整条 SSE 消费链（`handleFrame` 是串行 await 的） |
| 寿命 | TTL 24h | 启动扫一次 + 每小时扫一次，删过期文件与空目录 |

**下载失败不丢整条消息**：退化成无路径标记（`[Image]`），用户说的话照样进 Agent。

### 出站：标记词法（Core 级，通道无关）

Agent 只会说话，所以最终文本里的标记就是它唯一的出口。解析在 `core/attachments.ts`，
不同通道看到的是同一套词；解析后标记从正文剥离，剩下的文字照常发。

| 标记 | 平台 kind | 说明 |
|---|---|---|
| `[[send-image: /abs/path]]` | `image` | 宽高由本机读文件头（PNG/JPEG/GIF/WEBP），读不出就不带 |
| `[[send-video: /abs/path]]` | `video` | 有 ffmpeg 时抽第一帧当封面（自己也是一次 asset 上传）+ ffprobe 取宽高/时长；没有就原样发并日志告警 |
| `[[send-audio: /abs/path]]` | `voice` | **需要 duration_ms**；ffprobe 取不到就**不发**，改回一句人话（发出去必然 422） |
| `[[send-card: cnt_x]]` / `[[send-card: cnt_x launch_ctx={"room":"AB"}]]` | `playable_card` | 内容必须 `live` 且 `visibility ∈ {public, friends}` |
| `[[send-file: /abs/path]]` | —（Waku 没有 file kind） | 不发，回一句"文件留在本机 `<path>`" |

出站单文件上限 200 MiB（`WAKU_GATEWAY_MAX_UPLOAD_BYTES`）：multipart 上传要把整个文件读进内存，
没有这道闸的话 Agent 一句 `[[send-video: /path/to/4GB.mov]]` 就能把 daemon 撑爆——超限当场回一句人话，不上传。

`AgentEvent.final.mediaFiles` 也会合流（按扩展名判类型），mediaFiles 在前、标记在后，同一路径只发一次。
不认识的标记（`[[send-sticker: …]]`）原样留在正文——宁可难看也不静默吞掉 Agent 想说的话。

**发送顺序**：附件先发、正文后发。`client_msg_id = <messageId>:att<i>`，与文本分片的 `<messageId>:<i>` 不会撞。

**上传路由按身份分家**：bridge 模式 `POST /agent-bridges/me/assets`，session 模式 `POST /assets`（都是 multipart，字段名 `file`）。
415 / 413 → `permanent-failure`；429 读 `Retry-After` → `retryable`；网络断 → `unknown`。

**重投不重复上传**：上传成功、发送失败是最常见的一种失败（没有缓存的话一个 80 MB 的视频会被重传一遍）。
上传结果落 SQLite `asset_uploads` 表，key = `绝对路径:大小:mtime`，TTL 24h。
> 与任务书原话「在 outbox 行里缓存 asset_id」的**取舍差异**：改用独立表，是为了不让通道去写 Core 的 outbox 载荷
> （outbox 行的 `messageId` + `payload` 是投递层的不变量），同时天然获得跨消息去重。

**卡片不可分享**（private / 未发布 / 不存在 → 404 `content_not_found`）：不当失败重投，
直接回一句「内容不可分享（私有或不存在），请用 `--visibility public` 重新发布」。

### 回环回复 CLI（`waku-dm-reply`）

一轮结束时的 final 只能说一次话；干活到一半想先发张图就用它。

```bash
waku-dm-reply --text "先给你看个中间结果"
waku-dm-reply --image /tmp/shot.png --caption "第一版"
waku-dm-reply --card cnt_abc --launch-ctx '{"room":"ABCD"}'
waku-dm-reply --conversation conv_01J… --video /tmp/demo.mp4 --text "跑起来了"
```

- 传输：`POST http://127.0.0.1:<health-port>/admin/reply`，与 `/admin/pair-grant` 同一个**只听 127.0.0.1** 的运维口。
- 端口发现：`WAKU_GATEWAY_HEALTH_PORT` → `<state>/health.port`（daemon 启动时写、退出时删）→ 缺省 `18092`。
- **不猜会话**：不给 `--conversation` 时只认「当前**恰好一条**正在跑的 turn」；0 条或多条一律 400 并要求显式指定。
  （微信版 `cc2wechat-reply` 按 ctx 目录 mtime 猜"当前会话"，两个人同时聊天会串人——这里刻意不照搬。）
- 走与 Agent final **同一条**出站路：落 outbox → `adapter.send`，同一套幂等与回执；`messageId = reply:<uuid>`，
  于是 `client_msg_id` 形如 `reply:<uuid>` / `reply:<uuid>:att0`。
- `--text` 里写的 `[[send-…]]` 标记同样会被解析并剥离。

### 给 Codex 的用法说明

`skills/waku-dm/SKILL.md` 随包分发：`cc2wechat skill install waku-dm`（不带名字 = 装全部 bundled skill）。
里面写清了收到的路径怎么读、两种发送方式、以及"做一个 playable 发给他玩"的标准流程
（`waku initial_repo pull` → 构建 → `waku ship … --visibility public --json` → 读回 `content_id` → `[[send-card: cnt_…]]`，
内容目录默认 `~/waku-creations/<slug>`）。

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
| `WAKU_GATEWAY_MEDIA_DIR` | 入站媒体落盘根目录 | `<STATE_DIR>/media` |
| `WAKU_GATEWAY_MEDIA_IMAGE_MAX_BYTES` | 入站图片体积上限 | `16777216`（16 MiB） |
| `WAKU_GATEWAY_MEDIA_MAX_BYTES` | 入站视频 / 语音体积上限 | `104857600`（100 MiB） |
| `WAKU_GATEWAY_MEDIA_TIMEOUT_MS` | 单次下载时限 | `60000` |
| `WAKU_GATEWAY_MEDIA_TTL_MS` | 媒体文件寿命 | `86400000`（24h） |
| `WAKU_GATEWAY_MEDIA_SWEEP_INTERVAL_MS` | 清理周期 | `3600000`（1h） |
| `WAKU_DM_VIDEO_TRANSCODE` | `1` = 出站视频转 720p H.264 并截断到 `MAX_VIDEO_SECONDS`（需要 ffmpeg） | 关 |
| `WAKU_GATEWAY_MAX_VIDEO_SECONDS` | 转码时的截断长度 | `60` |
| `WAKU_GATEWAY_MAX_UPLOAD_BYTES` | **出站**单文件上限（上传要整个读进内存；超了回一句人话不发） | `209715200`（200 MiB） |
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
# 媒体金线（图进 → Codex 念出图里的暗号 → 图出）
PERSONA_USER_ID=<persona_user_id> node scripts/golden-e2e-dm-media.mjs

# 中途发图（daemon 在跑时，任意终端都能打）
waku-dm-reply --image /tmp/shot.png --text "看这个"     # 或 node dist/gateway/reply-cli.js
```

`/health` 的 `channel` 块：`{type:'waku-dm', state: running|degraded|disabled|stopped, cursor, lastEventAt, lastHeartbeatAt,
reconnects, tokenState: ready|stale|degraded|unloaded, selfUserId, sseState}`；`credential` 块：`{mode, ok, state, expiresInSec}`。

## 日志四件套

| 事件 | 形状 |
|---|---|
| 入站 | `<- usr_8c8b: 请只回答这个暗号本身：ZX123456`（sender 前 8 字符 + 正文前 50 字符） |
| 每轮 | `[turn] conv=conv_01J0 agent=codex queue=3ms first=812ms total=4021ms outcome=final` |
| 传输 | `sse stream ended cleanly, reconnecting in 1000ms` / `sse rejected (http_401); credentials invalidated…` / `sse no bytes for 30000ms…` / `sse connect failed (network:TypeError), retry in 2000ms (failures=1)` |
| 发送失败 | `send failed conv=conv_01J00000 msg=0198f4c1 chunk=1/1: not_friends (HTTP 403)` / `… attachment=1/2 (image): unsupported_media_type` |
| 媒体入站 | `   media image 84213B -> /Users/…/media/conv_…/cmsg_…-0.png` / `media too large cmsg_…#0: 22000000B > 16777216B (image); skipped` |
| 媒体出站 | `   asset cache hit shot.png -> ast_000123` / `   video without ffmpeg: sending clip.mp4 with no poster and no duration` |

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
| Codex 说"我没看到图" | 正文里是 `[Image]` 还是 `[Image: /path]` | 无路径 = 下载失败，看日志 `media download failed` / `media too large`；有路径就是 Agent 侧问题 |
| 语音发不出去，用户收到"装个 ffmpeg 就能发了" | 本机没有 ffprobe | `brew install ffmpeg`；平台要求 voice 必带 `duration_ms`，量不出来就不发（发出去必然 422） |
| 视频发出去没有封面 | 同上，本机没有 ffmpeg | 同上；没有 ffmpeg 时视频**照发**，只是少封面少时长 |
| 卡片发不出去，回「内容不可分享」 | 内容不是 live 或 `visibility=private` | `waku publish … --visibility public` 重新发布后再分享；重试没用 |
| `waku-dm-reply` 说 `no turn is running` / `2 turns are running` | 会话推断刻意不猜 | 把提示词前缀里的 `conv=…` 抄成 `--conversation <id>` |
| `waku-dm-reply` 连不上 | daemon 没跑 / 端口没发现 | 看 `<state>/health.port`；或显式 `WAKU_GATEWAY_HEALTH_PORT=18092` |
| 盘上媒体越积越多 | TTL 没生效（daemon 一直没重启且 sweep 出错） | `curl 127.0.0.1:18092/health` 确认 daemon 活着；手动删 `<state>/media/` 安全（Agent 只在当轮用它） |

## 与契约的偏差（实现时的最小改动决策）

1. `InboundEnvelope` 做成 `waku | waku-dm` 的判别联合，而不是单一形状加可选字段：V1 代码与 532 个测试的类型零改动。
2. `/new` = `ConversationService.startNew(previousConversationId === conversationId)` 的 renew 分支（同会话 generation+1）。
   V1 客户端从不发这种形状（它们 new 时总铸新 id），原「重开已有会话被拒」语义原样保留。
3. 游标复用 `mailbox_cursors` 表（不加 migration）：`last_created_at` 列承载 user_seq。
4. `progress` 仍会经 outbox（Core 不知道通道能力）→ adapter 立刻 `sent`；outbox 行数会随 Codex 进度事件增长（V1 同样不 GC），登记为债。
5. 慢回执与「只支持文字」提示直发 REST、不走 outbox：一次性提示丢了没代价，重投反而刷屏。
6. 出站 `final` 后的 `POST /read` 用该会话**最后一条入站**的 `conv_seq`（adapter 内存里记），重启后首条回复前没有值则跳过。
7. ACL 的 guest 档已实现，但要求显式 `GUEST_WORKSPACE_DIR`（契约没写，安全需要）。
8. **契约原写的「非文字消息一律回『暂时只支持文字』」已收窄**：`image` / `video` / `voice` / `playable_card`
   现在都进处理链（见「媒体与附件协议」），提示只留给 `sticker` 与未知 kind。
9. 出站附件的 asset 缓存用独立的 `asset_uploads` 表，不是把 asset_id 写回 outbox 行的载荷里
   （理由见「媒体与附件协议 → 重投不重复上传」）。
10. 回环回复口 `POST /admin/reply` 是本仓新增的运维接口（契约里没有），只听 127.0.0.1，
    入参走白名单解析——"本机进程"不等于"我们写的进程"。
