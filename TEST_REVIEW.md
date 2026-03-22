## 测试审查报告

### utils.test.ts
- 覆盖率：2/3 个 export 函数被测（`extractText`, `userIdToSessionUUID`）
- 问题：
  1. **`sleep` 未测试** — 虽然实现简单（Promise + setTimeout），但作为 export 函数应有基本测试
  2. **extractText 边界遗漏** — VOICE 没有 `voice_item.text`、FILE 没有 `file_item.file_name` 时，item 被静默跳过（不产出任何文本），这个行为未被测试覆盖。如果只有一个这样的 item，结果会是 `[Empty message]`，可能不符合预期
  3. **extractText 未知类型遗漏** — `item.type` 不在已知枚举中时（如 type=99），item 被静默跳过，未测试
  4. **userIdToSessionUUID UUID variant 位未校验** — 测试 regex 允许 variant nibble 为任意 hex，实际 UUID v4 要求 `[89ab]`。源码也没做 variant 处理，所以测试和源码一致，但生成的不是严格合规的 UUID v4
- 建议：
  - 补 `sleep` 基本测试（resolve 且耗时 >= N ms）
  - 补 VOICE 无 text、FILE 无 file_name 的边界测试
  - 补未知 type 的测试

### store.test.ts
- 覆盖率：5/6 个 export 函数被测（`saveAccount`, `getActiveAccount`, `loadAccounts`, `loadSyncBuf`, `saveSyncBuf`）
- 问题：
  1. **`removeAccount` 未测试** — 删除账户功能完全没覆盖
  2. **accounts.json 文件权限未验证** — `saveAccount` 会 `chmod 0o600`，测试未验证文件权限
  3. **并发写入未测试** — 两个 `saveAccount` 同时调用可能导致数据丢失（read-modify-write 竞态），虽然 Node 单线程不太会触发，但多进程场景下有风险
  4. **corrupted JSON 测试缺失** — `loadAccounts` 对 JSON.parse 失败会 catch 返回 `[]`，但没测试 accounts.json 内容损坏的场景
- 建议：
  - 补 `removeAccount` 测试（删除存在的、删除不存在的）
  - 补 corrupted JSON 文件测试（验证 graceful fallback）

### wechat-api.test.ts
- 覆盖率：2/9 个 export 函数被测（`encryptAesEcb`, `aesEcbPaddedSize`）
- 问题：
  1. **7 个 async API 函数完全未测** — `getQRCode`, `pollQRStatus`, `getUpdates`, `sendMessage`, `sendTyping`, `getConfig`, `uploadAndSendMedia` 均无测试
  2. 这些函数包含重要逻辑（超时处理、AbortError fallback、header 构建、错误处理），不能因为"需要 mock fetch"就跳过
  3. **encryptAesEcb 空输入未测** — 空 Buffer 加密是合法操作，未覆盖
- 建议：
  - 用 `vi.stubGlobal('fetch', ...)` 或 `msw` mock fetch，补充以下测试：
    - `getUpdates`：正常返回、AbortError 返回默认值、HTTP 错误抛异常
    - `sendMessage`：正常发送、失败抛异常
    - `getQRCode`：正常返回、HTTP 错误
    - `pollQRStatus`：各 status 返回值、超时返回 `{ status: 'wait' }`
    - `sendTyping` / `getConfig`：基本成功/失败
    - `uploadAndSendMedia`：至少测 getUploadUrl 无 upload_param 时抛错
  - 补 `encryptAesEcb(Buffer.alloc(0), key)` 边界测试

### 总体评价
**需修改**

纯工具函数（crypto、文件存储）测试质量不错，断言精确、覆盖了关键 case。但项目的核心价值在 WeChat API 交互层，7 个 async 函数零测试是最大短板。store 缺 `removeAccount`、utils 缺 `sleep` 属于小问题。

### 需要 test-fixer 修复的问题
1. **[P0]** wechat-api.test.ts：mock fetch 后补 `getUpdates`、`sendMessage`、`getQRCode`、`pollQRStatus` 测试（至少覆盖正常路径 + 错误路径 + 超时路径）
2. **[P0]** wechat-api.test.ts：补 `sendTyping`、`getConfig` 基本测试
3. **[P1]** store.test.ts：补 `removeAccount` 测试
4. **[P1]** utils.test.ts：补 `sleep` 测试
5. **[P2]** utils.test.ts：补 extractText 的 VOICE 无 text、FILE 无 file_name、未知 type 边界测试
6. **[P2]** store.test.ts：补 corrupted JSON fallback 测试
7. **[P2]** wechat-api.test.ts：补 `encryptAesEcb` 空 Buffer 边界测试
8. **[P3]** wechat-api.test.ts：补 `uploadAndSendMedia` 测试（复杂度高，可后续补）
