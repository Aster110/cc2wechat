import { createHash } from 'node:crypto';

export { sleep, userIdToSessionUUID, extractText } from '../../utils.js';

/** Generate an isolated context file path for a userId. */
export function contextPathForUser(userId: string): string {
  const hash = createHash('md5').update(userId).digest('hex').slice(0, 8);
  return `/tmp/cc2wechat-ctx-${hash}.json`;
}
