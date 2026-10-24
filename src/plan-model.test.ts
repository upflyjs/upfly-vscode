import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Conversion, OptimizeResult, Rewrite } from './contract.js';
import {
  type PlanView,
  onlyPattern,
  planSummary,
  renderPlan,
  rewrittenLines,
  servedOriginals,
  textHash,
} from './plan-model.js';

const INDEX = [
  '<!doctype html>',
  '<img src="images/logo.png" alt="Logo">',
  '<img src="images/hero.jpg" srcset="images/hero.jpg 1x, images/hero@2x.jpg 2x">',
  '',
].join('\n');

function at(text: string, path: string, from = 0): { start: number; end: number } {
  const start = text.indexOf(path, from);
  return { start, end: start + path.length };
}

function rewrite(text: string, paths: [string, string][], file = 'index.html'): Rewrite {
  let from = 0;
  const edits = paths.map(([before, after]) => {
    const span = at(text, before, from);
    from = span.end;
    return { ...span, replacement: after, expected: before, asset: before };
  });
  return { file, edits, textHash: textHash(text) };
}

function conversion(asset: string, extra: Partial<Conversion> = {}): Conversion {
  return {
    asset,
    target: asset.replace(/\.\w+$/, '.webp'),
    format: 'webp',
    savedBytes: 2_000,
    replacesOriginal: true,
    inPublicDir: false,
    ...extra,
  };
}

function result(extra: Partial<OptimizeResult['plan']> = {}, notes: string[] = []): OptimizeResult {
  return {
    type: 'result',
    command: 'optimize',
    exitCode: 0,
    apply: false,
    plan: {
      conversions: [conversion('images/logo.png'), conversion('images/hero.jpg')],
      rewrites: [
        rewrite(INDEX, [
          ['images/logo.png', 'images/logo.webp'],
          ['images/hero.jpg', 'images/hero.webp'],
          ['images/hero.jpg', 'images/hero.webp'],
        ]),
      ],
      declined: [{ path: 'images/badge.png', line: null, reason: 'converting it would save 34 B' }],
      keptOriginals: [],
      ...extra,
    },
    run: null,
    commit: null,
    only: null,
    notes,
    report: {} as OptimizeResult['report'],
  };
}

function view(planned: OptimizeResult, extra: Partial<PlanView> = {}): PlanView {
  return {
    folder: 'site',
    path: '/work/site',
    when: '22:30',
    cliVersion: '3.2.0',
    scope: { kind: 'workspace' },
    keepOriginals: false,
    result: planned,
    texts: new Map([['index.html', INDEX]]),
    banner: [],
    ...extra,
  };
}

describe('onlyPattern', () => {
  it('anchors a path at the project, so a name alone matches no image deeper down', () => {
    expect(onlyPattern('logo.png')).toBe('/logo.png');
  });

  it("escapes the characters gitignore patterns give a meaning, such as a route's brackets", () => {
    expect(onlyPattern('app/blog/[slug]/og*?.png')).toBe('/app/blog/\\[slug\\]/og\\*\\?.png');
  });

  it('escapes a backslash, and the spaces at the end that gitignore would drop', () => {
    expect(onlyPattern('a\\b.png  ')).toBe('/a\\\\b.png\\ \\ ');
  });
});

describe('textHash', () => {
  it('is the SHA-256 of the text as UTF-8, in hexadecimal, as the CLI hashes a file', () => {
    expect(textHash('a é')).toBe(createHash('sha256').update('a é', 'utf8').digest('hex'));
  });
});

