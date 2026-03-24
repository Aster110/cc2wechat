function ts(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export function log(msg: string): void {
  console.log(`[cc2wechat ${ts()}] ${msg}`);
}

export function logError(msg: string): void {
  console.error(`[cc2wechat ${ts()}] ${msg}`);
}
