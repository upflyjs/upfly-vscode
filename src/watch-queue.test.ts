import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Batch,
  type BatchEnd,
  type Heard,
  type NewImage,
  NewImageQueue,
  type QueueSteps,
  retryDelay,
  waitUntilSteady,
} from './watch-queue.js';

/** Steps that take every image heard for new, and end each run as the test says. */
function steps(options: { ends?: BatchEnd[]; answer?: boolean } = {}) {
  const runs: Batch[] = [];
  const questions: number[] = [];
  const logged: string[] = [];
  const ends = [...(options.ends ?? [])];
  let release: (() => void) | null = null;
  let gate: Promise<void> | null = null;
  const made: QueueSteps = {
    examine: async (_folder, heard) =>
      heard.map((entry): NewImage => ({ path: entry.path, kind: entry.kind, bytes: 100 })),
    ask: async (_folder, images) => {
      questions.push(images.length);
      return options.answer ?? true;
    },
    run: async (batch) => {
      runs.push(batch);
      if (gate !== null) await gate;
      return ends.shift() ?? { kind: 'done' };
    },
    log: (text) => logged.push(text),
  };
  return {
    made,
    runs,
    questions,
    logged,
    /** Makes the next runs wait until `open` is called. */
    hold() {
      gate = new Promise((resolve) => {
        release = () => {
          gate = null;
          resolve();
        };
      });
    },
    open() {
      release?.();
    },
  };
}

const clock = {
  setTimeout: (run: () => void, ms: number) => setTimeout(run, ms),
  clearTimeout: (timer: unknown) => clearTimeout(timer as NodeJS.Timeout),
};

const heard = (path: string, kind: Heard['kind'] = 'arrival', folder = 'site'): Heard => ({
  folder,
  path,
  kind,
});

