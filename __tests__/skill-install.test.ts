import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installSkill } from '../src/skill-install.js';

let pkgRoot: string;
let home: string;

beforeEach(() => {
  pkgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc2wechat-pkg-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc2wechat-home-'));
  fs.mkdirSync(path.join(pkgRoot, 'skills', 'cc2wechat'), { recursive: true });
  fs.writeFileSync(path.join(pkgRoot, 'skills', 'cc2wechat', 'SKILL.md'), '# v1');
});

afterEach(() => {
  fs.rmSync(pkgRoot, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

describe('installSkill', () => {
  it('copies the bundled skill into ~/.claude/skills/', () => {
    const result = installSkill(pkgRoot, home, 'cc2wechat');
    expect(result.installed).toBe(true);
    const installed = path.join(home, '.claude', 'skills', 'cc2wechat', 'SKILL.md');
    expect(fs.readFileSync(installed, 'utf-8')).toBe('# v1');
  });

  it('skips when target exists and force is false', () => {
    installSkill(pkgRoot, home, 'cc2wechat');
    fs.writeFileSync(path.join(pkgRoot, 'skills', 'cc2wechat', 'SKILL.md'), '# v2');
    const result = installSkill(pkgRoot, home, 'cc2wechat');
    expect(result.installed).toBe(false);
    const installed = path.join(home, '.claude', 'skills', 'cc2wechat', 'SKILL.md');
    expect(fs.readFileSync(installed, 'utf-8')).toBe('# v1');
  });

  it('overwrites when force is true', () => {
    installSkill(pkgRoot, home, 'cc2wechat');
    fs.writeFileSync(path.join(pkgRoot, 'skills', 'cc2wechat', 'SKILL.md'), '# v2');
    const result = installSkill(pkgRoot, home, 'cc2wechat', true);
    expect(result.installed).toBe(true);
    const installed = path.join(home, '.claude', 'skills', 'cc2wechat', 'SKILL.md');
    expect(fs.readFileSync(installed, 'utf-8')).toBe('# v2');
  });

  it('throws when the package has no such skill', () => {
    expect(() => installSkill(pkgRoot, home, 'nope')).toThrow(/skill not found/);
  });
});
