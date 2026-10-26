import { describe, expect, it } from 'vitest';
import type { ErrorLine, OptimizeResult } from './contract.js';
import {
  argumentGroups,
  batchArgs,
  convertedText,
  convertingLabel,
  keepsOriginals,
  questionText,
  refusalOf,
  reportOf,
  waitsForRemoval,
} from './watch-batch.js';

const DEFAULTS = { keepOriginals: false, outsideReplace: false };

describe('keepsOriginals', () => {
  it("removes a paste's original, and keeps one from outside the editor", () => {
    expect(keepsOriginals('paste', DEFAULTS)).toBe(false);
    expect(keepsOriginals('arrival', DEFAULTS)).toBe(true);
  });

  it('treats one from outside as a paste when the config says outside: replace', () => {
    expect(keepsOriginals('arrival', { ...DEFAULTS, outsideReplace: true })).toBe(false);
  });

  it('keeps every original when the config says keepOriginals', () => {
    const keep = { keepOriginals: true, outsideReplace: true };
    expect([keepsOriginals('paste', keep), keepsOriginals('arrival', keep)]).toEqual([true, true]);
  });
});

describe('waitsForRemoval', () => {
  it('records only an original kept because it came from outside the editor', () => {
    expect(waitsForRemoval('arrival', DEFAULTS)).toBe(true);
    expect(waitsForRemoval('paste', DEFAULTS)).toBe(false);
    expect(waitsForRemoval('arrival', { ...DEFAULTS, outsideReplace: true })).toBe(false);
    expect(waitsForRemoval('arrival', { ...DEFAULTS, keepOriginals: true })).toBe(false);
  });
});

describe('batchArgs', () => {
  it('applies over uncommitted changes, kept out of upfly undo, naming each image exactly', () => {
    expect(batchArgs(['public/a.png', 'public/b c.png'], false)).toEqual([
      '--apply',
      '--allow-dirty',
      '--no-undo',
      '--image',
      'public/a.png',
      '--image',
      'public/b c.png',
    ]);
  });

  it('adds --keep-originals when the originals stay', () => {
    expect(batchArgs(['public/a.png'], true)).toContain('--keep-originals');
  });
});

describe('argumentGroups', () => {
  it('keeps every image in one group while the command line has room', () => {
    expect(argumentGroups(['a.png', 'b.png', 'c.png'])).toEqual([['a.png', 'b.png', 'c.png']]);
  });

  it('splits images whose command line would outgrow the limit, in order', () => {
    const images = Array.from({ length: 5 }, (_, index) => `public/${index}.png`);
    const groups = argumentGroups(images, 60);
    expect(groups.flat()).toEqual(images);
    expect(groups.length).toBeGreaterThan(1);
    for (const group of groups) expect(group.length).toBeGreaterThan(0);
  });
});

/** An applied result, as `upfly optimize --apply --no-undo --json` gives one. */
function result(): OptimizeResult {
  return {
    type: 'result',
    command: 'optimize',
    exitCode: 0,
    apply: true,
    plan: {
      conversions: [
        conversion('public/a.png', 'public/a.webp', 820, true),
        conversion('public/b.png', 'public/b.webp', 300, false),
      ],
      rewrites: [],
      declined: [
        { path: 'public/c.png', line: null, reason: 'public/c.webp already exists' },
        { path: 'index.html', line: 3, reason: 'a line Upfly does not rewrite' },
      ],
      keptOriginals: [
        {
          asset: 'public/b.png',
          reason: 'converted, but the original was kept: a page names it as text',
        },
      ],
    },
    run: {
      id: 'r1',
      created: ['public/a.webp', 'public/b.webp'],
      changed: [],
      removed: ['public/a.png'],
    },
    commit: null,
    only: {
      images: ['public/a.png', 'public/b.png', 'public/c.png', 'public/e.png'],
      unmatched: ['public/d.png'],
    },
    notes: [],
    report: {} as OptimizeResult['report'],
  };
}

function conversion(asset: string, target: string, savedBytes: number, replaces: boolean) {
  return {
    asset,
    target,
    format: 'webp' as const,
    savedBytes,
    replacesOriginal: replaces,
    inPublicDir: true,
  };
}

const IMAGES = ['public/a.png', 'public/b.png', 'public/c.png', 'public/d.png', 'public/e.png'];

