---
name: waku-dm
description: 你正在通过 Waku 私聊跟一个真人对话（提示词以 `[Waku私聊 conv=…]` 开头）。这条 skill 说明：收到的图片/视频/语音怎么读、怎么把图片/视频/语音/playable 卡片发回去、以及"做一个 playable 发给他玩"的标准流程。触发条件：正文里出现 `[Waku私聊 conv=`、`[Image: `、`[Card: `，或用户让你"发张图/发个视频/做个小游戏发我"。
status: active
---

# Waku 私聊通道（waku-dm）

用户在 Waku App 的好友列表里给你发私信，本机 daemon 把它交给你，你的回复会以「AI 好友」的身份回到同一条私聊。

**怎么认出来**：你收到的正文以 `[Waku私聊 conv=<conversation_id>] ` 开头。那个 `conversation_id` 后面要用（回环 CLI 的 `--conversation`）。

---

## 1. 收到的媒体：直接读，路径就在正文里

daemon 已经把媒体下载到本机，正文里给你的是**真实路径**：

| 你看到的 | 意思 | 你该做什么 |
|---|---|---|
| `[Image: /Users/…/media/conv_…/cmsg_…-0.png]` | 一张图片，已落盘 | 直接看（多模态输入已自动挂上）或用工具读它 |
| `[Video: /…/….mp4]` | 一段视频 | 文件已落盘；要看细节自己用 ffmpeg 抽更多帧 |
| `[VideoFrame: /…/….frame.jpg]` | 上面那段视频的一帧（daemon 自动抽的） | **已作为图片输入挂上，你直接就看得见画面**；没有这一行说明本机没装 ffmpeg |
| `[Voice: /…/….m4a]` | 一段语音 | 已作为音频输入挂上；也可以自己转写 |
| `[Image]`（没有路径） | 下载失败了 | 告诉用户"这张图我没收到，再发一次？" |
| `[Card: 弹球 content_id=cnt_… share_url=…]` | 用户分享了一个 playable | 想了解它就用 `waku` CLI 按 content_id 查 |

媒体文件 **24 小时后会被自动清理**。要长期保留的东西，自己复制到别处。

---

## 2. 发出去：两种方式，选一种

### 方式 A：在最终回复里写标记（最省事）

把标记直接写进你这一轮的最终答复正文，daemon 会解析、发送，并把标记从用户看到的文字里剥掉：

```
做好了，你看看效果
[[send-image: /Users/me/waku-creations/pong/cover.png]]
```

全部词法：

| 标记 | 作用 |
|---|---|
| `[[send-image: /abs/path.png]]` | 发图片（PNG / JPEG / GIF / WEBP） |
| `[[send-video: /abs/path.mp4]]` | 发视频。**默认会先转成手机能播的规格**：≤60 秒、≤720p、H.264 + AAC，并自动抽封面、量时长。源本来就合规就原样发；超 60 秒会截断，daemon 会在正文里替你说明 |
| `[[send-audio: /abs/path.m4a]]` | 发语音（**需要 ffprobe**；量不出时长会明确告诉你没发出去） |
| `[[send-card: cnt_xxx]]` | 发一张 playable 卡片 |
| `[[send-card: cnt_xxx launch_ctx={"room":"ABCD"}]]` | 卡片 + 启动上下文（值必须是字符串） |
| `[[send-file: /abs/path.pdf]]` | 发文件。Waku 私聊没有"文件"消息类型，所以 daemon 会把它传上去、再发一条**带公开链接**的文字消息（`📎 名字（大小）` + URL），用户点开就能下 |

规则：**路径必须是绝对路径**；附件先发、剩下的文字后发；一条回复里可以有多个标记，按出现顺序发。

**`[[send-file:]]` 能发哪些类型**：`.pdf` `.zip` `.txt` `.log` `.md` `.csv` `.json`（`.jsonl` / `.ndjson` / `.markdown` / `.tsv` 也算）。
其它类型（`.html` / `.js` / `.svg` / `.py` / 可执行文件…）发不出去，daemon 会回一句「这个类型的文件发不了……先留在本机：<路径>」。
- **想发一个 HTML 页面/小游戏？别用 `[[send-file:]]`**——把它 `waku ship` 成 playable，然后 `[[send-card: cnt_…]]`（见第 3 节）。那才是它该走的路。
- 想发别的类型：打包成 `.zip` 再发。

### 方式 B：干活到一半就发（回环 CLI）

一轮还没结束、但想先把东西发过去时用它：

```bash
waku-dm-reply --text "先给你看个中间结果"
waku-dm-reply --image /tmp/shot.png --caption "第一版"
waku-dm-reply --card cnt_abc --launch-ctx '{"room":"ABCD"}'
waku-dm-reply --file /tmp/report.pdf --caption "跑完的报告"
waku-dm-reply --conversation conv_01J… --video /tmp/demo.mp4 --text "跑起来了"
```

不带 `--conversation` 时，daemon 用"当前唯一正在跑的那一轮"的会话。**同时有多轮在跑就会报错**——那时候把提示词前缀里的 `conv=…` 抄上去即可。

---

## 3. 做一个 playable 发给他玩

用户说"给我做个小游戏 / 做个小工具"时的标准流程。**内容目录放 `~/waku-creations/<slug>`，不要在产品仓里建。**

```bash
# 1. 拉初始代码仓（模板 + runtime 契约）
mkdir -p ~/waku-creations && cd ~/waku-creations
waku initial_repo pull pong

# 2. 在 ~/waku-creations/pong 里写你的 HTML/JS（runtime.js 的用法见 waku skill）
cd pong && ... # 开发、自测

# 3. 发布。--visibility public 是能被分享成卡片的前提
waku ship . --name "弹球" --visibility public --json
#   ↑ 新命令；这台机器上没有的话退回：
#     waku publish . --name "弹球" --visibility public --json

# 4. 从 --json 的输出里读回 content_id（形如 cnt_…）
```

拿到 `content_id` 之后，在最终回复里：

```
做好啦，点开就能玩
[[send-card: cnt_abc123]]
```

**卡片发不出去时的唯一常见原因**：内容不是 `live`，或 `visibility` 是 `private`。daemon 会替你回一句
「内容不可分享（私有或不存在），请用 `--visibility public` 重新发布」——看到这句就回去重新发布，别反复重试。

---

## 4. 会话命令（用户会发给你，你不用处理）

`/new`（开新对话）、`/stop`（停当前任务）、`/exit`、`/help` 由 daemon 直接接管，不会到你这里。

## 5. 边界

- 单条正文上限 4000 字符，超了 daemon 会自动切片——你不用自己切。
- 入站图片 ≤16 MiB，视频/语音 ≤100 MiB；超限的用户会看到 `[Image]`（无路径）。
- 出站单个文件 ≤200 MiB（含视频、附件）。超了 daemon 会回一句人话，不会发。
- 别在回复里贴本机绝对路径给用户看：路径是给标记用的，标记会被剥掉，但你自己写在正文里的路径不会。
