/**
 * M1 · 加密信封与分片（RED）
 *
 * 这是**跨端字节级协议**：浏览器 Playable 侧要用 WebCrypto 实现同一规范，
 * 所以本文件不满足于 "encrypt→decrypt 能还原"，而是用 node:crypto 独立复算，
 * 逐字节锁死密钥派生、AAD 串、nonce 与密文封装格式。任何一处改动都会红。
 *
 * 冻结规范（架构 §6）：
 * - HKDF-SHA256：ikm=channelSecret(32B raw)、salt=utf8(pairingId)、L=32
 *   info=utf8(`waku-mailbox-v1|${direction}|${purpose}|k${keyVersion}`)
 * - AEAD：AES-256-GCM，nonce=12B 随机（每块独立，base64url）
 *   密文 = cipherbytes || authTag(16B)，整体 base64url（与 WebCrypto 输出对齐）
 * - AAD = utf8(`v${protocolVersion}|${routeId}|${messageId}|${direction}|${kind}|${chunkIndex}|${chunkCount}|k${keyVersion}`)
 *   手拼管道串，不用 JSON（键序不稳定，跨端会不一致）
 * - 分片：明文 utf8 **按字节** 4096B 切；单消息 ≤64KiB / ≤16 块，常量固定，无调用方旋钮
 */
import { describe, it, expect } from 'vitest';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// 测试侧契约
// ---------------------------------------------------------------------------

type MailboxDirection = 'to_agent' | 'to_player';
type MailboxKind = 'pair' | 'turn' | 'control' | 'progress' | 'final' | 'error' | 'ack';

type MailboxChunk = {
  protocolVersion: number;
  routeId: string;
  messageId: string;
  direction: MailboxDirection;
  kind: MailboxKind;
  keyVersion: number;
  chunkIndex: number;
  chunkCount: number;
  createdAt: number;
  expiresAt: number;
  nonce: string;
  payload: { ciphertext: string };
};

type DeriveDirectionKeyOptions = {
  channelSecret: Uint8Array;
  pairingId: string;
  direction: MailboxDirection;
  purpose: string;
  keyVersion: number;
};

type ChunkAadInput = {
  protocolVersion: number;
  routeId: string;
  messageId: string;
  direction: MailboxDirection;
  kind: MailboxKind;
  chunkIndex: number;
  chunkCount: number;
  keyVersion: number;
};

type SealMessageOptions = {
  channelSecret: Uint8Array;
  pairingId: string;
  routeId: string;
  messageId: string;
  direction: MailboxDirection;
  kind: MailboxKind;
  keyVersion: number;
  purpose: string;
  createdAt: number;
  expiresAt: number;
  plaintext: string;
};

type OpenMessageOptions = {
  channelSecret: Uint8Array;
  pairingId: string;
  direction: MailboxDirection;
  purpose: string;
  keyVersion: number;
  now: number;
};

type CryptoModule = {
  NONCE_BYTES: number;
  AUTH_TAG_BYTES: number;
  DERIVED_KEY_BYTES: number;
  HKDF_INFO_PREFIX: string;
  deriveDirectionKey(options: DeriveDirectionKeyOptions): Promise<Uint8Array>;
  buildChunkAad(input: ChunkAadInput): Uint8Array;
};

type ChunkingModule = {
  CHUNK_PLAINTEXT_BYTES: number;
  MAX_CHUNK_COUNT: number;
  MAX_MESSAGE_BYTES: number;
  sealMessage(options: SealMessageOptions): Promise<MailboxChunk[]>;
  openMessage(chunks: readonly MailboxChunk[], options: OpenMessageOptions): Promise<string>;
};

type EnvelopeContractsModule = {
  MAX_CLOCK_SKEW_MS: number;
};

type CryptoError = Error & { code: string; field?: string };

function lazyModule<T>(specifier: string): () => Promise<T> {
  let cached: Promise<T> | undefined;
  return () => {
    if (!cached) cached = import(specifier) as Promise<T>;
    return cached;
  };
}

const loadCrypto = lazyModule<CryptoModule>('../../gateway/channels/waku/crypto.js');
const loadChunking = lazyModule<ChunkingModule>('../../gateway/channels/waku/chunking.js');
const loadEnvelope = lazyModule<EnvelopeContractsModule>('../../gateway/contracts/envelope.js');

