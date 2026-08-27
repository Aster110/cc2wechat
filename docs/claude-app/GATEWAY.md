# claude-app 网关契约

`claude-app` 后端让微信消息驱动 **Claude desktop app 里的会话**。这条链上有一段没法用代码走完 ——
往 app 会话里投消息只能由另一个 app 会话调 `ccd send_message`。那个专职投递的 app 会话就是**网关**。

本文是网关的岗位说明书:它订什么、干什么、怎么回话、死了怎么复活。

```
微信 → cc2wechat daemon ──SSE──► 网关会话(app 内,唯一)
                                    │ ccd send_message(收件箱 localId, 信封文本)
                                    ▼
                         收件箱会话 ×N(每联系人一个,冷了自动唤醒)
                                    │ 回复落 ~/.claude/projects/<slug>/<CLI-id>.jsonl
                                    ▼
                    daemon 的 TranscriptWatcher(零 token 轮询)→ 微信
```

**网关只做投递,不做回程。** 回复由 daemon 直接读 transcript 取回 —— 网关每条消息只烧一个
极小的 turn,而且回程完全是确定性代码,不受模型发挥影响。

---

## 1. 端点

全部挂在 daemon 的健康检查端口上(默认 18081),**只听 127.0.0.1**。

| 方法 | 路径 | 谁调 | 内容 |
|---|---|---|---|
| GET | `/claude-app/events` | 网关 | SSE 长连接,daemon 从这里下发事件 |
| POST | `/claude-app/ack` | 网关 | `{jobId, ok, error?}` — inject 的回执 |
| POST | `/claude-app/resolve` | 网关 | `{jobId, cwd, localId\|null}` — resolve 的回报 |
| GET | `/claude-app/status` | 运维 | 连接数 / 在途 job / 上次回执延迟 |
| POST | `/claude-app/test-send` | 运维 | `{text, conversationId?}` — 不连微信驱动全链 |

SSE 帧就是一行 `data: <JSON>` + 空行。事件类型:

| 事件 | 网关动作 | 回执 |
|---|---|---|
| `{"type":"hello","protocol":1,"heartbeatMs":480000}` | 无(确认自己在班上) | 无 |
| `{"type":"inject","jobId","localId","text"}` | `ccd_session_mgmt.send_message(session_id=localId, message=text)` | `POST /claude-app/ack {jobId, ok:true}`;失败就 `{jobId, ok:false, error:"原因"}` |
| `{"type":"resolve","jobId","cwd"}` | `list_sessions`,找 cwd 等于这个值的会话 | `POST /claude-app/resolve {jobId, cwd, localId}`;找不到就 `localId: null` |
| `{"type":"heartbeat","seq"}` | **什么都不做**(这个 turn 本身就是保活) | 无 |

### 铁律

1. **一个事件 = 一个 turn = 一个工具调用 = 一个回执。** 别顺手做别的事,别把两个事件合并处理。
   非确定性压到最小是这套设计的地基。
2. **`jobId` 是去重键。** 网关重连时 daemon 会**补投**没收到回执的 job;
   同一个 `jobId` 你已经投过了就直接回 ack,别投第二次(用户会收到两条一样的回复)。
3. **`text` 原样投,一个字都别改。** 里面的 `job:<id>` 是 daemon 取回复用的锚点。
4. **失败也要回执。** 沉默 = daemon 等到超时(默认 120s)才知道你出事了,微信那头白等两分钟。

---

## 2. 值班(挂上去)

在 app 里开一个专职网关会话(播种方式同收件箱,见 [SEEDING.md](SEEDING.md)),然后对它说:

> 你现在是 cc2wechat 的 **claude-app 网关**。规则:
>
> 1. 用 `Monitor({command: "curl -sN http://127.0.0.1:18081/claude-app/events", persistent: true})`
>    挂住事件流,持续值班。
> 2. 每收到一行 `data: {...}`,按 type 只做一件事:
>    - `inject` → `ccd_session_mgmt.send_message(session_id=<localId>, message=<text 原样>)`,
>      然后 `curl -s -X POST http://127.0.0.1:18081/claude-app/ack -H 'Content-Type: application/json' -d '{"jobId":"<jobId>","ok":true}'`。
>      send_message 报错就把 ok 改成 false 并把错误原文放进 error 字段。
>    - `resolve` → `ccd_session_mgmt.list_sessions`,找 cwd == `<cwd>` 的那个会话,
>      `curl -s -X POST .../claude-app/resolve -d '{"jobId":"<jobId>","cwd":"<cwd>","localId":"local_xxx"}'`;
>      找不到就 `"localId": null`。
>    - `heartbeat` → 什么都不做。
> 3. 同一个 jobId 只投一次(daemon 重连会补投,别重复投递)。
> 4. `text` 原样转发,不要改写、不要总结、不要加前缀。
> 5. 别在这个会话里干别的活 —— 它是岗哨,不是工位。

