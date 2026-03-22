# wechat-cc-channel 踩坑经验

> 2026-03-22 首次开发 + 联调

## 一、微信 iLink Bot API 踩坑

### 1. API 发现过程

微信官方给 OpenClaw 做了 `@tencent-weixin/openclaw-weixin` 插件，源码里暴露了完整的 iLink Bot API：

- **Base URL**: `https://ilinkai.weixin.qq.com`
- **CDN URL**: `https://novac2c.cdn.weixin.qq.com/c2c`
- **协议**: HTTP JSON，长轮询

这套 API 跟 OpenClaw 无关，是微信自己的 Bot 平台，可以独立使用。

### 2. QR 登录流程

```
GET /ilink/bot/get_bot_qrcode?bot_type=3
  → 返回 { qrcode: "xxx", qrcode_img_content: "https://..." }

GET /ilink/bot/get_qrcode_status?qrcode=xxx
  → 轮询，返回 { status: "wait"|"scaned"|"confirmed"|"expired" }
  → confirmed 时返回 bot_token + ilink_bot_id
```

**坑 1**: `bot_type=3` 是关键参数，不传或传错值会失败。这个值是从 openclaw 插件源码里找到的（`DEFAULT_ILINK_BOT_TYPE = "3"`）。

**坑 2**: 二维码有效期很短（约 2 分钟），需要自动刷新。openclaw 最多刷新 3 次。

**坑 3**: `qrcode_img_content` 返回的是一个图片 URL，不是 base64。终端渲染用 qrcode-terminal 对这个 URL 生成二维码。

### 3. 消息收发

**getUpdates 长轮询**:
- `POST /ilink/bot/getupdates`
- `get_updates_buf` 是同步游标，首次传空字符串
- 服务端建议的 `longpolling_timeout_ms` 通常是 35000ms
- 客户端超时不算错误，重试即可

**坑 4**: 必须带 `base_info: { channel_version: "1.0.0" }`，否则可能被拒绝。

**坑 5**: Headers 很讲究：
```
Content-Type: application/json
AuthorizationType: ilink_bot_token  // 固定值，不是 Bearer
Authorization: Bearer <token>
X-WECHAT-UIN: <random base64 uint32>  // 每次请求随机生成
```

**坑 6**: `context_token` 极其重要！每条消息带一个 context_token，回复时必须回传。不传就报错。

### 4. sendMessage

- `POST /ilink/bot/sendmessage`
- Body: `{ msg: { to_user_id, context_token, item_list: [{ type: 1, text_item: { text } }] } }`
- 微信有 4000 字符限制，需要分片

### 5. Session 过期

- `errcode = -14` 表示会话过期
- 暂停 5 分钟后重试（openclaw 的策略）
- 不需要重新扫码，用保存的 token 重新 getUpdates 即可

## 二、MCP Server 踩坑

### 6. stderr 不显示给用户

MCP server 是 CC 的子进程，`process.stderr` 输出被 CC 内部捕获为日志，**用户终端看不到**。

所以 login 二维码不能输出到 stderr，必须通过 tool 返回值或开网页展示。

**解决方案**: 启动临时 HTTP server（localhost:18891），弹浏览器显示二维码页面。

### 7. MCP tool 超时

login tool 需要等用户扫码（最长 8 分钟），这会阻塞 tool call。CC 会显示 "running..."，用户可能以为卡了。

**解决方案**: 页面侧定时轮询 `/status`，给用户实时反馈。

### 8. Channel capability

声明 `capabilities.experimental['claude/channel']: {}` 让 CC 识别为 channel。但这是 research preview 功能，可能需要特殊启动参数。

实测：用户级 MCP 配置（`claude mcp add -s user`）也能加载 tools，但 channel notification push 是否被识别需要进一步测试。

## 三、测试结果

| 功能 | 状态 | 备注 |
|------|------|------|
| QR 扫码登录 | ✅ 通过 | bot_type=3，终端二维码可扫 |
| 凭证持久化 | ✅ 通过 | ~/.claude/channels/wechat-channel/accounts.json |
| 收文字消息 | ✅ 通过 | getUpdates 长轮询正常 |
| 发文字消息 | ✅ 通过 | 中英文都 OK |
| 发长消息 | ✅ 通过 | 510 字正常，分片逻辑备用 |
| getConfig | ✅ 通过 | typing_ticket 获取正常 |
| sendTyping | ✅ 通过 | 输入状态指示正常 |
| 收图片消息 | ⏳ 待测 | item.type=2，需要 CDN 解密 |
| 收语音消息 | ⏳ 待测 | item.type=3，voice_item.text 有 ASR 结果 |
| 发图片消息 | ⏳ 待测 | 需要 CDN 上传 + AES-128-ECB 加密 |
| 网页二维码 | ✅ HTTP server 正常 | localhost:18891 |
| MCP tool 调用 | ⚠️ 部分 | login tool 阻塞问题已修（改为网页） |
| Channel push | ⏳ 待测 | notifications/claude/channel 需要开新 CC 测 |

## 四、架构决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 接入方式 | CC Channel (MCP) | 原生集成，不需要额外网关 |
| 微信协议 | iLink Bot API | 微信官方，OpenClaw 已验证 |
| 登录方式 | 网页二维码 | 终端二维码 MCP 下不可见 |
| 凭证存储 | ~/.claude/channels/ | 跟 CC 生态一致 |
| 不用 OpenClaw | 独立实现 | 减少依赖，代码量小（~1000行） |

## 五、待解决

1. **CDN 媒体上传/下载**：图片/文件需要 AES-128-ECB 加密，openclaw 插件有完整实现可参考
2. **Channel notification 实测**：需要用 `--dangerously-load-development-channels` 启动 CC 测试
3. **多账号支持**：当前只支持一个账号
4. **重连机制**：token 失效后是否需要重新扫码？
5. **npm 包发布**：package name、README、license