describe('reportOf', () => {
  it('lists what converted, what was declined and why, and what the CLI did not take', () => {
    const report = reportOf(IMAGES, 'paste', DEFAULTS, result());
    expect(report.converted).toEqual([
      { image: 'public/a.png', target: 'public/a.webp', savedBytes: 820, originalKept: false },
      { image: 'public/b.png', target: 'public/b.webp', savedBytes: 300, originalKept: true },
    ]);
    expect(report.declined).toEqual([
      { image: 'public/c.png', reason: 'public/c.webp already exists' },
    ]);
    expect(report.unmatched).toEqual(['public/d.png']);
    expect(report.silent).toEqual(['public/e.png']);
  });

  it("names a paste's original that stayed though it was to go, with the CLI's reason", () => {
    expect(reportOf(IMAGES, 'paste', DEFAULTS, result()).keptAnyway).toEqual([
      {
        image: 'public/b.png',
        reason: 'converted, but the original was kept: a page names it as text',
      },
    ]);
  });

  it('records the originals kept for coming from outside as waiting, and no others', () => {
    const arrival = reportOf(IMAGES, 'arrival', DEFAULTS, result());
    expect(arrival.waiting.map((entry) => [entry.image, entry.target])).toEqual([
      ['public/b.png', 'public/b.webp'],
    ]);
    expect(arrival.keptAnyway).toEqual([]);
    expect(reportOf(IMAGES, 'paste', DEFAULTS, result()).waiting).toEqual([]);
  });

  it('counts nothing converted when the run wrote nothing', () => {
    const empty = { ...result(), run: null };
    expect(reportOf(IMAGES, 'paste', DEFAULTS, empty).converted).toEqual([]);
  });
});

describe('refusalOf', () => {
  const error = (reason: string | undefined, exitCode: 2 | 3 | 4 = 3): ErrorLine => ({
    type: 'error',
    command: 'optimize',
    exitCode,
    ...(reason === undefined ? {} : { reason }),
    message: 'The CLI says why.',
  });

  it('tries again after a run that holds the lock', () => {
    expect(refusalOf(error('TRANSACTION_LOCKED'), false)).toBe('retry');
  });

  it('stops the folder until its config changes for a refusal every batch would meet', () => {
    for (const reason of ['SERVING_ROOT_UNKNOWN', 'CODE_CONFIG_NOT_RUN', 'V2_EXTENSION_CONFIG']) {
      expect(refusalOf(error(reason), false), reason).toBe('block-config');
    }
    expect(refusalOf(error(undefined, 2), false)).toBe('block-config');
  });

  it('stops the folder until its record changes after a run that stopped part way', () => {
    expect(refusalOf(error('TRANSACTION_INTERRUPTED'), false)).toBe('block-record');
    expect(refusalOf(error('TRANSACTION_FOREIGN_CHANGE'), true)).toBe('block-record');
  });

  it('refuses only the batch for anything else', () => {
    expect(refusalOf(error('TRANSACTION_FOREIGN_CHANGE'), false)).toBe('refused');
    expect(refusalOf(error('TRANSACTION_PLAN_INVALID'), false)).toBe('refused');
    expect(refusalOf(error(undefined, 4), false)).toBe('refused');
  });
});

describe('the texts a person reads', () => {
  it('says one conversion with its saving', () => {
    const converted = [
      { image: 'public/hero.png', target: 'public/hero.webp', savedBytes: 82, originalKept: false },
    ];
    expect(convertedText(converted, new Map([['public/hero.png', 100]]), 'webp')).toBe(
      'hero.png converted to WebP, 82% smaller',
    );
  });

  it('says several at once with their saving together', () => {
    const converted = ['a', 'b', 'c'].map((name) => ({
      image: `public/${name}.png`,
      target: `public/${name}.avif`,
      savedBytes: 74,
      originalKept: false,
    }));
    const sizes = new Map(converted.map((entry) => [entry.image, 100]));
    expect(convertedText(converted, sizes, 'avif')).toBe(
      '3 new images converted to AVIF, 74% smaller',
    );
  });

  it('says less than 1% rather than 0%, and no saving when a size is not known', () => {
    const one = [{ image: 'big.png', target: 'big.webp', savedBytes: 1_000, originalKept: false }];
    expect(convertedText(one, new Map([['big.png', 1_000_000]]), 'webp')).toBe(
      'big.png converted to WebP, less than 1% smaller',
    );
    expect(convertedText(one, new Map([['big.png', null]]), 'webp')).toBe(
      'big.png converted to WebP',
    );
  });

  it('asks about a burst naming its count, where it arrived and the format', () => {
    expect(questionText(51, 'public/photos', 'webp')).toBe(
      '51 new images arrived in public/photos. Convert them to WebP?',
    );
  });

  it('counts the images while they convert', () => {
    expect([convertingLabel(1), convertingLabel(3)]).toEqual([
      'converting 1 new image',
      'converting 3 new images',
    ]);
  });
});
