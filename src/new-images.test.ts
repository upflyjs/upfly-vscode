import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunList } from './contract.js';
import {
  type GitAnswers,
  gitIn,
  isRepository,
  newImages,
  parseBatchCheck,
  parseNul,
  restoredOriginals,
  sortByGit,
} from './new-images.js';

const ANSWERS: GitAnswers = {
  ignored: new Set(['public/build/a.png']),
  tracked: new Set(['public/tracked.png']),
  ids: new Map([
    ['public/copy.png', 'aaa'],
    ['public/fresh.png', 'bbb'],
  ]),
  stored: new Set(['aaa']),
};

describe('newImages', () => {
  it('takes as new only an untracked path whose bytes git has never stored', () => {
    expect(
      newImages(
        ['public/build/a.png', 'public/tracked.png', 'public/copy.png', 'public/fresh.png'],
        ANSWERS,
      ),
    ).toEqual({
      fresh: ['public/fresh.png'],
      ignored: ['public/build/a.png'],
      known: ['public/tracked.png', 'public/copy.png'],
    });
  });

  it('takes a path git could not hash for one it knows, so nothing is converted on a guess', () => {
    expect(newImages(['public/gone.png'], ANSWERS).known).toEqual(['public/gone.png']);
  });
});

describe("git's output", () => {
  it('splits a NUL-separated list, ignoring the empty end', () => {
    expect(parseNul('a.png\0b c.png\0')).toEqual(['a.png', 'b c.png']);
    expect(parseNul('')).toEqual([]);
  });

  it('reads the ids cat-file has, and not the missing ones', () => {
    const output = 'aaa blob 120\nbbb missing\nccc blob 9\n';
    expect([...parseBatchCheck(output)]).toEqual(['aaa', 'ccc']);
  });
});

describe('restoredOriginals', () => {
  const run = (originals: RunList['originals']): RunList => ({
    id: 'r',
    startedAt: '2026-10-26T00:00:00.000Z',
    state: 'undone',
    files: [],
    originals,
    created: [],
  });

  it('names the originals the last run lists as back, which undo put there', () => {
    const list = run([
      { path: 'public/a.png', movedTo: null, back: true, changedSince: false },
      { path: 'public/b.png', movedTo: null, back: false, changedSince: false },
    ]);
    expect([...restoredOriginals(list)]).toEqual(['public/a.png']);
  });

  it('names none when no run has written to the project', () => {
    expect([...restoredOriginals(null)]).toEqual([]);
    expect([...restoredOriginals(undefined)]).toEqual([]);
  });
});

describe('git on a real repository', () => {
  let root: string;
  let repo: string;
  const env = () => ({ GIT_CEILING_DIRECTORIES: root });
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, env: { ...process.env, ...env() }, stdio: 'pipe' });
  /** An image of its own bytes, which no other file in the test has. */
  const image = (file: string, seed: string) => {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(path.join(repo, file), `\x89PNG fake image ${seed}`);
  };

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'upfly-new-images-'));
    repo = path.join(root, 'site');
    mkdirSync(repo);
    git('init', '-q');
    git('config', 'user.name', 'Upfly tests');
    git('config', 'user.email', 'tests@example.com');
    git('config', 'commit.gpgsign', 'false');
    image('public/committed.png', 'committed');
    writeFileSync(path.join(repo, '.gitignore'), 'public/build/\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'start');
    git('checkout', '-q', '-b', 'more');
    image('public/branch.png', 'branch');
    git('add', '-A');
    git('commit', '-q', '-m', 'more');
    git('checkout', '-q', '-');
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('knows a folder inside a repository from one outside every repository', async () => {
    expect(await isRepository(gitIn(repo, env()))).toBe(true);
    const outside = path.join(root, 'no-git');
    mkdirSync(outside, { recursive: true });
    expect(await isRepository(gitIn(outside, env()))).toBe(false);
  });

  it('finds a brand new image new, and a copy, an ignored path and a staged one not', async () => {
    image('public/fresh.png', 'fresh');
    image('public/build/output.png', 'output');
    copyFileSync(path.join(repo, 'public/committed.png'), path.join(repo, 'public/copy.png'));
    image('public/staged.png', 'staged');
    git('add', 'public/staged.png');
    const sorted = await sortByGit(gitIn(repo, env()), [
      'public/fresh.png',
      'public/build/output.png',
      'public/copy.png',
      'public/staged.png',
      'public/committed.png',
    ]);
    expect(sorted).toEqual({
      fresh: ['public/fresh.png'],
      ignored: ['public/build/output.png'],
      known: ['public/copy.png', 'public/staged.png', 'public/committed.png'],
    });
  });

  it('finds nothing new in the images a checkout brings', async () => {
    git('checkout', '-q', 'more');
    try {
      const sorted = await sortByGit(gitIn(repo, env()), ['public/branch.png']);
      expect(sorted.known).toEqual(['public/branch.png']);
    } finally {
      git('checkout', '-q', '-');
    }
  });

  it('knows a file deleted and written back with the bytes git stored, as a stash pop does', async () => {
    rmSync(path.join(repo, 'public/committed.png'));
    git('rm', '-q', '--cached', 'public/committed.png');
    image('public/committed.png', 'committed');
    try {
      const sorted = await sortByGit(gitIn(repo, env()), ['public/committed.png']);
      expect(sorted.known).toEqual(['public/committed.png']);
    } finally {
      git('add', 'public/committed.png');
    }
  });

  it('reads a path with brackets and spaces as written, not as a pattern', async () => {
    image('public/[slug] page/new one.png', 'bracket');
    image('public/s/new one.png', 'other');
    const sorted = await sortByGit(gitIn(repo, env()), ['public/[slug] page/new one.png']);
    expect(sorted.fresh).toEqual(['public/[slug] page/new one.png']);
  });

  it('answers for paths relative to a folder inside the repository', async () => {
    image('public/inner/fresh2.png', 'fresh2');
    const sorted = await sortByGit(gitIn(path.join(repo, 'public'), env()), [
      'inner/fresh2.png',
      'committed.png',
    ]);
    expect(sorted).toEqual({
      fresh: ['inner/fresh2.png'],
      ignored: [],
      known: ['committed.png'],
    });
  });

  it('takes a file gone before git could hash it for one it knows', async () => {
    const sorted = await sortByGit(gitIn(repo, env()), ['public/fresh.png', 'public/never.png']);
    expect(sorted).toEqual({
      fresh: ['public/fresh.png'],
      ignored: [],
      known: ['public/never.png'],
    });
  });
});
