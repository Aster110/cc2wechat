import type { GetUpdatesResp, GetConfigResp } from '../../types.js';
import {
  apiFetch,
  buildBaseInfo,
  DEFAULT_CONFIG_TIMEOUT_MS,
  DEFAULT_LONG_POLL_TIMEOUT_MS,
} from '../shared/wechat-api-core.js';

export async function getUpdates(
  token: string,
  buf: string,
  baseUrl?: string,
  timeoutMs?: number,
): Promise<GetUpdatesResp> {
  const timeout = timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  try {
    const rawText = await apiFetch({
      baseUrl,
      endpoint: 'ilink/bot/getupdates',
      body: JSON.stringify({
        get_updates_buf: buf ?? '',
        base_info: buildBaseInfo(),
      }),
      token,
      timeoutMs: timeout,
      label: 'getUpdates',
    });
    return JSON.parse(rawText) as GetUpdatesResp;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ret: 0, msgs: [], get_updates_buf: buf };
    }
    throw err;
  }
}

export async function getConfig(
  token: string,
  userId: string,
  contextToken?: string,
  baseUrl?: string,
): Promise<GetConfigResp> {
  const rawText = await apiFetch({
    baseUrl,
    endpoint: 'ilink/bot/getconfig',
    body: JSON.stringify({
      ilink_user_id: userId,
      context_token: contextToken,
      base_info: buildBaseInfo(),
    }),
    token,
    timeoutMs: DEFAULT_CONFIG_TIMEOUT_MS,
    label: 'getConfig',
    failOnBodyError: true,
  });
  return JSON.parse(rawText) as GetConfigResp;
}
