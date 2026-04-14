import { MessageItemType } from '../../types.js';
import type { WeixinMessage } from '../../types.js';
import type { AccountData } from '../../store.js';
import { downloadMedia } from '../../wechat-api.js';
import { log, logError } from '../../utils.js';

const MEDIA_TYPE_EXT: Record<number, string> = {
  [MessageItemType.IMAGE]: '.jpg',
  [MessageItemType.VIDEO]: '.mp4',
  [MessageItemType.FILE]: '',
};

export async function downloadMediaItems(
  msg: WeixinMessage,
  account: AccountData,
): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  const items = msg.item_list ?? [];
  const msgId = msg.message_id ?? Date.now();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type !== MessageItemType.IMAGE &&
        item.type !== MessageItemType.VIDEO &&
        item.type !== MessageItemType.FILE) continue;

    const media = item.image_item?.media ?? item.video_item?.media ?? item.file_item?.media;
    if (!media?.encrypt_query_param || !media?.aes_key) continue;

    let ext = MEDIA_TYPE_EXT[item.type] ?? '';
    if (item.type === MessageItemType.FILE && item.file_item?.file_name) {
      const dotIdx = item.file_item.file_name.lastIndexOf('.');
      ext = dotIdx >= 0 ? item.file_item.file_name.slice(dotIdx) : '';
    }

    const fileName = `${msgId}-${i}${ext}`;

    try {
      const filePath = await downloadMedia({
        token: account.token,
        encryptQueryParam: media.encrypt_query_param,
        aesKey: media.aes_key,
        outputFileName: fileName,
        baseUrl: account.baseUrl,
      });
      result.set(i, filePath);
      log(`downloaded media: ${filePath}`);
    } catch (err) {
      logError(`media download failed for item ${i}: ${String(err)}`);
    }
  }

  return result;
}
