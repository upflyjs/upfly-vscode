import { describe, expect, it } from 'vitest';
import type { OptimizeResult } from './contract.js';
import {
  clickedText,
  convertedNamedIn,
  notWaiting,
  originalNamedIn,
  removableOnOpen,
  removalArgs,
  removalOutcome,
  waitingLabel,
  waitingTooltip,
} from './removal.js';
import type { Stamp, WaitingOriginal } from './waiting.js';

const SITE = 'file:///work/site';

function waiting(name: string, extra: Partial<WaitingOriginal> = {}): WaitingOriginal {
  return {
    folder: SITE,
    original: `public/${name}.png`,
    converted: `public/${name}.webp`,
    since: '2026-10-26T10:00:00.000Z',
    ...extra,
  };
}

/** Every file there, each at the size and time given, or the same stamp. */
function disk(files: Record<string, Stamp> | readonly string[]) {
  const stamps = Array.isArray(files)
    ? new Map(files.map((file) => [file, { size: 10, mtimeMs: 1 }]))
    : new Map(Object.entries(files));
  return (relative: string): Stamp | null => stamps.get(relative) ?? null;
}

/** An optimize result with only the parts a removal run's answer is read from. */
function result(parts: {
  removals?: readonly string[];
  declined?: Record<string, string>;
  removed?: readonly string[] | null;
  unmatched?: readonly string[];
  kept?: readonly string[];
}): OptimizeResult {
  return {
    type: 'result',
    command: 'optimize',
    exitCode: 0,
    apply: parts.removed !== null && parts.removed !== undefined,
    plan: {
      conversions: [],
      rewrites: [],
      declined: Object.entries(parts.declined ?? {}).map(([path, reason]) => ({
        path,
        line: null,
        reason,
      })),
      keptOriginals: [],
      removals: (parts.removals ?? []).map((asset) => ({
        asset,
        converted: asset.replace(/\.png$/, '.webp'),
        inPublicDir: true,
      })),
    },
    run:
      parts.removed === null || parts.removed === undefined
        ? null
        : { id: 'r1', created: [], changed: [], removed: parts.removed },
    commit: null,
    only: { images: [], unmatched: parts.unmatched ?? [] },
    notes: [],
    report: {
      keptOriginals: {
        count: 0,
        bytes: 0,
        assets: (parts.kept ?? []).map((asset) => ({
          asset,
          convertedTo: asset.replace(/\.png$/, '.webp'),
        })),
      },
    } as unknown as OptimizeResult['report'],
  };
}

describe('removalArgs', () => {
  it('removes the originals named, over uncommitted changes and with no undo record', () => {
    expect(removalArgs(['public/a.png', 'public/b c.png'], true)).toEqual([
      '--apply',
      '--allow-dirty',
      '--no-undo',
      '--remove-originals',
      '--image',
      'public/a.png',
      '--image',
      'public/b c.png',
    ]);
  });

  it('plans their removal and writes nothing, without --apply', () => {
    expect(removalArgs(['public/a.png'], false)).toEqual([
      '--remove-originals',
      '--image',
      'public/a.png',
    ]);
  });
});

describe('what a saved text names', () => {
  const list = [waiting('hero'), waiting('logo')];

  it('picks the originals whose converted image the text names by its file name', () => {
    const named = convertedNamedIn('<img src="/hero.webp">', list);
    expect(named.map((entry) => entry.original)).toEqual(['public/hero.png']);
  });

  it('picks none when the text names only the originals', () => {
    expect(convertedNamedIn('<img src="/hero.png">', list)).toEqual([]);
  });

  it('tells when the text names an original by its file name', () => {
    expect(originalNamedIn('<img src="/logo.png">', list)).toBe(true);
    expect(originalNamedIn('<img src="/logo.webp">', list)).toBe(false);
  });
});