describe('rewrittenLines', () => {
  it('gives each changed line its number counted from 1, its text before and after', () => {
    const rows = rewrittenLines(rewrite(INDEX, [['images/logo.png', 'images/logo.webp']]), INDEX);
    expect(rows).toEqual([
      {
        line: 2,
        before: '<img src="images/logo.png" alt="Logo">',
        after: '<img src="images/logo.webp" alt="Logo">',
        paths: [{ before: 'images/logo.png', after: 'images/logo.webp', inComment: false }],
      },
    ]);
  });

  it('keeps the edits on one line together in one row, in their order', () => {
    const rows = rewrittenLines(
      rewrite(INDEX, [
        ['images/hero.jpg', 'images/hero.webp'],
        ['images/hero.jpg', 'images/hero.webp'],
        ['images/hero@2x.jpg', 'images/hero@2x.webp'],
      ]),
      INDEX,
    );
    expect(rows.map((row) => [row.line, row.after])).toEqual([
      [3, '<img src="images/hero.webp" srcset="images/hero.webp 1x, images/hero@2x.webp 2x">'],
    ]);
  });

  it('reads lines that end in CRLF without the carriage return', () => {
    const text = INDEX.replaceAll('\n', '\r\n');
    const rows = rewrittenLines(rewrite(text, [['images/logo.png', 'images/logo.webp']]), text);
    expect(rows[0]?.before).toBe('<img src="images/logo.png" alt="Logo">');
  });

  it('counts offsets in UTF-16 code units, as the CLI does, past characters outside the BMP', () => {
    const text = `<p>\u{1F600}</p><img src="a.png">\n`;
    const rows = rewrittenLines(rewrite(text, [['a.png', 'a.webp']]), text);
    expect(rows[0]?.after).toBe('<p>\u{1F600}</p><img src="a.webp">');
  });

  it('shortens a long line to the part around its changes', () => {
    const text = `${'x'.repeat(500)}url(a.png)${'y'.repeat(500)}\n`;
    const [row] = rewrittenLines(rewrite(text, [['a.png', 'a.webp']]), text);
    expect([row?.before.length, row?.after]).toEqual([
      expect.any(Number),
      `...${'x'.repeat(36)}url(a.webp)${'y'.repeat(39)}...`,
    ]);
    expect(row?.before.length).toBeLessThan(100);
  });

  it('marks a path inside a comment as one', () => {
    const text = '<!-- images/logo.png -->\n';
    const edited = rewrite(text, [['images/logo.png', 'images/logo.webp']]);
    const comment: Rewrite = {
      ...edited,
      edits: edited.edits.map((edit) => ({ ...edit, inComment: true })),
    };
    expect(rewrittenLines(comment, text)[0]?.paths[0]?.inComment).toBe(true);
  });
});

describe('servedOriginals', () => {
  it('are the conversions that remove an original sitting in a folder the site serves', () => {
    const planned = result({
      conversions: [
        conversion('public/a.png', { inPublicDir: true }),
        conversion('public/b.png', { inPublicDir: true, replacesOriginal: false }),
        conversion('src/c.png'),
      ],
    });
    expect(servedOriginals(planned.plan)).toEqual(['public/a.png']);
  });
});

describe('planSummary', () => {
  it('counts what converts, the references and lines and files rewritten, and what is left', () => {
    expect(planSummary(result().plan, new Map([['index.html', INDEX]]))).toEqual({
      images: 2,
      savedBytes: 4_000,
      references: 3,
      comments: 0,
      lines: 2,
      files: 1,
      removed: 2,
      served: 0,
      left: 1,
      leftReferences: 0,
    });
  });

  it('counts a path in a comment apart from the references', () => {
    const text = '<!-- images/logo.png -->\n';
    const edited = rewrite(text, [['images/logo.png', 'images/logo.webp']], 'a.html');
    const planned = result({
      rewrites: [{ ...edited, edits: edited.edits.map((edit) => ({ ...edit, inComment: true })) }],
    });
    const summary = planSummary(planned.plan, new Map([['a.html', text]]));
    expect([summary.references, summary.comments]).toEqual([0, 1]);
  });
});

