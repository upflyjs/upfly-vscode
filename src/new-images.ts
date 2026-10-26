/**
 * Whether an image that arrived is new. In a git repository it is new only when git does not
 * track its path and has never stored its exact bytes: a pull, a clone, a checkout, a merge, a
 * rename, a copy or a stash pop all bring bytes git stored, so none of them brings a new image.
 * In a folder without git everything that arrives is new, but for an original `upfly undo`
 * has just put back. Git runs without a shell, and with lazy fetching off, so a partial clone
 * never goes to the network to answer.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { RunList } from './contract.js';

/** How git answered one command: its exit code, or null when it could not start. */
export interface GitAnswer {
  readonly code: number | null;
  readonly stdout: string;
}

/** git in one folder. */
export interface Git {
  /** The folder git runs in, an absolute path. */
  readonly cwd: string;
  /** Runs git with these arguments, writing `input` to its standard input. */
  run(args: readonly string[], input?: string): Promise<GitAnswer>;
}

/** What git said about a burst's files. */
export interface GitAnswers {
  /** The paths git ignores. */
  readonly ignored: ReadonlySet<string>;
  /** The paths git tracks. */
  readonly tracked: ReadonlySet<string>;
  /** Each untracked path's object id: the id git would give its bytes. */
  readonly ids: ReadonlyMap<string, string>;
  /** The ids of the objects git holds. */
  readonly stored: ReadonlySet<string>;
}

/** A burst's files, sorted. */
export interface Sorted {
  readonly fresh: readonly string[];
  readonly ignored: readonly string[];
  /** Tracked, or bytes git stored, or a file git could not read. */
  readonly known: readonly string[];
}

/** How much of a command line one git call's paths may take, well inside every system's limit. */
const ARGUMENT_BUDGET = 24_000;

/**
 * Runs git in a folder, without a shell, never fetching a missing object.
 *
 * @param cwd the folder git runs in
 * @param env variables to add to the editor's environment
 */
export function gitIn(cwd: string, env: Readonly<Record<string, string>> = {}): Git {
  const run = (args: readonly string[], input?: string): Promise<GitAnswer> =>
    new Promise((resolve) => {
      const child = execFile(
        'git',
        args,
        {
          cwd,
          env: { ...process.env, ...env, GIT_NO_LAZY_FETCH: '1' },
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout) => {
          const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null;
          resolve({ code, stdout });
        },
      );
      // git may exit before reading all of its input, which is no error here.
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(input ?? '');
    });
  return { cwd, run };
}

/**
 * Whether the folder is inside a git work tree.
 *
 * @param git git in the folder
 * @returns true or false, or null when git could not be started
 */
export async function isRepository(git: Git): Promise<boolean | null> {
  const answer = await git.run(['rev-parse', '--is-inside-work-tree']);
  if (answer.code === null) return null;
  return answer.code === 0 && answer.stdout.trim() === 'true';
}

/**
 * Whether a folder or one above it holds a `.git`, for when git itself cannot be started.
 *
 * @param folder an absolute path
 */
export function repositoryAbove(folder: string): boolean {
  for (let current = folder; ; current = path.dirname(current)) {
    if (existsSync(path.join(current, '.git'))) return true;
    if (path.dirname(current) === current) return false;
  }
}

/**
 * Sorts a burst's files by what git knows of them.
 *
 * @param git git in the project folder
 * @param paths files relative to the project folder, with `/`
 * @throws Error when git fails to answer
 */
export async function sortByGit(git: Git, paths: readonly string[]): Promise<Sorted> {
  if (paths.length === 0) return { fresh: [], ignored: [], known: [] };
  const ignored = await ignoredPaths(git, paths);
  const left = paths.filter((file) => !ignored.has(file));
  const tracked = await trackedPaths(git, left);
  const ids = await objectIds(
    git,
    left.filter((file) => !tracked.has(file)),
  );
  const stored = await storedIds(git, [...new Set(ids.values())]);
  return newImages(paths, { ignored, tracked, ids, stored });
}

/**
 * Sorts files by git's answers: new only when untracked and its bytes never stored.
 *
 * @param paths the files, in the order they are listed back
 * @param answers what git said about them
 */