const paths = (batch: Batch | undefined) => batch?.images.map((image) => image.path);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('NewImageQueue', () => {
  it('waits for events to settle for 700 ms, then converts the burst in one run', async () => {
    const s = steps();
    const queue = new NewImageQueue(s.made, clock, Date.now);
    queue.hear(heard('public/a.png'));
    await vi.advanceTimersByTimeAsync(600);
    queue.hear(heard('public/b.png'));
    await vi.advanceTimersByTimeAsync(600);
    expect(s.runs).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(s.runs.map(paths)).toEqual([['public/a.png', 'public/b.png']]);
  });

  it('runs pastes before arrivals, one run for each kind', async () => {
    const s = steps();
    const queue = new NewImageQueue(s.made, clock, Date.now);
    queue.hear(heard('public/a.png', 'arrival'));
    queue.hear(heard('public/b.png', 'paste'));
    queue.hear(heard('public/c.png', 'arrival'));
    await vi.advanceTimersByTimeAsync(700);
    expect(s.runs.map((batch) => [batch.kind, paths(batch)])).toEqual([
      ['paste', ['public/b.png']],
      ['arrival', ['public/a.png', 'public/c.png']],
    ]);
  });

  it('takes an image both pasted and seen by the file watcher for a paste', async () => {
    const s = steps();
    const queue = new NewImageQueue(s.made, clock, Date.now);
    queue.hear(heard('public/a.png', 'arrival'));
    queue.hear(heard('public/a.png', 'paste'));
    queue.hear(heard('public/a.png', 'arrival'));
    await vi.advanceTimersByTimeAsync(700);
    expect(s.runs.map((batch) => [batch.kind, paths(batch)])).toEqual([
      ['paste', ['public/a.png']],
    ]);
  });

  it('runs each workspace folder on its own', async () => {
    const s = steps();
    const queue = new NewImageQueue(s.made, clock, Date.now);
    queue.hear(heard('public/a.png', 'arrival', 'site'));
    queue.hear(heard('public/b.png', 'arrival', 'docs'));
    await vi.advanceTimersByTimeAsync(700);
    expect(s.runs.map((batch) => [batch.folder, paths(batch)])).toEqual([
      ['site', ['public/a.png']],
      ['docs', ['public/b.png']],
    ]);
  });

  it('keeps what arrives during a run for the next batch, which takes all of it', async () => {
    const s = steps();
    const queue = new NewImageQueue(s.made, clock, Date.now);
    s.hold();
    queue.hear(heard('public/a.png'));
    await vi.advanceTimersByTimeAsync(700);
    queue.hear(heard('public/b.png'));
    await vi.advanceTimersByTimeAsync(700);
    queue.hear(heard('public/c.png'));
    await vi.advanceTimersByTimeAsync(700);
    expect(s.runs.length).toBe(1);
    s.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.runs.map(paths)).toEqual([['public/a.png'], ['public/b.png', 'public/c.png']]);
  });

  it('asks once when more than 50 new images arrive in a folder at once', async () => {
    const s = steps();
    const queue = new NewImageQueue(s.made, clock, Date.now);
    for (let index = 0; index < 51; index += 1) queue.hear(heard(`public/${index}.png`));
    await vi.advanceTimersByTimeAsync(700);
    expect(s.questions).toEqual([51]);
    expect(s.runs.map((batch) => batch.images.length)).toEqual([51]);
  });

  it('asks nothing for 50', async () => {
    const s = steps();
    const queue = new NewImageQueue(s.made, clock, Date.now);
    for (let index = 0; index < 50; index += 1) queue.hear(heard(`public/${index}.png`));
    await vi.advanceTimersByTimeAsync(700);
    expect(s.questions).toEqual([]);
    expect(s.runs.length).toBe(1);
  });

  it('drops the burst when the person leaves them, and says so', async () => {
    const s = steps({ answer: false });
    const queue = new NewImageQueue(s.made, clock, Date.now);
    for (let index = 0; index < 60; index += 1) queue.hear(heard(`public/${index}.png`));
    await vi.advanceTimersByTimeAsync(700);
    expect(s.runs).toEqual([]);
    expect(s.logged.at(-1)).toBe('Left as they are, as asked: 60 new images in site.');
  });

  it('tries a locked batch again after 2, 4 and 8 seconds, then every 10', async () => {
    expect([1, 2, 3, 4, 5, 9].map(retryDelay)).toEqual([
      2_000, 4_000, 8_000, 10_000, 10_000, 10_000,
    ]);
    const left = [{ path: 'public/a.png', kind: 'arrival', bytes: 100 }] as const;
    const s = steps({
      ends: [
        { kind: 'locked', left },
        { kind: 'locked', left },
      ],
    });
    const queue = new NewImageQueue(s.made, clock, Date.now);
    queue.hear(heard('public/a.png'));
    await vi.advanceTimersByTimeAsync(700);
    expect(s.runs.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(s.runs.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.runs.length).toBe(2);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(s.runs.map(paths)).toEqual([['public/a.png'], ['public/a.png'], ['public/a.png']]);
  });

  it('takes what arrived meanwhile into the batch it tries again', async () => {
    const s = steps({
      ends: [{ kind: 'locked', left: [{ path: 'public/a.png', kind: 'arrival', bytes: 1 }] }],
    });
    const queue = new NewImageQueue(s.made, clock, Date.now);
    queue.hear(heard('public/a.png'));
    await vi.advanceTimersByTimeAsync(700);
    queue.hear(heard('public/b.png'));
    await vi.advanceTimersByTimeAsync(700);
    expect(s.runs.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1_300);
    expect(s.runs.map(paths)).toEqual([['public/a.png'], ['public/a.png', 'public/b.png']]);
  });

  it('gives up on a batch another run locked out for ten minutes', async () => {
    const left = [{ path: 'public/a.png', kind: 'arrival', bytes: 1 }] as const;
    const s = steps({
      ends: Array.from({ length: 100 }, () => ({ kind: 'locked', left }) as const),
    });
    const queue = new NewImageQueue(s.made, clock, Date.now);
    queue.hear(heard('public/a.png'));
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    const count = s.runs.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.runs.length).toBe(count);
    expect(s.logged.at(-1)).toBe(
      'Not converted: 1 new image in site, since another Upfly run held the project for 10 minutes.',
    );
    expect(queue.busy()).toBe(false);
  });

  describe('after a refusal every batch would meet again', () => {
    const refused: BatchEnd = {
      kind: 'blocked',
      until: 'config',
      why: 'Upfly could not tell which folder the site is served from.',
    };

    it('converts nothing more in that folder, queuing nothing and logging what arrived', async () => {
      const s = steps({ ends: [refused] });
      const queue = new NewImageQueue(s.made, clock, Date.now);
      queue.hear(heard('public/a.png'));
      await vi.advanceTimersByTimeAsync(700);
      expect(queue.blocked('site')).toEqual({ until: 'config', why: refused.why });
      queue.hear(heard('public/b.png'));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(s.runs.length).toBe(1);
      expect(queue.busy()).toBe(false);
      expect(s.logged.at(-1)).toBe(
        'Not converted: public/b.png, which arrived in site, since Upfly converts no new image there until its Upfly config changes or VS Code starts again.',
      );
    });

    it('drops the images of that folder already waiting, and leaves other folders alone', async () => {
      const s = steps({ ends: [refused] });
      const queue = new NewImageQueue(s.made, clock, Date.now);
      s.hold();
      queue.hear(heard('public/a.png', 'arrival', 'site'));
      await vi.advanceTimersByTimeAsync(700);
      queue.hear(heard('public/b.png', 'paste', 'site'));
      queue.hear(heard('public/c.png', 'paste', 'docs'));
      await vi.advanceTimersByTimeAsync(700);
      s.open();
      await vi.advanceTimersByTimeAsync(0);
      expect(s.runs.map((batch) => [batch.folder, paths(batch)])).toEqual([
        ['site', ['public/a.png']],
        ['docs', ['public/c.png']],
      ]);
    });

    it('converts there again once the config changes, but not for a change of the record', async () => {
      const s = steps({ ends: [refused] });
      const queue = new NewImageQueue(s.made, clock, Date.now);
      queue.hear(heard('public/a.png'));
      await vi.advanceTimersByTimeAsync(700);
      expect(queue.unblock('site', 'record')).toBe(false);
      expect(queue.unblock('site', 'config')).toBe(true);
      queue.hear(heard('public/b.png'));
      await vi.advanceTimersByTimeAsync(700);
      expect(s.runs.map(paths)).toEqual([['public/a.png'], ['public/b.png']]);
    });

    it('waits for the record to change after a run that stopped part way', async () => {
      const s = steps({ ends: [{ kind: 'blocked', until: 'record', why: 'stopped part way' }] });
      const queue = new NewImageQueue(s.made, clock, Date.now);
      queue.hear(heard('public/a.png'));
      await vi.advanceTimersByTimeAsync(700);
      expect(queue.unblock('site', 'config')).toBe(false);
      expect(queue.blocked('site')?.until).toBe('record');
      expect(queue.unblock('site', 'record')).toBe(true);
      expect(queue.blocked('site')).toBe(undefined);
    });
  });

  it('is busy from the first event until the last run ends', async () => {
    const s = steps();
    const queue = new NewImageQueue(s.made, clock, Date.now);
    expect(queue.busy()).toBe(false);
    s.hold();
    queue.hear(heard('public/a.png'));
    expect(queue.busy()).toBe(true);
    await vi.advanceTimersByTimeAsync(700);
    expect(queue.busy()).toBe(true);
    s.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.busy()).toBe(false);
  });

  it('runs nothing once disposed', async () => {
    const s = steps();
    const queue = new NewImageQueue(s.made, clock, Date.now);
    queue.hear(heard('public/a.png'));
    queue.dispose();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s.runs).toEqual([]);
  });
});

