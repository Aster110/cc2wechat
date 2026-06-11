import fs from 'node:fs';
import path from 'node:path';

export interface SkillInstallResult {
  installed: boolean;
  dest: string;
}

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