// ---------------------------------------------------------------------------
// 独立复算（测试自己实现一遍冻结规范；实现方对不上就红）
// ---------------------------------------------------------------------------

function expectedInfo(direction: string, purpose: string, keyVersion: number): Buffer {
  return Buffer.from(`waku-mailbox-v1|${direction}|${purpose}|k${keyVersion}`, 'utf8');
}

function expectedKey(o: DeriveDirectionKeyOptions): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      o.channelSecret,
      Buffer.from(o.pairingId, 'utf8'),
      expectedInfo(o.direction, o.purpose, o.keyVersion),
      32,
    ),
  );
}

function expectedAad(i: ChunkAadInput): Buffer {
  return Buffer.from(
    `v${i.protocolVersion}|${i.routeId}|${i.messageId}|${i.direction}|${i.kind}|${i.chunkIndex}|${i.chunkCount}|k${i.keyVersion}`,
    'utf8',
  );
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function aadOf(chunk: MailboxChunk): Buffer {
  return expectedAad({
    protocolVersion: chunk.protocolVersion,
    routeId: chunk.routeId,
    messageId: chunk.messageId,
    direction: chunk.direction,
    kind: chunk.kind,
    chunkIndex: chunk.chunkIndex,
    chunkCount: chunk.chunkCount,
    keyVersion: chunk.keyVersion,
  });
}

function uuidv7(): string {
  const bytes = randomBytes(16);
  const ms = Date.now();
  bytes[0] = Math.floor(ms / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ms / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ms / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ms / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const NOW = 1_760_000_000_000;
const TTL = 300_000;

/** 每个用例都用随机 secret —— 测试 fixture 里不留任何明文常量密钥。 */
function newSecret(): Uint8Array {
  return randomBytes(32);
}

function sealOptions(overrides: Partial<SealMessageOptions> = {}): SealMessageOptions {
  return {
    channelSecret: newSecret(),
    pairingId: 'pr_' + randomBytes(8).toString('hex'),
    routeId: 'rt_' + randomBytes(8).toString('hex'),
    messageId: uuidv7(),
    direction: 'to_agent',
    kind: 'turn',
    keyVersion: 1,
    purpose: 'mailbox',
    createdAt: NOW,
    expiresAt: NOW + TTL,
    plaintext: 'hello waku',
    ...overrides,
  };
}

function openOptions(o: SealMessageOptions, overrides: Partial<OpenMessageOptions> = {}): OpenMessageOptions {
  return {
    channelSecret: o.channelSecret,
    pairingId: o.pairingId,
    direction: o.direction,
    purpose: o.purpose,
    keyVersion: o.keyVersion,
    now: NOW,
    ...overrides,
  };
}

async function expectReject(p: Promise<unknown>): Promise<CryptoError> {
  try {
    await p;
  } catch (e) {
    return e as CryptoError;
  }
  throw new Error('expected the promise to reject, but it resolved');
}

function cloneChunk(c: MailboxChunk, changes: Partial<MailboxChunk> = {}): MailboxChunk {
  return { ...c, payload: { ...c.payload }, ...changes };
}

// ---------------------------------------------------------------------------
// HKDF
// ---------------------------------------------------------------------------

describe('M1 · HKDF 方向密钥派生', () => {
  it('逐字节等于独立复算的 HKDF-SHA256（锁死 ikm/salt/info/L）', async () => {
    const mod = await loadCrypto();
    expect(mod.DERIVED_KEY_BYTES).toBe(32);
    expect(mod.NONCE_BYTES).toBe(12);
    expect(mod.AUTH_TAG_BYTES).toBe(16);
    expect(mod.HKDF_INFO_PREFIX).toBe('waku-mailbox-v1');

    const o: DeriveDirectionKeyOptions = {
      channelSecret: newSecret(),
      pairingId: 'pr_' + randomBytes(8).toString('hex'),
      direction: 'to_agent',
      purpose: 'mailbox',
      keyVersion: 1,
    };
    const key = await mod.deriveDirectionKey(o);
    expect(key).toHaveLength(32);
    expect(hex(key)).toBe(hex(expectedKey(o)));
  });

  it('相同输入稳定；direction / pairingId / purpose / keyVersion 任一不同则密钥不同', async () => {
    const mod = await loadCrypto();
    const base: DeriveDirectionKeyOptions = {
      channelSecret: newSecret(),
      pairingId: 'pr_alpha',
      direction: 'to_agent',
      purpose: 'mailbox',
      keyVersion: 1,
    };
    const k0 = hex(await mod.deriveDirectionKey(base));
    expect(hex(await mod.deriveDirectionKey({ ...base }))).toBe(k0);

    const variants: DeriveDirectionKeyOptions[] = [
      { ...base, direction: 'to_player' },
      { ...base, pairingId: 'pr_beta' },
      { ...base, purpose: 'bootstrap' },
      { ...base, keyVersion: 2 },
      { ...base, channelSecret: newSecret() },
    ];
    const seen = new Set<string>([k0]);
    for (const v of variants) {
      const k = hex(await mod.deriveDirectionKey(v));
      expect(k).not.toBe(k0);
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
  });
});

// ---------------------------------------------------------------------------
// AAD builder：独立证明每个 header 字段真的进了 AAD
// ---------------------------------------------------------------------------

describe('M1 · buildChunkAad', () => {
  it('逐字节等于手拼管道串（不用 JSON，键序不参与）', async () => {
    const mod = await loadCrypto();
    const input: ChunkAadInput = {
      protocolVersion: 1,
      routeId: 'rt_abc',
      messageId: uuidv7(),
      direction: 'to_agent',
      kind: 'turn',
      chunkIndex: 0,
      chunkCount: 1,
      keyVersion: 1,
    };
    expect(hex(mod.buildChunkAad(input))).toBe(hex(expectedAad(input)));
    expect(Buffer.from(mod.buildChunkAad(input)).toString('utf8')).toBe(
      `v1|rt_abc|${input.messageId}|to_agent|turn|0|1|k1`,
    );
  });

  it('protocolVersion / chunkIndex / chunkCount / keyVersion 任一变化都改变 AAD（不靠"最终抛错"冒充已认证）', async () => {
    const mod = await loadCrypto();
    const base: ChunkAadInput = {
      protocolVersion: 1,
      routeId: 'rt_abc',
      messageId: uuidv7(),
      direction: 'to_agent',
      kind: 'turn',
      chunkIndex: 0,
      chunkCount: 4,
      keyVersion: 1,
    };
    const b = hex(mod.buildChunkAad(base));
    const mutations: ChunkAadInput[] = [
      { ...base, protocolVersion: 2 },
      { ...base, chunkIndex: 1 },
      { ...base, chunkCount: 5 },
      { ...base, keyVersion: 2 },
      { ...base, routeId: 'rt_xyz' },
      { ...base, messageId: uuidv7() },
      { ...base, direction: 'to_player' },
      { ...base, kind: 'final' },
    ];
    for (const m of mutations) {
      expect(hex(mod.buildChunkAad(m))).not.toBe(b);
    }
  });
});

// ---------------------------------------------------------------------------
// 线格式：用 node:crypto 双向互操作
// ---------------------------------------------------------------------------

describe('M1 · AES-256-GCM 线格式', () => {
  it('sealMessage 产物可被 node:crypto 独立解密：nonce 12B、密文=ct||tag(16B)、全部 base64url', async () => {
    const chunking = await loadChunking();
    const o = sealOptions({ plaintext: '线格式必须跨端可复算 🔐' });
    const chunks = await chunking.sealMessage(o);
    expect(chunks).toHaveLength(1);
    const c = chunks[0];

    // 无填充、无 +/ 的 base64url
    expect(c.nonce).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(c.payload.ciphertext).toMatch(/^[A-Za-z0-9_-]+$/);

    const nonce = Buffer.from(c.nonce, 'base64url');
    expect(nonce).toHaveLength(12);

    const blob = Buffer.from(c.payload.ciphertext, 'base64url');
    const body = blob.subarray(0, blob.length - 16);
    const tag = blob.subarray(blob.length - 16);
    // GCM 是流模式：密文长度 === 明文字节长度
    expect(body).toHaveLength(Buffer.byteLength(o.plaintext, 'utf8'));

    const key = expectedKey({
      channelSecret: o.channelSecret,
      pairingId: o.pairingId,
      direction: o.direction,
      purpose: o.purpose,
      keyVersion: o.keyVersion,
    });
    const d = createDecipheriv('aes-256-gcm', key, nonce);
    d.setAAD(aadOf(c));
    d.setAuthTag(tag);
    expect(Buffer.concat([d.update(body), d.final()]).toString('utf8')).toBe(o.plaintext);

    // 反向互操作：由"浏览器侧"（这里用 node:crypto 手工封装）产出的块，openMessage 必须能收
    const foreignNonce = randomBytes(12);
    const plaintext = 'from the browser side';
    const chunkShell: MailboxChunk = cloneChunk(c, {
      messageId: uuidv7(),
      nonce: foreignNonce.toString('base64url'),
      payload: { ciphertext: '' },
    });
    const enc = createCipheriv('aes-256-gcm', key, foreignNonce);
    enc.setAAD(aadOf(chunkShell));
    const ct = Buffer.concat([enc.update(Buffer.from(plaintext, 'utf8')), enc.final()]);
    chunkShell.payload.ciphertext = Buffer.concat([ct, enc.getAuthTag()]).toString('base64url');
    await expect(chunking.openMessage([chunkShell], openOptions(o))).resolves.toBe(plaintext);
  });

  it('单块与多块 round-trip 还原；每块 nonce 独立且不复用', async () => {
    const chunking = await loadChunking();

    const single = sealOptions({ plaintext: 'x'.repeat(100) });
    await expect(chunking.openMessage(await chunking.sealMessage(single), openOptions(single))).resolves.toBe(
      single.plaintext,
    );

    const multi = sealOptions({ plaintext: 'y'.repeat(4096 * 5 + 7) });
    const chunks = await chunking.sealMessage(multi);
    expect(chunks).toHaveLength(6);
    expect(chunks.map((c) => c.chunkIndex)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(new Set(chunks.map((c) => c.chunkCount))).toEqual(new Set([6]));
    expect(new Set(chunks.map((c) => c.messageId))).toEqual(new Set([multi.messageId]));

    const nonces = new Set(chunks.map((c) => c.nonce));
    expect(nonces.size).toBe(chunks.length);
    for (const c of chunks) expect(Buffer.from(c.nonce, 'base64url')).toHaveLength(12);

    // 两次 seal 同一明文也不得复用 nonce
    const again = await chunking.sealMessage(multi);
    for (const c of again) expect(nonces.has(c.nonce)).toBe(false);

    await expect(chunking.openMessage(chunks, openOptions(multi))).resolves.toBe(multi.plaintext);
  });
});

// ---------------------------------------------------------------------------
// 认证失败面
// ---------------------------------------------------------------------------

describe('M1 · 解密负例', () => {
  it('错 channelSecret / 跨 pairingId / 错 direction / 错 keyVersion 全部失败', async () => {
    const chunking = await loadChunking();
    const o = sealOptions();
    const chunks = await chunking.sealMessage(o);

    // 错 key
    expect(
      (await expectReject(chunking.openMessage(chunks, openOptions(o, { channelSecret: newSecret() })))).code,
    ).toBe('chunk_auth_failed');

    // 同 secret 不同 pairingId —— routeId 或 secret 相同都不构成 possession
    expect(
      (await expectReject(chunking.openMessage(chunks, openOptions(o, { pairingId: 'pr_other' })))).code,
    ).toBe('chunk_auth_failed');

    // 方向密钥必须是双向不同的
    expect(
      (await expectReject(chunking.openMessage(chunks, openOptions(o, { direction: 'to_player' })))).code,
    ).toBe('direction_mismatch');

    // keyVersion 由接收方的 pairing 状态决定，不采信密文自称
    expect((await expectReject(chunking.openMessage(chunks, openOptions(o, { keyVersion: 2 })))).code).toBe(
      'key_version_mismatch',
    );

    // purpose 隔离
    expect(
      (await expectReject(chunking.openMessage(chunks, openOptions(o, { purpose: 'bootstrap' })))).code,
    ).toBe('chunk_auth_failed');
  });

  it('AAD 业务字段与 ciphertext 任一篡改都失败', async () => {
    const chunking = await loadChunking();
    const o = sealOptions();
    const [c] = await chunking.sealMessage(o);

    const tampered: MailboxChunk[] = [
      cloneChunk(c, { routeId: 'rt_' + randomBytes(8).toString('hex') }),
      cloneChunk(c, { messageId: uuidv7() }),
      cloneChunk(c, { kind: 'final' }),
      cloneChunk(c, { protocolVersion: 2 }),
    ];
    for (const t of tampered) {
      const err = await expectReject(chunking.openMessage([t], openOptions(o)));
      expect(err.code).toBe('chunk_auth_failed');
    }

    // 翻一个密文字节
    const blob = Buffer.from(c.payload.ciphertext, 'base64url');
    blob[0] ^= 0x01;
    const flipped = cloneChunk(c, { payload: { ciphertext: blob.toString('base64url') } });
    expect((await expectReject(chunking.openMessage([flipped], openOptions(o)))).code).toBe('chunk_auth_failed');

    // 换 nonce（结构合法但不是封装时用的那个）
    const renonced = cloneChunk(c, { nonce: randomBytes(12).toString('base64url') });
    expect((await expectReject(chunking.openMessage([renonced], openOptions(o)))).code).toBe('chunk_auth_failed');
  });

  it('两块消息交换 chunkIndex 后集合仍是完整的 {0,1}，但必须因 AAD 认证失败被拒（排除结构校验假绿）', async () => {
    const chunking = await loadChunking();
    // 4097 字节 => 恰好 2 块，交换 index 后 0..n-1 仍然齐全，结构校验挑不出毛病
    const o = sealOptions({ plaintext: 'z'.repeat(4097) });
    const chunks = await chunking.sealMessage(o);
    expect(chunks).toHaveLength(2);

    const swapped = [cloneChunk(chunks[0], { chunkIndex: 1 }), cloneChunk(chunks[1], { chunkIndex: 0 })];
    expect(swapped.map((c) => c.chunkIndex).sort()).toEqual([0, 1]);
    expect(new Set(swapped.map((c) => c.chunkCount))).toEqual(new Set([2]));

    const err = await expectReject(chunking.openMessage(swapped, openOptions(o)));
    expect(err.code).toBe('chunk_auth_failed');
  });
});

// ---------------------------------------------------------------------------
// 重组语义
// ---------------------------------------------------------------------------

describe('M1 · 分片重组语义', () => {
  it('缺块 / chunkCount 冲突 / 内容冲突的重复块都不产出 payload', async () => {
    const chunking = await loadChunking();
    const o = sealOptions({ plaintext: 'w'.repeat(4097) });
    const chunks = await chunking.sealMessage(o);

    expect((await expectReject(chunking.openMessage([chunks[0]], openOptions(o)))).code).toBe('chunk_missing');

    const countConflict = [chunks[0], cloneChunk(chunks[1], { chunkCount: 3 })];
    expect((await expectReject(chunking.openMessage(countConflict, openOptions(o)))).code).toBe(
      'chunk_count_conflict',
    );

    const rival = cloneChunk(chunks[0], { nonce: randomBytes(12).toString('base64url') });
    expect(
      (await expectReject(chunking.openMessage([chunks[0], rival, chunks[1]], openOptions(o)))).code,
    ).toBe('chunk_conflict');
  });

  it('乱序输入可重组；完全相同的重复块折叠而不是报错', async () => {
    const chunking = await loadChunking();
    const o = sealOptions({ plaintext: 'q'.repeat(4096 * 3 + 1) });
    const chunks = await chunking.sealMessage(o);
    expect(chunks).toHaveLength(4);

    const shuffled = [chunks[2], chunks[0], chunks[3], chunks[1]];
    await expect(chunking.openMessage(shuffled, openOptions(o))).resolves.toBe(o.plaintext);

    const withDupes = [chunks[1], chunks[0], chunks[1], chunks[3], chunks[2], chunks[0]];
    await expect(chunking.openMessage(withDupes, openOptions(o))).resolves.toBe(o.plaintext);
  });
});

// ---------------------------------------------------------------------------
// 边界
// ---------------------------------------------------------------------------

describe('M1 · 分片边界与协议常量', () => {
  it('协议常量固定为 4096 / 16 / 65536，且互相自洽', async () => {
    const chunking = await loadChunking();
    expect(chunking.CHUNK_PLAINTEXT_BYTES).toBe(4096);
    expect(chunking.MAX_CHUNK_COUNT).toBe(16);
    expect(chunking.MAX_MESSAGE_BYTES).toBe(65_536);
    expect(chunking.MAX_MESSAGE_BYTES).toBe(chunking.CHUNK_PLAINTEXT_BYTES * chunking.MAX_CHUNK_COUNT);
  });

  it('字节边界 0 / 1 / 4096 / 4097 / 65536 的块数正确，65537 拒绝', async () => {
    const chunking = await loadChunking();
    const expectations: Array<[number, number]> = [
      [0, 1],
      [1, 1],
      [4096, 1],
      [4097, 2],
      [65_536, 16],
    ];
    for (const [bytes, count] of expectations) {
      const o = sealOptions({ plaintext: 'a'.repeat(bytes) });
      const chunks = await chunking.sealMessage(o);
      expect(chunks).toHaveLength(count);
      expect(chunks.every((c) => c.chunkCount === count)).toBe(true);
      await expect(chunking.openMessage(chunks, openOptions(o))).resolves.toBe(o.plaintext);
    }

    const tooBig = sealOptions({ plaintext: 'a'.repeat(65_537) });
    expect((await expectReject(chunking.sealMessage(tooBig))).code).toBe('message_too_large');
  });

  it('16 块是上界：伪造出的第 17 块必须被拒绝', async () => {
    const chunking = await loadChunking();
    const o = sealOptions({ plaintext: 'a'.repeat(65_536) });
    const chunks = await chunking.sealMessage(o);
    expect(chunks).toHaveLength(16);

    const forged = chunks
      .map((c) => cloneChunk(c, { chunkCount: 17 }))
      .concat(cloneChunk(chunks[0], { chunkIndex: 16, chunkCount: 17 }));
    expect((await expectReject(chunking.openMessage(forged, openOptions(o)))).code).toBe('too_many_chunks');
  });

  it('Unicode/emoji/换行：按字节切片（不是按字符），跨码点边界仍能原样还原', async () => {
    const chunking = await loadChunking();
    // 'a' + 1024 个 4 字节 emoji = 4097 字节，切点 4096 落在最后一个 emoji 中间
    const text = 'a' + '🙂'.repeat(1024);
    expect(Buffer.byteLength(text, 'utf8')).toBe(4097);
    expect(text.length).not.toBe(4097);

    const o = sealOptions({ plaintext: text });
    const chunks = await chunking.sealMessage(o);
    expect(chunks).toHaveLength(2);
    await expect(chunking.openMessage(chunks, openOptions(o))).resolves.toBe(text);

    const mixed = sealOptions({ plaintext: '空行\n\n制表\t中文 English 🇨🇳\r\n末尾' });
    await expect(
      chunking.openMessage(await chunking.sealMessage(mixed), openOptions(mixed)),
    ).resolves.toBe(mixed.plaintext);
  });

  it('过期一律 fail-closed：now>=expiresAt 不解密，createdAt>=expiresAt 拒绝，未来时间只容忍固定 skew 窗口', async () => {
    const chunking = await loadChunking();
    const envelope = await loadEnvelope();
    const skew = envelope.MAX_CLOCK_SKEW_MS;

    const o = sealOptions();
    const chunks = await chunking.sealMessage(o);

    await expect(chunking.openMessage(chunks, openOptions(o, { now: o.expiresAt - 1 }))).resolves.toBe(o.plaintext);
    expect((await expectReject(chunking.openMessage(chunks, openOptions(o, { now: o.expiresAt })))).code).toBe(
      'message_expired',
    );
    expect((await expectReject(chunking.openMessage(chunks, openOptions(o, { now: o.expiresAt + 1 })))).code).toBe(
      'message_expired',
    );

    // createdAt >= expiresAt 从封装期就不合法
    const inverted = sealOptions({ createdAt: NOW + TTL, expiresAt: NOW + TTL });
    expect((await expectReject(chunking.sealMessage(inverted))).code).toBe('invalid_expiry');

    // 时钟偏移：窗口内接受，窗口外拒绝（窗口是常量，openMessage 没有 skew 参数）
    const future = sealOptions({ createdAt: NOW + skew - 1, expiresAt: NOW + skew + TTL });
    await expect(chunking.openMessage(await chunking.sealMessage(future), openOptions(future))).resolves.toBe(
      future.plaintext,
    );
    const tooFuture = sealOptions({ createdAt: NOW + skew + 1, expiresAt: NOW + skew + TTL });
    expect(
      (await expectReject(chunking.openMessage(await chunking.sealMessage(tooFuture), openOptions(tooFuture)))).code,
    ).toBe('clock_skew_exceeded');
  });
});