describe('notWaiting', () => {
  const stamp = { size: 10, mtimeMs: 1 };

  it('keeps waiting while both files are there as the conversion left them', () => {
    const entry = waiting('a', { originalStamp: stamp, convertedStamp: stamp });
    expect(notWaiting(entry, disk(['public/a.png', 'public/a.webp']))).toBeNull();
  });

  it('stops waiting for an original that is gone', () => {
    expect(notWaiting(waiting('a'), disk(['public/a.webp']))).toBe('public/a.png is gone');
  });

  it('stops waiting when the converted image is gone', () => {
    expect(notWaiting(waiting('a'), disk(['public/a.png']))).toBe(
      'public/a.webp is gone, so nothing stands in for public/a.png',
    );
  });

  it('stops waiting for an original changed since its conversion, so the edit is never lost', () => {
    const entry = waiting('a', { originalStamp: stamp });
    const edited = disk({ 'public/a.png': { size: 11, mtimeMs: 2 }, 'public/a.webp': stamp });
    expect(notWaiting(entry, edited)).toBe(
      'public/a.png changed since it was converted, so public/a.webp no longer shows it',
    );
  });

  it('cannot tell an edit of an original recorded without its size and time', () => {
    const edited = disk({ 'public/a.png': { size: 11, mtimeMs: 2 }, 'public/a.webp': stamp });
    expect(notWaiting(waiting('a'), edited)).toBeNull();
  });
});

describe('removalOutcome', () => {
  const both = disk(['public/a.png', 'public/a.webp', 'public/b.png', 'public/b.webp']);

  it('takes each removed original off the list', () => {
    const outcome = removalOutcome(
      [waiting('a')],
      result({ removals: ['public/a.png'], removed: ['public/a.png'] }),
      disk(['public/a.webp']),
    );
    expect(outcome.removed).toEqual(['public/a.png']);
    expect(outcome.staying).toEqual([]);
  });

  it('keeps one the CLI declined waiting, with its reason', () => {
    const reason = '`index.html` names it as `a.png`, so a page still uses it';
    const outcome = removalOutcome(
      [waiting('a')],
      result({ declined: { 'public/a.png': reason }, removed: [] }),
      both,
    );
    expect(outcome.staying).toEqual([{ original: 'public/a.png', reason }]);
  });

  it('stops waiting for one the CLI no longer finds an image of the project', () => {
    const outcome = removalOutcome(
      [waiting('a')],
      result({ unmatched: ['public/a.png'], removed: [] }),
      disk([]),
    );
    expect(outcome.dropped).toEqual([
      { original: 'public/a.png', why: 'public/a.png is no longer an image in the project' },
    ]);
  });

  it('stops waiting for one declined because its converted image is gone', () => {
    const outcome = removalOutcome(
      [waiting('a')],
      result({
        declined: {
          'public/a.png': 'no public/a.webp stands beside it, so nothing has replaced it',
        },
      }),
      disk(['public/a.png']),
    );
    expect(outcome.dropped.map((entry) => entry.original)).toEqual(['public/a.png']);
    expect(outcome.staying).toEqual([]);
  });

  it('stops waiting for one declined after its converted image changed: another picture', () => {
    const entry = waiting('a', { convertedStamp: { size: 10, mtimeMs: 1 } });
    const now = disk({
      'public/a.png': { size: 10, mtimeMs: 1 },
      'public/a.webp': { size: 3, mtimeMs: 9 },
    });
    const outcome = removalOutcome(
      [entry],
      result({
        declined: { 'public/a.png': 'public/a.webp is 10×10 where this image is 160×120' },
      }),
      now,
    );
    expect(outcome.dropped).toEqual([
      {
        original: 'public/a.png',
        why: 'public/a.webp changed since Upfly wrote it, so it may be another picture',
      },
    ]);
  });

  it('leaves the removal of a changed converted image to the CLI when it finds the same picture', () => {
    const entry = waiting('a', { convertedStamp: { size: 10, mtimeMs: 1 } });
    const now = disk({
      'public/a.png': { size: 10, mtimeMs: 1 },
      'public/a.webp': { size: 3, mtimeMs: 9 },
    });
    const outcome = removalOutcome([entry], result({ removals: ['public/a.png'] }), now);
    expect(outcome.removable).toEqual(['public/a.png']);
  });

  it('lists what a dry run would remove, and keeps one it says nothing of waiting', () => {
    const outcome = removalOutcome(
      [waiting('a'), waiting('b')],
      result({ removals: ['public/a.png'] }),
      both,
    );
    expect(outcome.removable).toEqual(['public/a.png']);
    expect(outcome.staying).toEqual([{ original: 'public/b.png', reason: null }]);
  });
});