describe('waitUntilSteady', () => {
  /** A disk whose files change as the script says, and a clock that sleep moves on. */
  function disk(script: Record<string, Array<number | null>>) {
    let now = 0;
    const calls = new Map<string, number>();
    return {
      look: (file: string) => {
        const steps = script[file] ?? [null];
        const index = Math.min(calls.get(file) ?? 0, steps.length - 1);
        calls.set(file, (calls.get(file) ?? 0) + 1);
        const size = steps[index];
        return size === null || size === undefined ? null : { size, mtimeMs: size };
      },
      sleep: async (ms: number) => {
        now += ms;
      },
      now: () => now,
    };
  }

  it('takes a file whose size and time are the same on two looks half a second apart', async () => {
    const d = disk({ 'a.png': [10, 10] });
    expect(await waitUntilSteady(['a.png'], d.look, d.sleep, d.now)).toEqual({
      steady: new Map([['a.png', 10]]),
      gone: [],
      growing: [],
    });
    expect(d.now()).toBe(500);
  });

  it('waits while a file grows, and takes it once it stops', async () => {
    const d = disk({ 'a.png': [10, 20, 30, 30] });
    const result = await waitUntilSteady(['a.png'], d.look, d.sleep, d.now);
    expect(result.steady).toEqual(new Map([['a.png', 30]]));
    expect(d.now()).toBe(1_500);
  });

  it('leaves a file still growing after a minute', async () => {
    const sizes = Array.from({ length: 200 }, (_, index) => index);
    const d = disk({ 'a.png': sizes, 'b.png': [5, 5] });
    const result = await waitUntilSteady(['a.png', 'b.png'], d.look, d.sleep, d.now);
    expect(result).toEqual({ steady: new Map([['b.png', 5]]), gone: [], growing: ['a.png'] });
    expect(d.now()).toBe(60_000);
  });

  it('drops a file gone before it settled', async () => {
    const d = disk({ 'a.png': [10, null], 'b.png': [null] });
    const result = await waitUntilSteady(['a.png', 'b.png'], d.look, d.sleep, d.now);
    expect(result).toEqual({ steady: new Map(), gone: ['b.png', 'a.png'], growing: [] });
  });
});
