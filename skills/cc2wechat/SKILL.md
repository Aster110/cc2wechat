---
name: cc2wechat
description: 微信 ↔ Claude Code 消息桥（后台常驻 daemon）。长轮询微信 iLink API，收到消息自动开 cc 会话处理并回复。触发词："/cc2wechat"、"启动微信桥"、"cc2wechat 状态"
status: active
---

# cc2wechat

> 微信 ↔ Claude Code 消息桥。收到微信消息 → 拉起 cc 会话处理 → 自动回复。
> 全局命令 `cc2wechat`（npm 包 `@aster110/cc2wechat`），**所有操作走 CLI，不要直接跑仓库里的 dist**。

## 安装（新机器）

```bash
npm install -g @aster110/cc2wechat@latest   # 需 Node >= 22 + Claude Code
cc2wechat skill install                      # 安装本 skill 到 ~/.claude/skills/
```

## 执行步骤

### 1. 查当前状态

```bash
cc2wechat status     # 所有账号 + daemon 运行态 + 端口
```

### 2. 首次登录（每个账号一次）

```bash
cc2wechat login --name <账号名>
```

浏览器弹二维码 → **告知用户**用要绑定的微信扫码确认。凭证存 `~/.cc2wechat/`，之后不需要重复登录。

### 3. 启动 / 停止

```bash
cd <希望 cc 工作的目录>      # start 时的 cwd = cc 的工作目录
cc2wechat start <账号名>     # 不带名字 = 启动全部
cc2wechat stop [账号名]
cc2wechat restart [账号名]
```

端口从 18081 起按账号自动分配，健康检查：`curl -s localhost:<端口>/health`。

### 4. 验证

**告知用户**：给绑定微信发条消息，收到 cc 回复即通。

## 回复微信（cc 处理消息时用）

处理完**必须**回复，用户在微信端等着：

```bash
cc2wechat --text "回复内容"
cc2wechat --image /tmp/screenshot.png
cc2wechat --file /tmp/document.pdf
```

用户说"退出/结束/关闭" → 先回"再见"，再 `cc2wechat --end` 关闭当前会话。

## 常用操作

| 操作 | 命令 |
|------|------|
| 状态总览 | `cc2wechat status` |
| Web 终端（tmux delivery） | `cc2wechat web <账号名>` |
| 改账号名 | `cc2wechat rename <旧> <新>` |
| 看版本 | `cc2wechat --version` |

## 配置（可选）

`~/.claude/channels/wechat-channel/config.json`：

```json
{ "delivery": "auto" }
```

delivery 模式：`auto`（iTerm > tmux > SDK > Pipe 自动检测）/ `terminal` / `tmux`（headless/SSH 用，自动起 ttyd Web 终端）/ `sdk` / `pipe`。

## 注意

- **同一微信号不要在两台机器同时跑 daemon**——long-poll 会抢消息
- **开机自启**用 launchd 托管时，plist 必须带两组 env（LaunchAgent 不继承 shell env）：
  - `PATH` 含 `/opt/homebrew/bin`（否则 daemon spawn cc 时报 `tmux: command not found`）
  - 走代理的网络环境要带 `http_proxy`/`https_proxy` 四件套（否则 cc 报 `API Error: ConnectionRefused`，实为被墙不是本地端口问题）
- launchd 托管的 daemon 用 `launchctl bootout/bootstrap/kickstart` 管理，`cc2wechat stop` 会被 KeepAlive 拉回来
