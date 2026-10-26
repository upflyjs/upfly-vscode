import { describe, expect, it } from 'vitest';
import { WAITING_KEY, WaitingOriginals } from './waiting.js';

/** A store as the extension's workspace state is one, kept in memory. */
function store(start: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(start));
  return {
    values,
    get: <T>(key: string): T | undefined => values.get(key) as T | undefined,
    update: async (key: string, value: unknown): Promise<void> => {
      values.set(key, value);
    },
  };
}

const SITE = 'file:///work/site';
const DOCS = 'file:///work/docs';

describe('WaitingOriginals', () => {
  it('records each kept original with its converted image, its folder and when', async () => {
    const memory = store();
    const waiting = new WaitingOriginals(memory, () => new Date('2026-10-26T10:00:00.000Z'));
    await waiting.add(SITE, [{ original: 'public/a.png', converted: 'public/a.webp' }]);
    expect(waiting.all()).toEqual([
      {
        folder: SITE,
        original: 'public/a.png',
        converted: 'public/a.webp',
        since: '2026-10-26T10:00:00.000Z',
      },
    ]);
    expect(memory.values.get(WAITING_KEY)).toEqual(waiting.all());
  });

  it('keeps one entry for an original converted again, the newest', async () => {
    const waiting = new WaitingOriginals(store(), () => new Date('2026-10-26T11:00:00.000Z'));
    await waiting.add(SITE, [{ original: 'public/a.png', converted: 'public/a.webp' }]);
    await waiting.add(SITE, [{ original: 'public/a.png', converted: 'public/a.avif' }]);
    expect(waiting.all().map((entry) => entry.converted)).toEqual(['public/a.avif']);
  });

  it("lists one folder's, and removes the ones named", async () => {
    const waiting = new WaitingOriginals(store(), () => new Date(0));
    await waiting.add(SITE, [
      { original: 'public/a.png', converted: 'public/a.webp' },
      { original: 'public/b.png', converted: 'public/b.webp' },
    ]);
    await waiting.add(DOCS, [{ original: 'public/a.png', converted: 'public/a.webp' }]);
    expect(waiting.inFolder(DOCS).map((entry) => entry.original)).toEqual(['public/a.png']);
    await waiting.remove(SITE, ['public/a.png']);
    expect(waiting.all().map((entry) => [entry.folder, entry.original])).toEqual([
      [SITE, 'public/b.png'],
      [DOCS, 'public/a.png'],
    ]);
  });

  it('reads what an earlier start recorded, and nothing it cannot read', () => {
    const entry = { folder: SITE, original: 'a.png', converted: 'a.webp', since: 'then' };
    expect(new WaitingOriginals(store({ [WAITING_KEY]: [entry] })).all()).toEqual([entry]);
    expect(new WaitingOriginals(store({ [WAITING_KEY]: 'nonsense' })).all()).toEqual([]);
    expect(new WaitingOriginals(store({ [WAITING_KEY]: [{ folder: SITE }] })).all()).toEqual([]);
    const badStamp = { ...entry, originalStamp: { size: 'big' } };
    expect(new WaitingOriginals(store({ [WAITING_KEY]: [badStamp] })).all()).toEqual([]);
  });

  it('keeps the size and time of the original and of its converted image', async () => {
    const waiting = new WaitingOriginals(store(), () => new Date(0));
    await waiting.add(SITE, [
      {
        original: 'public/a.png',
        converted: 'public/a.webp',
        originalStamp: { size: 100, mtimeMs: 1 },
        convertedStamp: { size: 20, mtimeMs: 2 },
      },
    ]);
    expect(waiting.all()[0]).toMatchObject({
      originalStamp: { size: 100, mtimeMs: 1 },
      convertedStamp: { size: 20, mtimeMs: 2 },
    });
  });

  it('records why an original stayed, and clears it', async () => {
    const waiting = new WaitingOriginals(store(), () => new Date(0));
    await waiting.add(SITE, [{ original: 'public/a.png', converted: 'public/a.webp' }]);
    await waiting.note(SITE, [{ original: 'public/a.png', reason: 'a page still uses it' }]);
    expect(waiting.all()[0]?.reason).toBe('a page still uses it');
    await waiting.note(SITE, [{ original: 'public/a.png', reason: null }]);
    expect(waiting.all()[0]).not.toHaveProperty('reason');
  });

  it('tells its listeners of each change, and only of a change', async () => {
    const waiting = new WaitingOriginals(store(), () => new Date(0));
    let calls = 0;
    const listening = waiting.onChange(() => {
      calls += 1;
    });
    await waiting.add(SITE, [{ original: 'public/a.png', converted: 'public/a.webp' }]);
    await waiting.note(SITE, [{ original: 'public/a.png', reason: 'kept' }]);
    await waiting.note(SITE, [{ original: 'public/a.png', reason: 'kept' }]);
    await waiting.remove(SITE, ['public/other.png']);
    await waiting.remove(SITE, ['public/a.png']);
    expect(calls).toBe(3);
    listening.dispose();
    await waiting.add(SITE, [{ original: 'public/b.png', converted: 'public/b.webp' }]);
    expect(calls).toBe(3);
  });
});
