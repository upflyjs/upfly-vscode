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
  });
});