describe('renderPlan', () => {
  it('says which folder, when, which CLI, and that nothing changes until it is applied', () => {
    expect(renderPlan(view(result())).split('\n').slice(0, 3)).toEqual([
      '# Upfly plan: site',
      '',
      'The folder /work/site, planned at 22:30 by upfly 3.2.0 for every image in it. Nothing changes until you apply the plan.',
    ]);
  });

  it('names the images chosen when the plan is for a selection', () => {
    const text = renderPlan(
      view(result(), { scope: { kind: 'images', images: ['images/logo.png', 'images/hero.jpg'] } }),
    );
    expect(text).toContain('for the 2 images you chose');
  });

  it('says a selection applies over uncommitted changes and makes no commit', () => {
    const text = renderPlan(view(result(), { scope: { kind: 'images', images: ['a.png'] } }));
    expect(text).toContain(
      'Applying writes over uncommitted changes and makes no commit; the review afterwards can undo any line, any file or the whole run.',
    );
  });

  it('says the whole folder applies only without uncommitted changes, as one commit', () => {
    expect(renderPlan(view(result()))).toContain(
      'Applying needs a folder with no uncommitted changes, and commits the run as one commit; the review afterwards can undo any line, any file or the whole run.',
    );
  });

  it('sums up what converts, what is rewritten, which originals go and what is left alone', () => {
    const text = renderPlan(view(result()));
    expect(text).toContain('- Converts 2 images to WebP, 4 KB smaller together.');
    expect(text).toContain('- Rewrites 3 references on 2 lines in 1 file.');
    expect(text).toContain('- Removes 2 originals once no file names them.');
    expect(text).toContain('- Leaves 1 image alone.');
  });

  it('warns about originals in a folder the site serves, naming each one', () => {
    const planned = result({
      conversions: [conversion('public/a.png', { inPublicDir: true }), conversion('src/c.png')],
    });
    const text = renderPlan(view(planned));
    expect(text).toContain('## 1 original to be removed sits in a folder the site serves');
    expect(text).toContain('- `public/a.png`');
    expect(text).not.toContain('- `src/c.png`\n');
  });

  it('has no warning when no original to be removed sits in a served folder', () => {
    expect(renderPlan(view(result()))).not.toContain('a folder the site serves');
  });

  it('says every original stays when the plan keeps them', () => {
    const planned = result({
      conversions: [conversion('public/a.png', { inPublicDir: true, replacesOriginal: false })],
    });
    const text = renderPlan(view(planned, { keepOriginals: true }));
    expect(text).toContain('- Keeps every original beside its converted image.');
    expect(text).not.toContain('sits in a folder the site serves');
  });

  it('shows every line to be rewritten with its text before and after', () => {
    const text = renderPlan(view(result()));
    expect(text).toContain(
      [
        '### index.html',
        '',
        '- Line 2: `images/logo.png` to `images/logo.webp`',
        '  - before: `<img src="images/logo.png" alt="Logo">`',
        '  - after: `<img src="images/logo.webp" alt="Logo">`',
      ].join('\n'),
    );
  });

  it('says so for a file whose text changed since the plan was made', () => {
    const text = renderPlan(view(result(), { texts: new Map([['index.html', `${INDEX}edited`]]) }));
    expect(text).toContain(
      'index.html changed since this plan was made, so its lines are not shown. Plan again to see them.',
    );
  });

  it('lists each image left alone with the reason', () => {
    expect(renderPlan(view(result()))).toContain(
      '## Left alone\n\n- `images/badge.png`: converting it would save 34 B',
    );
  });

  it("quotes the CLI's notes", () => {
    const text = renderPlan(view(result({}, ['Applying needs a commit first.'])));
    expect(text).toContain('## Notes\n\n- Applying needs a commit first.');
  });

  it('says there is nothing to convert, and still lists what is left alone', () => {
    const text = renderPlan(view(result({ conversions: [], rewrites: [] })));
    expect(text).toContain('Nothing to convert: no image would be converted.');
    expect(text).toContain('## Left alone');
  });

  it('puts the banner lines under the header', () => {
    const text = renderPlan(view(result(), { banner: ['Applied as run r1.'] }));
    expect(text.split('\n').slice(3, 6)).toEqual(['', '> Applied as run r1.', '']);
  });
});