describe('removableOnOpen', () => {
  it('takes only the removable originals whose converted image a line uses', () => {
    const dry = result({ removals: ['public/a.png', 'public/b.png'], kept: ['public/b.png'] });
    expect(removableOnOpen(dry)).toEqual(['public/b.png']);
  });

  it('takes none from a CLI that lists no removals', () => {
    const dry = result({ kept: ['public/b.png'] });
    const plan = { ...dry.plan };
    Reflect.deleteProperty(plan, 'removals');
    expect(removableOnOpen({ ...dry, plan })).toEqual([]);
  });
});

describe('clickedText', () => {
  const none = { removed: [], dropped: [], staying: [], removable: [] };

  it('says what was removed', () => {
    expect(clickedText({ ...none, removed: ['public/a.png'] })).toBe(
      'Removed 1 original kept beside its converted image.',
    );
  });

  it("gives the one that stays the CLI's reason, and points to the count for several", () => {
    const one = { original: 'public/b.png', reason: '`index.html` names it' };
    expect(
      clickedText({ ...none, removed: ['public/a.png', 'public/c.png'], staying: [one] }),
    ).toBe(
      'Removed 2 originals kept beside their converted images. public/b.png stays: `index.html` names it.',
    );
    expect(clickedText({ ...none, staying: [one, { ...one, original: 'public/d.png' }] })).toBe(
      '2 originals stay: the count in the status bar says why.',
    );
  });

  it('says how many no longer wait, and when there was nothing to remove', () => {
    expect(clickedText({ ...none, dropped: [{ original: 'public/a.png', why: 'gone' }] })).toBe(
      '1 original no longer waits to be removed: the Upfly output says why.',
    );
    expect(clickedText(none)).toBe(
      'No original kept beside a converted image was waiting to be removed.',
    );
  });
});

describe('the status bar', () => {
  it('counts the originals kept', () => {
    expect(waitingLabel(1)).toBe('1 original kept');
    expect(waitingLabel(3)).toBe('3 originals kept');
  });

  it('says what they are, that a click removes them, and why each one stayed', () => {
    const text = waitingTooltip(
      [
        { ...waiting('a'), folderName: 'site' },
        { ...waiting('b', { reason: 'a page still uses it' }), folderName: 'site' },
      ],
      true,
    );
    expect(text).toBe(
      [
        '2 images from outside the editor were converted, and their originals are kept beside the converted images.',
        'Upfly removes each one once a line names its converted image and none names the original, checked when a file is saved and when the folder opens. Click to remove them now.',
        '',
        'public/a.png',
        'public/b.png, kept because a page still uses it',
      ].join('\n'),
    );
  });

  it('says removing them comes with a later Upfly when the CLI it carries cannot', () => {
    const text = waitingTooltip([{ ...waiting('a'), folderName: 'site' }], false);
    expect(text).toContain('An image from outside the editor was converted, and its original is');
    expect(text).toContain('Removing them comes with a later version of Upfly.');
    expect(text).not.toContain('Click');
  });

  it('names the folder of each one in a workspace of several, and says how many more', () => {
    const many = Array.from({ length: 10 }, (_, index) => ({
      ...waiting(`p${index}`),
      folderName: index === 0 ? 'docs' : 'site',
    }));
    const text = waitingTooltip(many, true);
    expect(text).toContain('docs: public/p0.png');
    expect(text).toContain('site: public/p1.png');
    expect(text.endsWith('and 2 more')).toBe(true);
  });

  it('says where Upfly stopped removing them by itself', () => {
    const text = waitingTooltip(
      [{ ...waiting('a'), folderName: 'site' }],
      true,
      new Map([['site', 'Another Upfly run is writing.']]),
    );
    expect(text).toContain(
      'Upfly stopped removing them by itself in site: Another Upfly run is writing. Click to try again.',
    );
  });
});
