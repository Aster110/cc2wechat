import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { WeixinMessage } from '../types.js';
import type { AccountData } from '../store.js';
import { extractText, userIdToSessionUUID, log } from '../utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const replyCli = path.join(__dirname, '..', 'reply-cli.js');

// ---------------------------------------------------------------------------
// Pipe mode message handler (Windows/Linux)
// ---------------------------------------------------------------------------

export async function handleMessagePipe(msg: WeixinMessage, account: AccountData): Promise<void> {
  const text = extractText(msg);
  const userId = msg.from_user_id ?? '';
  const sessionId = userIdToSessionUUID(userId);
  const cwd = process.cwd();

  log(`-> pipe mode: ${text.slice(0, 30)}...`);
  const prompt = JSON.stringify(text);
  const systemPrompt = JSON.stringify(`You are responding to a WeChat message. Keep replies concise. Use this to reply: node ${replyCli} --text "reply" or node ${replyCli} --image /path/to/file`);
  let result: string;
  try {
    result = execSync(
      `claude -p ${prompt} --resume ${sessionId} --output-format text --permission-mode bypassPermissions --system-prompt ${systemPrompt}`,
      { encoding: 'utf-8', timeout: 120_000, maxBuffer: 10 * 1024 * 1024, cwd },
    ).trim();
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; message?: string };
    if (!execErr.stdout?.trim()) {
      try {
        result = execSync(
          `claude -p ${prompt} --session-id ${sessionId} --output-format text --permission-mode bypassPermissions --system-prompt ${systemPrompt}`,
          { encoding: 'utf-8', timeout: 120_000, maxBuffer: 10 * 1024 * 1024, cwd },
        ).trim();
      } catch (err2: unknown) {
        const execErr2 = err2 as { stdout?: string; message?: string };
        result = execErr2.stdout?.trim() || `Error: ${execErr2.message ?? 'unknown'}`;
      }
    } else {
      result = execErr.stdout.trim();
    }
  }
  // Auto-send text reply
  const { sendMessage: sendMsg } = await import('../wechat-api.js');
  const plain = result.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, c: string) => c.trim())
    .replace(/\*\*(.+?)\*\*/g, '$1').replace(/^#{1,6}\s+/gm, '').trim();
  const chunks = plain.length <= 3900 ? [plain] : [plain.slice(0, 3900), plain.slice(3900)];
  for (const chunk of chunks) {
    await sendMsg(account.token, userId, chunk, msg.context_token ?? '', account.baseUrl);
  }
  log(`-> replied (${chunks.length} chunk)`);
}