值班中的自检:`curl -s http://127.0.0.1:18081/claude-app/status` 应该看到 `"connected": true`。

## 3. 重挂(死了之后)

**它一定会死。** app 的 WarmLifecycle 空闲 900s 会主动放倒引擎进程,网关会话里的
Monitor / 后台任务 / 订阅**全部跟着死**。这是设计如此,不是 bug。

对策分两层:

- **daemon 侧**:每 8 分钟(`heartbeatMs`,可配)推一个 heartbeat 事件。Monitor 收到事件会让网关跑一个
  微 turn —— 只要这个 turn 算"活动",空闲计时就被顶回去了。
  > ⚠️ **待实测确认**:Monitor 事件到底算不算活动、能不能重置 WarmLifecycle 计时。
  > 若实测发现不算,把间隔压到 15 分钟以内、并且改成**模型自己发一个 turn**(而不是纯 Monitor 回调),
  > 结论回填到 `2-Projects/P134-714C远程开发机/`。
- **人侧**:daemon 看到 SSE 断开会打一行 `[claude-app] 网关掉线`。人只要对网关会话说一句
  **「值班」**,让它重新执行第 2 节那段 Monitor 命令即可。断线期间没 ack 的 job 会被自动补投。

重挂之后确认三件事:

```bash
curl -s http://127.0.0.1:18081/claude-app/status   # connected: true
cc2wechat claude-app status                        # 探针全绿
curl -s -X POST http://127.0.0.1:18081/claude-app/test-send \
  -H 'Content-Type: application/json' -d '{"text":"值班自检,回一句 ok"}'
```

## 4. 故障对照表

| 现象 | 错误码 | 真相 | 怎么办 |
|---|---|---|---|
| 微信收到「网关会话不在线」 | `claude-app-gateway-offline` | SSE 一条连接都没有 | 去 app 说「值班」重挂 |
| 微信收到「网关 xxx ms 没有回执」 | `claude-app-ack-timeout` | 事件发出去了,网关没回 | 网关引擎可能被放倒了 / Monitor 卡住;重挂 |
| 微信收到「等回复超时…收件箱收到了但一直没答完」 | `claude-app-turn-timeout` | 投递成功,收件箱那轮没跑完 | 看 app 里那个收件箱是不是卡在权限弹窗 / 被人接管了 |
| 「消息已排队,但收件箱一直没轮到它」 | `claude-app-turn-timeout` | 收件箱正忙上一轮 | 等,或者去 app 里看它在干嘛 |
| 「网关在 xxx 找不到会话」 | `claude-app-unresolved-inbox` | 深链开了草稿但没人敲首条 | 见 [SEEDING.md](SEEDING.md) 第 3 步 |
| 「没有可用的收件箱会话」 | `claude-app-no-inbox` | 一个都没播种 | `cc2wechat claude-app seed --name <名字>` |
| 回复内容明显是别人的 | `claude-app-turn-skipped` | 同一收件箱两条消息挤在一起 | 正常保护:这轮宁可报错也不发错人的回复 |

## 5. 降级

分两类,别混:

- **通道级故障**(网关不在线 / 一个收件箱都没有)→ 这一轮自动降级到 codex 后端,日志明示。
  微信那头照样有人答,只是答的是 codex。关掉:`CC2WECHAT_CLAUDE_APP_FALLBACK=off`。
- **单轮故障**(send_message 被拒 / 回程超时)→ **不降级**,如实报错。
  用户以为在跟 A 说话结果 B 答了,比报错更糟。

## 6. 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `CC2WECHAT_BACKEND=claude-app` | — | 启用本后端(`claude-desktop` 是别名) |
| `CC2WECHAT_CLAUDE_APP_GATEWAY_WAIT_MS` | 5000 | 网关不在线时,愿意等多久让它重挂 |
| `CC2WECHAT_CLAUDE_APP_TURN_TIMEOUT_MS` | 180000 | 一轮回程的硬超时 |
| `CC2WECHAT_CLAUDE_APP_FALLBACK` | 开 | `off` = 通道级故障也不降级,如实报错 |
| `CC2WECHAT_CLAUDE_APP_TEST_SEND` | 开 | `0` = 关掉 `/claude-app/test-send` |

## 7. 版本脆弱性

`ccd send_message`、`claude://code/new` 深链、`~/.claude/sessions/` 注册表、transcript jsonl 的
`stop_reason` 字段 —— **全是 app 内部实现,没有兼容承诺**。已实测通过的版本记在
`src/v6/claude-app/probe.ts` 的 `VERIFIED_APP_VERSIONS`。

app 升级之后先跑 `cc2wechat claude-app status`:版本漂移会 warn。真出事的表现通常是
「消息发出去石沉大海」,这时看 `/claude-app/status` 的 `lastAckMs` 和探针输出定位是哪一段断了。
