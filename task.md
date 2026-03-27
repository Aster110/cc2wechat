# Task: Add TmuxDelivery Support

## 目标

新增 TmuxDelivery，让 cc2wechat 能在 Linux 上通过 tmux 管理 Claude Code 进程。

## 改动文件清单

### 新增
- `src/v5/deliveries/tmux/tmux-cli.ts` — tmux 命令封装
- `src/v5/deliveries/tmux/tmux-sessions.ts` — 会话管理（磁盘持久化）
- `src/v5/deliveries/tmux/tmux-delivery.ts` — Delivery 接口实现

### 修改
- `src/v5/main.ts` — 注册 TmuxDelivery 候选

## 测试计划

1. 编译通过（`npm run build`）
2. tmux 兼容性检查
3. 创建/销毁 tmux session
4. 消息注入（含特殊字符转义）
5. session 存活检测 + 自动重建
6. 并发用户隔离
7. 回归：macOS Terminal Delivery 不受影响

## 验收标准

- [x] 编译无错误 (`npm run build` 零错误)
- [x] 现有 Delivery 代码未修改 (只新增文件 + main.ts 加了 2 行 import/注册)
- [x] Tmux Delivery 在 Mac 上可强制启用并正常工作 (13 项 tmux 测试全通过)
- [x] 代码风格与现有代码一致
- [x] 无命令注入风险 (使用 tmux load-buffer + paste-buffer 方式注入文本，不经过 shell 解释)
- [x] 测试全部通过 (227/227 tests passed, 17 test files)

## 验收完成: 2026-03-26

---

## 端到端验证发现的 Bug 与修复（2026-03-27）

### Bug 1: ESM 中 `require('node:fs')` 不可用
- **现象**：`tmux-cli.ts` 使用 `const fs = require('node:fs')`，运行时报 `require is not defined`
- **原因**：项目 `"type": "module"` 是 ESM，`require()` 只在 CJS 可用
- **陷阱**：vitest 测试环境自动提供 CJS 兼容，所以测试全过但运行时挂
- **修复**：改为顶部 `import fs from 'node:fs'`

### Bug 2: 首条消息注入过早
- **现象**：Claude Code TUI 启动后 3s 内还没准备好接受输入，首条消息丢失
- **修复**：`_createTmuxSession` 中 sleep 从 3s 改为 10s

### Bug 3: sendToSession catch 块静默吞错误
- **现象**：`sendToSession` 失败时只返回 false，无任何日志
- **修复**：catch 块加了 `console.error` 输出 session 名和错误信息

### Bug 4: iLink session 过期
- **现象**：长时间不用后 iLink 登录态过期，需重新扫码
- **处理**：运维层面注意，非代码 bug

### Bug 5: 并发消息竞态条件（代码审查发现）
- **现象**：同一用户两条消息同时到达，都通过 findSession=null 检查，都调用 `_createTmuxSession`
- **原因**：`_createTmuxSession` 有 10s sleep，窗口内第二条消息也会触发创建，覆盖第一个 session
- **修复**：加 `creatingUsers` Set 作为轻量锁，第二条消息等待创建完成后注入

### Bug 6: shutdown() 不清理 session store（代码审查发现）
- **现象**：`shutdown()` kill 了 tmux 进程但没清理内存和磁盘 session 记录
- **影响**：重启后从磁盘加载已死的 session 记录，直到 cleanupStale 触发才清理
- **修复**：shutdown 后遍历 destroySession 清理磁盘文件

### Bug 7: cleanupStale 不 kill tmux 进程（代码审查发现）
- **现象**：`cleanupStale()` 只从 Map/磁盘删除过期 session 记录，不调用 `killTmuxSession`
- **影响**：过期用户的 tmux 进程变成孤儿，占用资源直到手动清理
- **修复**：cleanupStale 删除前先 kill tmux session

### Bug 8: buffer 临时文件 Date.now() 潜在碰撞（低风险）
- **现象**：`sendToSession` 的 tmpFile 用 `Date.now()` 命名，同毫秒两次调用会写同一文件
- **影响**：极低概率下两条消息内容互相覆盖
- **建议**：加 `Math.random()` 后缀或用 `crypto.randomUUID()`，暂不修复

---

## v5.0.2 新增功能（2026-03-28）

### ttyd Web Terminal 集成
- [x] daemon 启动时自动为 tmux session 启动 ttyd Web Terminal
- [x] `cc2wechat web [name]` 命令：在浏览器中打开 Web Terminal
- [x] `cc2wechat --version` 显示版本号
- [x] ttyd 使用 `-W` 参数启用可写模式（ttyd 1.7.7+ 默认只读）

### 验收状态
- [x] 编译通过 (`npm run build`)
- [x] 踩坑文档已补充（ttyd 只读模式、端口冲突）
- [x] README 架构图已更新（含 ttyd Web Terminal）
- [x] README 加 Web Terminal 使用说明 + --version 说明
