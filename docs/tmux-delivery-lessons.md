# Tmux Delivery 踩坑经验

开发 TmuxDelivery 过程中遇到的坑，留给后来人。

## 1. require vs import — vitest 会掩盖 ESM 错误

**场景**：项目 `"type": "module"` 是 ESM，但代码里写了 `const fs = require('node:fs')`。

**陷阱**：vitest 自动提供 CJS 兼容层，测试环境下 `require()` 正常工作。227 个测试全绿，部署后运行时直接炸：`ReferenceError: require is not defined`。

**教训**：
- ESM 项目里永远用 `import`，不要用 `require()`
- vitest 通过测试不代表 ESM 兼容性没问题
- 可以在 CI 里加一步 `node --input-type=module -e "import('./dist/xxx.js')"` 做冒烟检查

## 2. Claude Code TUI 启动需要 10s+ 才能接受输入

**场景**：`createTmuxSession` 创建 tmux session 并启动 `claude` 命令后，立即通过 `sendToSession` 注入首条消息。

**现象**：消息被注入到 shell 而不是 Claude Code 的输入框，因为 Claude Code 的 TUI 还没渲染完成。

**修复**：创建 session 后 `sleep(10000)` 等 10 秒再注入。这个值是实测得出的保守值。

**注意**：这个等待时间可能因机器性能不同而变化。如果发现首条消息丢失，考虑增加等待时间。

## 3. sendToSession 不能静默吞错误

**场景**：`sendToSession` 的 catch 块原来只 `return false`，不打日志。

**后果**：消息注入失败时完全无感知，排查问题要猜。

**教训**：任何 catch 块都要至少打一行日志（session 名 + 错误信息），除非你 100% 确定这个错误无需关注。

## 4. CWD 必须是有 CLAUDE.md 的项目目录

**场景**：`createTmuxSession(name, cwd, cmd)` 的 `cwd` 参数决定了 Claude Code 的工作目录。

**坑**：如果 cwd 是 `/tmp` 或用户 home 这种没有 `CLAUDE.md` 的目录，Claude Code 启动后没有项目上下文，行为不符合预期。

**建议**：文档里强调 `cc2wechat start` 必须在项目目录下执行，或者通过 config 显式指定 cwd。

## 5. iLink session 过期需要重新扫码

**场景**：iLink Bot API 的登录态有过期时间（具体时间不确定，可能几天到一周）。

**现象**：长时间运行后 poll 开始返回 401/403，需要重新 `cc2wechat login` 扫码。

**建议**：
- 守护进程应该检测 poll 异常并通知用户
- 考虑加自动重连 / token 刷新机制

## 6. 并发消息的竞态条件

**场景**：`_createTmuxSession` 包含 10s 的 sleep。如果同一用户在这 10s 内发了第二条消息，两条消息都会通过 `findSession() === null` 的检查，各自触发 `_createTmuxSession`。

**后果**：第二次 `createTmuxSession` 会 kill 第一个 session（同名 session 替换逻辑），导致第一条消息丢失。

**修复**：用 `Set<string>` 做轻量级锁。第二条消息检测到锁存在时，等待创建完成后直接注入到已有 session。

**关键**：Node.js 是单线程的，但 `await sleep()` 会让出执行权。所以即使单线程也会有并发问题，只要中间有 await。

## 7. shutdown 要清理完整状态

**场景**：`shutdown()` 只 kill 了 tmux 进程，没清理 `TmuxSessions` 的内存 store 和磁盘 JSON 文件。

**后果**：重启后 `TmuxSessions` 从磁盘加载已死 session 记录。虽然 `deliver()` 会检测 `isTmuxSessionAlive`，但多了一次无效的检查 + recreate 流程。

**教训**：shutdown 必须做到「干净关机」—— 进程、内存、磁盘三层都清理。

## 8. cleanupStale 只清数据不杀进程

**场景**：`TmuxSessions.cleanupStale()` 是纯数据层，只管删 Map 和磁盘 JSON。它不知道 tmux 进程的存在。

**后果**：过期用户的 tmux session 变成孤儿进程，消耗系统资源。

**修复**：在 `TmuxDelivery` 层增加 `_cleanupStaleWithKill()`，先遍历过期 session 调用 `killTmuxSession`，再调 `cleanupStale` 清理数据。

