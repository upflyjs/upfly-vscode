import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { keepOldCopy, projectFolders } from './old-config-files.js';

const made: string[] = [];

function project(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'upfly-vscode-old-'));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('keepOldCopy', () => {
  it('copies the old file into .upfly byte for byte', () => {
    const root = project();
    const bytes = Buffer.from('{\r\n  // old\r\n  "enabled": true\r\n}\r\n');
    expect(keepOldCopy(root, bytes)).toBe('.upfly/old-extension-upfly.config.json');
    expect(readFileSync(path.join(root, '.upfly', 'old-extension-upfly.config.json'))).toEqual(
      bytes,
    );
  });

  it('keeps .upfly out of git as the CLI does, with a .gitignore of its own', () => {
    const root = project();
    keepOldCopy(root, Buffer.from('{}'));
    expect(readFileSync(path.join(root, '.upfly', '.gitignore'), 'utf8')).toBe('*\n');
  });

  it('leaves a .gitignore already in .upfly as it is', () => {
    const root = project();
    mkdirSync(path.join(root, '.upfly'));
    writeFileSync(path.join(root, '.upfly', '.gitignore'), 'mine\n');
    keepOldCopy(root, Buffer.from('{}'));
    expect(readFileSync(path.join(root, '.upfly', '.gitignore'), 'utf8')).toBe('mine\n');
  });

  it('never writes over an earlier copy that differs, and reuses one that is the same', () => {
    const root = project();
    keepOldCopy(root, Buffer.from('{"enabled": true}'));
    expect(keepOldCopy(root, Buffer.from('{"enabled": false}'))).toBe(
      '.upfly/old-extension-upfly.config-2.json',
    );
    expect(keepOldCopy(root, Buffer.from('{"enabled": true}'))).toBe(
      '.upfly/old-extension-upfly.config.json',
    );
  });
});

describe('projectFolders', () => {
  it('lists every folder of the project, relative to it with slashes', () => {
    const root = project();
    for (const dir of ['public/img', 'apps/web/public', 'src']) {
      mkdirSync(path.join(root, dir), { recursive: true });
    }
    expect(projectFolders(root)).toEqual([
      'apps',
      'apps/web',
      'apps/web/public',
      'public',
      'public/img',
      'src',
    ]);
  });

  it('leaves out dependencies, build output and hidden folders, as the old extension did', () => {
    const root = project();
    for (const dir of ['node_modules/x/public', 'dist/public', 'build/public', '.git/public']) {
      mkdirSync(path.join(root, dir), { recursive: true });
    }
    mkdirSync(path.join(root, 'public'));
    expect(projectFolders(root)).toEqual(['public']);
  });
});
