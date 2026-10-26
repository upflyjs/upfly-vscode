import { describe, expect, it } from 'vitest';
import type { AuditImage } from './contract.js';
import { brokenReplacement, placeOf, respelled, waitingHints } from './hints.js';
import type { WaitingOriginal } from './waiting.js';

const SITE = 'file:///work/site';

function image(file: string, references: AuditImage['references']): AuditImage {
  return { path: file, bytes: 100, references, findings: [] };
}

describe('respelled', () => {
  it('swaps the extension and keeps the rest as written, as a conversion does', () => {
    expect(respelled('../Img/Hero.PNG', 'webp')).toBe('../Img/Hero.webp');
    expect(respelled('/photos/a.jpeg', 'avif')).toBe('/photos/a.avif');
  });

  it('leaves a vector, a file in the format already, and a path that is no image', () => {
    expect(respelled('logo.svg', 'webp')).toBeNull();
    expect(respelled('hero.webp', 'webp')).toBeNull();
    expect(respelled('style.css', 'webp')).toBeNull();
    expect(respelled('hero.png?v=2', 'webp')).toBeNull();
  });
});

describe('placeOf', () => {
  it('finds the path on its line, counting from 0 in UTF-16 units', () => {
    expect(placeOf('<p>\n  <img src="a.png">\n', 2, 'a.png')).toEqual({
      line: 1,
      start: 12,
      end: 17,
    });
  });

  it('finds nothing on a line that does not hold it, or when the line is not known', () => {
    expect(placeOf('<img src="b.png">', 1, 'a.png')).toBeNull();
    expect(placeOf('<img src="a.png">', null, 'a.png')).toBeNull();
    expect(placeOf(null, 1, 'a.png')).toBeNull();
  });
});

describe('waitingHints', () => {
  const waiting: WaitingOriginal[] = [
    { folder: SITE, original: 'public/a.png', converted: 'public/a.webp', since: 'then' },
  ];
  const text = (file: string) =>
    file === 'index.html' ? '<html>\n<img src="/a.png" alt="A">\n<img src="/b.png">\n' : null;

  it('hints each line naming a waiting original, with the path re-spelled', () => {
    const images = [
      image('public/a.png', [{ file: 'index.html', line: 2, text: '/a.png' }]),
      image('public/b.png', [{ file: 'index.html', line: 3, text: '/b.png' }]),
    ];
    expect(waitingHints(images, waiting, text)).toEqual([
      {
        file: 'index.html',
        line: 1,
        start: 10,
        end: 16,
        written: '/a.png',
        replacement: '/a.webp',
        message: 'public/a.png has a WebP beside it: public/a.webp',
      },
    ]);
  });

  it('names AVIF for an original converted to it', () => {
    const avif = [{ ...waiting[0], converted: 'public/a.avif' } as WaitingOriginal];
    const images = [image('public/a.png', [{ file: 'index.html', line: 2, text: '/a.png' }])];
    const [hint] = waitingHints(images, avif, text);
    expect(hint?.message).toBe('public/a.png has an AVIF beside it: public/a.avif');
    expect(hint?.replacement).toBe('/a.avif');
  });

  it('gives no hint for a line it cannot find the path on', () => {
    const images = [image('public/a.png', [{ file: 'index.html', line: 3, text: '/a.png' }])];
    expect(waitingHints(images, waiting, text)).toEqual([]);
  });
});

describe('brokenReplacement', () => {
  const files = new Set(['public/photos/a.webp', 'images/b.webp', 'docs/c.webp']);
  const exists = (relative: string) => files.has(relative);

  it('offers the WebP a root-relative path names in a served folder', () => {
    const broken = { file: 'src/App.jsx', rawPath: '/photos/a.png' };
    expect(brokenReplacement(broken, ['public'], 'webp', exists)).toBe('/photos/a.webp');
  });

  it("offers the WebP a relative path names from the file's own folder", () => {
    const broken = { file: 'docs/page.html', rawPath: 'c.png' };
    expect(brokenReplacement(broken, [], 'webp', exists)).toBe('c.webp');
  });

  it('offers the WebP a path names from the project itself', () => {
    expect(
      brokenReplacement({ file: 'index.html', rawPath: 'images/b.png' }, [''], 'webp', exists),
    ).toBe('images/b.webp');
  });

  it('offers nothing when no such file is there, or the path leaves the project', () => {
    expect(brokenReplacement({ file: 'index.html', rawPath: 'x.png' }, [''], 'webp', exists)).toBe(
      null,
    );
    const outside = { file: 'index.html', rawPath: '../images/b.png' };
    expect(brokenReplacement(outside, [''], 'webp', () => true)).toBeNull();
  });
});
