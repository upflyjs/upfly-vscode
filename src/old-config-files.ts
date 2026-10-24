/**
 * The files a conversion of the old extension's `upfly.config.json` touches besides the config
 * itself: the copy of the old file it keeps in Upfly's own folder, `.upfly`, and the project's
 * folders, which an old watched name is matched against.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** The folders the old extension skipped when it looked through a project, beside hidden ones. */
const SKIPPED = new Set(['node_modules', 'dist', 'build']);
/** How deep and how many folders the walk reads, so a huge project cannot stall it. */
const MAX_DEPTH = 8;
const MAX_FOLDERS = 20_000;

/**
 * Keeps a copy of the old file in `.upfly`, which first gets the `.gitignore` the CLI writes
 * there, so the copy never shows as a change in git. An earlier copy is never written over: one
 * with the same bytes is reused, and a different one gets a numbered name beside it.
 *
 * @param root the project folder
 * @param bytes the old file's bytes
 * @returns where the copy is, relative to the project, with `/`
 */
export function keepOldCopy(root: string, bytes: Buffer): string {
  const folder = path.join(root, '.upfly');
  mkdirSync(folder, { recursive: true });
  writeNew(path.join(folder, '.gitignore'), Buffer.from('*\n'));
  for (let count = 1; ; count += 1) {
    const name =
      count === 1 ? 'old-extension-upfly.config.json' : `old-extension-upfly.config-${count}.json`;
    const file = path.join(folder, name);
    if (writeNew(file, bytes) || readFileSync(file).equals(bytes)) return `.upfly/${name}`;
  }
}

/**
 * Every folder in a project, relative to it with `/`, sorted: dependencies, build output and
 * hidden folders left out.
 *
 * @param root the project folder
 */
export function projectFolders(root: string): string[] {
  const found: string[] = [];
  const walk = (relative: string, depth: number): void => {
    if (depth > MAX_DEPTH || found.length >= MAX_FOLDERS) return;
    let entries: { name: string; isDirectory(): boolean }[];
    try {
      entries = readdirSync(path.join(root, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || SKIPPED.has(entry.name)) continue;
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
      found.push(child);
      walk(child, depth + 1);
    }
  };
  walk('', 1);
  return found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Writes a file that is not there yet; false when one already is. */
function writeNew(file: string, bytes: Buffer): boolean {
  try {
    writeFileSync(file, bytes, { flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}
