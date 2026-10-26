import { fileURLToPath } from 'node:url';
import { IMAGE_EXTENSIONS as ENGINE_IMAGE_EXTENSIONS } from 'upfly-core/internal';
import { describe, expect, it } from 'vitest';
import {
  IMAGE_EXTENSIONS,
  VECTOR_EXTENSIONS,
  commonFolder,
  isCandidate,
  isNeverWatched,
  isWatched,
} from './watch-paths.js';

const DEFAULT = { folders: null, skip: [] } as const;

describe('the image extensions', () => {
  it('are the ones the CLI the extension carries reads', () => {
    expect([...IMAGE_EXTENSIONS]).toEqual([...ENGINE_IMAGE_EXTENSIONS]);
  });

  it("name the same vectors as the engine's own list, which no public entry exports", async () => {
    // The engine module that holds the list, read straight from the carried package.
    const paths = fileURLToPath(
      new URL('../node_modules/upfly-core/dist/paths.js', import.meta.url),
    );
    const engine = (await import(paths)) as { VECTOR_EXTENSIONS: readonly string[] };
    expect([...VECTOR_EXTENSIONS]).toEqual([...engine.VECTOR_EXTENSIONS]);
  });
});

describe('isNeverWatched', () => {
  it("leaves out Upfly's own folder, git's and dependencies, at any depth", () => {
    for (const path of [
      '.upfly/no-undo/x/hero.png',
      'public/.upfly/hero.png',
      '.git/hero.png',
      'node_modules/pkg/public/hero.png',
      'packages/site/node_modules/pkg/hero.png',
    ]) {
      expect(isNeverWatched(path), path).toBe(true);
    }
  });

  it('takes a folder whose name only starts like one of them', () => {
    expect(isNeverWatched('public/.upfly-old/hero.png')).toBe(false);
    expect(isNeverWatched('public/node_modules_copy/hero.png')).toBe(false);
  });
});

describe('isWatched', () => {
  it('watches every folder named public at any depth when the config names no folder', () => {
    expect(isWatched('public/hero.png', DEFAULT)).toBe(true);
    expect(isWatched('apps/web/public/img/hero.png', DEFAULT)).toBe(true);
    expect(isWatched('src/hero.png', DEFAULT)).toBe(false);
    expect(isWatched('hero.png', DEFAULT)).toBe(false);
  });

  it('does not take a file named public for a folder', () => {
    expect(isWatched('src/public', DEFAULT)).toBe(false);
  });

  it('watches nothing when the config names no folder in an empty list', () => {
    expect(isWatched('public/hero.png', { folders: [], skip: [] })).toBe(false);
  });

  it('watches the folders the config names, and everything inside them', () => {
    const settings = { folders: ['images', 'site/assets'], skip: [] };
    expect(isWatched('images/hero.png', settings)).toBe(true);
    expect(isWatched('images/2026/hero.png', settings)).toBe(true);
    expect(isWatched('site/assets/hero.png', settings)).toBe(true);
    expect(isWatched('public/hero.png', settings)).toBe(false);
    expect(isWatched('images-old/hero.png', settings)).toBe(false);
  });

  it('watches the whole project for .', () => {
    expect(isWatched('hero.png', { folders: ['.'], skip: [] })).toBe(true);
    expect(isWatched('a/b/hero.png', { folders: ['.'], skip: [] })).toBe(true);
  });

  it('leaves out a skipped folder inside a watched one', () => {
    const settings = { folders: ['public'], skip: ['public/vendor'] };
    expect(isWatched('public/vendor/logo.png', settings)).toBe(false);
    expect(isWatched('public/vendor-own/logo.png', settings)).toBe(true);
    expect(isWatched('public/logo.png', settings)).toBe(true);
  });

  it('leaves out skipped folders under the default too, and everything for a skipped .', () => {
    expect(isWatched('public/vendor/logo.png', { folders: null, skip: ['public/vendor'] })).toBe(
      false,
    );
    expect(isWatched('public/logo.png', { folders: null, skip: ['.'] })).toBe(false);
  });

  it("never watches Upfly's own folder, even inside a watched one", () => {
    expect(isWatched('.upfly/no-undo/public/hero.png', { folders: ['.'], skip: [] })).toBe(false);
  });
});

describe('isCandidate', () => {
  it('takes an image the CLI converts that is not yet in the target format', () => {
    for (const path of [
      'a.png',
      'a.PNG',
      'a.jpg',
      'a.jpeg',
      'a.gif',
      'a.tif',
      'a.tiff',
      'a.avif',
    ]) {
      expect(isCandidate(`public/${path}`, 'webp'), path).toBe(true);
    }
  });

  it('leaves an image already in the target format', () => {
    expect(isCandidate('public/a.webp', 'webp')).toBe(false);
    expect(isCandidate('public/a.avif', 'avif')).toBe(false);
    expect(isCandidate('public/a.webp', 'avif')).toBe(true);
  });

  it('leaves vectors, which the CLI never encodes', () => {
    expect(isCandidate('public/logo.svg', 'webp')).toBe(false);
  });

  it('leaves files that are not images, and names that only end like one', () => {
    for (const path of ['notes.txt', 'png', 'archive.png.zip', '.png']) {
      expect(isCandidate(`public/${path}`, 'webp'), path).toBe(false);
    }
  });
});

describe('commonFolder', () => {
  it('names the deepest folder that holds every path', () => {
    expect(commonFolder(['public/photos/a.png', 'public/photos/2026/b.png'])).toBe('public/photos');
  });

  it('is empty when the paths share no folder', () => {
    expect(commonFolder(['public/a.png', 'images/b.png'])).toBe('');
    expect(commonFolder(['a.png'])).toBe('');
  });

  it('does not take a shared start of two names for a folder', () => {
    expect(commonFolder(['public/photos/a.png', 'public/photos-old/b.png'])).toBe('public');
  });
});