**设计原则**：数据层（Sessions）不应该耦合平台操作（tmux kill）。进程清理职责属于 Delivery 层。

## 9. buildLaunchCommand 不通用——tmux 不能用 iTerm 的命令

**场景**：Terminal Delivery 的 `buildLaunchCommand` 返回 `cd /path && claude ...; exit`，包含 `cd`（设 cwd）和 `; exit`（claude 退出后关 iTerm tab）。

**tmux 的问题**：
1. `cd /path &&` 多余——tmux `new-session -c` 已经设了 cwd
2. `; exit` 不需要——tmux session 不像 iTerm tab 需要手动关
3. `escapeShellArg` 把整个命令用单引号包裹，`&&` 和 `;` 变成了字面字符，命令直接执行失败

**现象**：tmux session 创建成功但瞬间退出（`can't find pane`），10 秒后注入消息失败。

**修复**：tmux delivery 自己构建命令，不用 backend 的 buildLaunchCommand：
```typescript
const fullCmd = `CC2WECHAT_CONTEXT=${ctxPath} claude --dangerously-skip-permissions`;
```

**教训**：不同 Delivery 对命令的需求不同（iTerm 需要 cd+exit，tmux 不需要），命令构建不能共用一个接口。

## 10. E2E 测试的 tmux kill-server 杀死生产 session

**场景**：后台 agent 跑 E2E 测试时，测试的 cleanup 阶段调了 `tmux kill-server`。

**后果**：正在运行的 xingchen daemon 的 tmux session 被杀，用户发消息后 daemon 检测到 session gone → 重建 → 但 10 秒内又被测试的下一轮 kill-server 杀掉，循环。

**修复**：测试只清理自己创建的 session（`cc2w-test-` 前缀），不用 `kill-server`。

**教训**：tmux server 是全局共享资源，测试清理必须精确到自己的 session，不能用核弹级别的 kill-server。这和数据库测试不能 DROP DATABASE 是一个道理。

## 11. vitest CJS 兼容层是双刃剑

**核心教训**：vitest 在 ESM 项目中默认提供 `require()` 兼容，这意味着：
- 测试里写 `require()` 不会报错
- 被测代码里写 `require()` 也不会报错
- 227 个测试全绿，给人虚假的安全感

**防御方案**：
1. 在 CI 里加一步用 `node --input-type=module` 直接跑入口文件做冒烟测试
2. ESLint 规则禁止 `require()`（`no-restricted-globals` 或 `@typescript-eslint/no-require-imports`）
3. 代码审查时对 ESM 项目里出现的 `require` 保持警觉

## 12. ttyd 1.7.7 默认只读模式

**场景**：部署 ttyd Web Terminal 让用户通过浏览器访问 tmux session。

**陷阱**：ttyd 1.7.7 开始默认是**只读模式**。很多人以为加 `-R` 是开启只读，实际上 `-R` 是老版本的参数，新版本默认就是只读。要开启**可写**（允许用户在浏览器里输入），必须加 `-W` 参数。

**正确用法**：
```bash
# 可读可写（允许浏览器输入）
ttyd -W tmux attach -t session-name

# 只读（默认行为，不加 -W 即可）
ttyd tmux attach -t session-name
```

**教训**：升级 ttyd 后一定看 changelog，默认行为变了。如果浏览器能看到终端但打不了字，先检查是不是缺 `-W`。

## 13. daemon 自动启动的 ttyd 与 CLI web 命令端口冲突

**场景**：`cc2wechat start` 启动 daemon 时会自动为每个 tmux session 启动 ttyd Web Terminal。同时 `cc2wechat web` 命令也可以手动启动 ttyd。

**现象**：如果 daemon 已经在某个端口（比如 7682）启动了 ttyd，再手动执行 `cc2wechat web` 会因为端口被占用而失败：`Address already in use`。

**根因**：两个入口（daemon 自动启动 + CLI 手动启动）都试图绑定同一个端口，没有做端口占用检测。

**建议**：
- 启动 ttyd 前先检测目标端口是否已被占用（`lsof -i :PORT`）
- 如果已占用且是自己的 ttyd 进程，直接复用
- 如果已占用且是别的进程，自动递增端口或报错提示
- daemon 自动启动的 ttyd 信息应写入状态文件，CLI 命令读取后直接打开已有地址
