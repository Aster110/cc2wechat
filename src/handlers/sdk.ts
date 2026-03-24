import { OfficialAdapter, detectMultiTurnSignals } from '@aster110/cc-core';
import type { SSEEvent } from '@aster110/cc-core';

import type { WeixinMessage } from '../types.js';
import type { AccountData } from '../store.js';
import { sendMessage } from '../wechat-api.js';
import { extractText, userIdToSessionUUID, log, logError } from '../utils.js';

// ---------------------------------------------------------------------------
// Singleton adapter
// ---------------------------------------------------------------------------

let adapter: OfficialAdapter | null = null;

function getAdapter(): OfficialAdapter {
  if (!adapter) {
    adapter = new OfficialAdapter();
  }
  return adapter;
}

// ---------------------------------------------------------------------------
// Text chunking (WeChat 3900 char limit)
// ---------------------------------------------------------------------------

const MAX_CHUNK = 3900;

function chunkText(text: string): string[] {
  if (text.length <= MAX_CHUNK) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += MAX_CHUNK) {
    chunks.push(text.slice(i, i + MAX_CHUNK));
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Extract text result from SSE events
// ---------------------------------------------------------------------------

function extractResultText(event: SSEEvent): string | null {
  if (event.type === 'result') {
    const result = event.result;
    if (typeof result === 'string') return result;
  }

  // assistant message with text content
  if (event.type === 'assistant') {
    const message = event.message as { content?: unknown } | undefined;
    if (message?.content) {
      if (typeof message.content === 'string') return message.content;
      if (Array.isArray(message.content)) {
        const textParts = (message.content as Array<{ type?: string; text?: string }>)
          .filter(b => b.type === 'text' && b.text)
          .map(b => b.text);
        if (textParts.length > 0) return textParts.join('\n');
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// SDK mode message handler
// ---------------------------------------------------------------------------

export async function handleMessageSDK(msg: WeixinMessage, account: AccountData, preExtractedText?: string): Promise<void> {
  const text = preExtractedText ?? extractText(msg);
  const userId = msg.from_user_id ?? '';
  const contextToken = msg.context_token ?? '';
  const sessionId = userIdToSessionUUID(userId);
  const cwd = process.cwd();

  log(`-> SDK mode: ${text.slice(0, 30)}...`);

  const a = getAdapter();
  let resultText = '';
  let teamsRunning = false;

  try {
    const stream = a.chat({
      message: `[微信] ${text}`,
      sessionId,
      cwd,
    });

    for await (const event of stream) {
      // Detect Agent Teams signals
      const signals = detectMultiTurnSignals(event);
      if (signals.teamsStarted) teamsRunning = true;
      if (signals.teamsFinished) teamsRunning = false;

      // Collect result text
      const extracted = extractResultText(event);
      if (extracted) {
        resultText = extracted;
      }
    }
  } catch (err) {
    logError(`SDK error: ${String(err)}`);
    resultText = `[cc2wechat error] ${String(err)}`;
  }

  if (!resultText) {
    resultText = '[No response from Claude]';
  }

  // Strip markdown for WeChat
  const plain = resultText
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, c: string) => c.trim())
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .trim();

  // Send chunked reply
  const chunks = chunkText(plain);
  for (const chunk of chunks) {
    await sendMessage(account.token, userId, chunk, contextToken, account.baseUrl);
  }
  log(`-> replied via SDK (${chunks.length} chunk${chunks.length > 1 ? 's' : ''})`);
}