export function newImages(paths: readonly string[], answers: GitAnswers): Sorted {
  const fresh: string[] = [];
  const ignored: string[] = [];
  const known: string[] = [];
  for (const file of paths) {
    const id = answers.ids.get(file);
    if (answers.ignored.has(file)) ignored.push(file);
    else if (answers.tracked.has(file) || id === undefined || answers.stored.has(id)) {
      known.push(file);
    } else fresh.push(file);
  }
  return { fresh, ignored, known };
}

/**
 * The entries of a NUL-separated list, as git writes one with `-z`.
 *
 * @param output what git printed
 */
export function parseNul(output: string): string[] {
  return output.split('\0').filter((entry) => entry !== '');
}

/**
 * The object ids `git cat-file --batch-check` found, from its output.
 *
 * @param output one line per id: `<id> <type> <size>`, or `<id> missing`
 */
export function parseBatchCheck(output: string): Set<string> {
  const found = new Set<string>();
  for (const line of output.split('\n')) {
    const [id, type] = line.trim().split(' ');
    if (id !== undefined && id !== '' && type !== undefined && type !== 'missing') found.add(id);
  }
  return found;
}

/**
 * The originals the last run lists as back, which `upfly undo` put there.
 *
 * @param run the last run, as `upfly undo --list` gives it, or null when there is none
 */
export function restoredOriginals(run: RunList | null | undefined): Set<string> {
  return new Set((run?.originals ?? []).filter((original) => original.back).map((o) => o.path));
}

async function ignoredPaths(git: Git, paths: readonly string[]): Promise<Set<string>> {
  const answer = await git.run(['check-ignore', '-z', '--stdin'], `${paths.join('\0')}\0`);
  // 1 means none is ignored.
  if (answer.code !== 0 && answer.code !== 1) throw new Error('git check-ignore failed');
  return new Set(parseNul(answer.stdout));
}

async function trackedPaths(git: Git, paths: readonly string[]): Promise<Set<string>> {
  const tracked = new Set<string>();
  for (const chunk of chunks(paths)) {
    // A path is matched as written, so `[slug]` or `*` in a name is not read as a pattern.
    const answer = await git.run(['--literal-pathspecs', 'ls-files', '-z', '--', ...chunk]);
    if (answer.code !== 0) throw new Error('git ls-files failed');
    for (const file of parseNul(answer.stdout)) tracked.add(file);
  }
  return tracked;
}

/**
 * Each file's object id, without writing it into git. A file git cannot read, such as one
 * removed since it arrived, has none, and neither has a name holding a line break, which the
 * one-path-per-line input cannot carry. The paths go in absolute: git reads the ones on its
 * input from the repository's top, not from the folder it was started in.
 */
async function objectIds(git: Git, paths: readonly string[]): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  let rest = paths.filter((file) => !file.includes('\n'));
  while (rest.length > 0) {
    const input = rest.map((file) => path.resolve(git.cwd, file)).join('\n');
    const answer = await git.run(['hash-object', '--no-filters', '--stdin-paths'], `${input}\n`);
    const lines = answer.stdout.split('\n').filter((line) => /^[0-9a-f]+$/.test(line));
    lines.forEach((id, index) => {
      const file = rest[index];
      if (file !== undefined) ids.set(file, id);
    });
    if (answer.code === 0) break;
    // git stops at the first file it cannot read, having printed the ids before it.
    rest = rest.slice(lines.length + 1);
  }
  return ids;
}

async function storedIds(git: Git, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const answer = await git.run(['cat-file', '--batch-check'], `${ids.join('\n')}\n`);
  if (answer.code !== 0) throw new Error('git cat-file failed');
  return parseBatchCheck(answer.stdout);
}

/** Paths in groups whose command line stays inside the budget. */
function chunks(paths: readonly string[]): string[][] {
  const groups: string[][] = [];
  let group: string[] = [];
  let length = 0;
  for (const file of paths) {
    if (group.length > 0 && length + file.length + 3 > ARGUMENT_BUDGET) {
      groups.push(group);
      group = [];
      length = 0;
    }
    group.push(file);
    length += file.length + 3;
  }
  if (group.length > 0) groups.push(group);
  return groups;
}
