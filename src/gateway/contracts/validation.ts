/**
 * Gateway 契约层共用的校验原语。
 *
 * 两条硬约束贯穿全部 parse*：
 * 1. 失败一律 throw 带 `code`（大类）+ `field`（具体字段路径）的错误，
 *    这样负例能证明"因为目标字段被拒"，而不是"碰巧撞上别的必填项"。
 * 2. 错误消息只写字段名，**绝不回显字段值** —— 入站信封里全是密文/token/密钥，
 *    一旦进日志就等于明文泄漏。
 */

export interface GatewayError extends Error {
  code: string;
  field?: string;
}

export function gatewayError(code: string, message: string, field?: string): GatewayError {
  const err = new Error(message) as GatewayError;
  err.code = code;
  if (field !== undefined) err.field = field;
  return err;
}

export function isGatewayError(value: unknown): value is GatewayError {
  return value instanceof Error && typeof (value as GatewayError).code === 'string';
}

export function asRecord(input: unknown, field: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw gatewayError('invalid_input', `${field} must be an object`, field);
  }
  return input as Record<string, unknown>;
}

/**
 * 未知字段一律拒绝：客户端不得夹带 cwd / trustTier / runnerNode 之类的执行策略。
 * `prefix` 用于拼字段路径（如 `capabilities.`）。
 */
export function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  prefix = '',
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw gatewayError('unknown_field', `unexpected field ${prefix}${key}`, `${prefix}${key}`);
    }
  }
}

export function requireString(record: Record<string, unknown>, key: string, field: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw gatewayError('invalid_input', `${field} must be a non-empty string`, field);
  }
  return value;
}

/** 只允许"至少含一个非空白字符"的文本（空串与纯空白都拒）。 */
export function requireText(record: Record<string, unknown>, key: string, field: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw gatewayError('invalid_input', `${field} must be a non-blank string`, field);
  }
  return value;
}

export function optionalString(
  record: Record<string, unknown>,
  key: string,
  field: string,
): string | undefined {
  if (record[key] === undefined) return undefined;
  return requireString(record, key, field);
}

export function requireBoolean(record: Record<string, unknown>, key: string, field: string): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') {
    throw gatewayError('invalid_input', `${field} must be a boolean`, field);
  }
  return value;
}

export function requireInteger(
  record: Record<string, unknown>,
  key: string,
  field: string,
  min: number,
  max?: number,
): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw gatewayError('invalid_input', `${field} must be an integer`, field);
  }
  if (max !== undefined && value > max) {
    throw gatewayError('invalid_input', `${field} is out of range`, field);
  }
  return value;
}

/** 字段缺省时返回 undefined（调用方据此决定要不要把键写进结果）。 */
export function optionalInteger(
  record: Record<string, unknown>,
  key: string,
  field: string,
  min: number,
  max?: number,
): number | undefined {
  if (record[key] === undefined) return undefined;
  return requireInteger(record, key, field, min, max);
}

export function requireExactNumber(
  record: Record<string, unknown>,
  key: string,
  field: string,
  expected: number,
): number {
  const value = record[key];
  if (value !== expected) {
    throw gatewayError('invalid_input', `${field} must be ${expected}`, field);
  }
  return expected;
}

export function requireLiteral<T extends string>(
  record: Record<string, unknown>,
  key: string,
  field: string,
  allowed: readonly T[],
): T {
  const value = record[key];
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw gatewayError('invalid_input', `${field} is not in the frozen vocabulary`, field);
  }
  return value as T;
}

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

/**
 * 严格 base64url 解码：字符集不对、或解码后无法原样回编码（尾部冗余比特）都判失败。
 * `Buffer.from(x, 'base64url')` 本身很宽容，会把 `+/=` 也吃掉，所以不能只靠它。
 */
export function decodeBase64Url(value: unknown): Buffer | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (!BASE64URL_RE.test(value)) return null;
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) return null;
  return decoded;
}

export function requireBase64Url(
  record: Record<string, unknown>,
  key: string,
  field: string,
  exactBytes?: number,
): string {
  const value = record[key];
  const decoded = decodeBase64Url(value);
  if (decoded === null) {
    throw gatewayError('invalid_input', `${field} must be base64url`, field);
  }
  if (exactBytes !== undefined && decoded.length !== exactBytes) {
    throw gatewayError('invalid_input', `${field} must decode to ${exactBytes} bytes`, field);
  }
  return value as string;
}

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidV7(value: unknown): value is string {
  return typeof value === 'string' && UUID_V7_RE.test(value);
}

export function requireUuidV7(record: Record<string, unknown>, key: string, field: string): string {
  const value = record[key];
  if (!isUuidV7(value)) {
    throw gatewayError('invalid_input', `${field} must be a UUIDv7`, field);
  }
  return value;
}

export function requireStringArray(
  record: Record<string, unknown>,
  key: string,
  field: string,
): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw gatewayError('invalid_input', `${field} must be an array of strings`, field);
  }
  return value as string[];
}
