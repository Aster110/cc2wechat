import fs from 'node:fs';
import path from 'node:path';

export interface SkillInstallResult {
  installed: boolean;
  dest: string;
}

/**
 * 随包分发的 skill。加一条 = 让 `cc2wechat skill install` 默认把它也装上。
 * - `cc2wechat`：微信通道的操作手册
 * - `waku-dm`：Waku 私聊通道——收到 `[Image: path]` 怎么读、回图/回卡片怎么发、做 playable 的标准流程
 */
export const BUNDLED_SKILLS = ['cc2wechat', 'waku-dm'] as const;
export type BundledSkill = (typeof BUNDLED_SKILLS)[number];

/**
 * Copy a bundled skill (<pkgRoot>/skills/<name>) into <home>/.claude/skills/<name>.
 * Refuses to overwrite an existing target unless force=true.
 */
export function installSkill(
  pkgRoot: string,
  home: string,
  name: string,
  force = false,
): SkillInstallResult {
  const src = path.join(pkgRoot, 'skills', name);
  if (!fs.existsSync(path.join(src, 'SKILL.md'))) {
    throw new Error(`skill not found in package: ${src}`);
  }
  const dest = path.join(home, '.claude', 'skills', name);
  if (fs.existsSync(dest) && !force) {
    return { installed: false, dest };
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  return { installed: true, dest };
}
