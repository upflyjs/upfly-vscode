import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { UPFLY_SCHEMA, convertOldConfig } from './convert-config.js';
import { JSON_CONFIG_FILE } from './project-config.js';
import { keepsOriginals } from './watch-batch.js';
import { watchSettings } from './watch-config.js';
import { isWatched } from './watch-paths.js';

describe('UPFLY_SCHEMA', () => {
  it('is the $schema the carried CLI takes for its own config', async () => {
    const file = path.resolve('node_modules', 'upfly', 'dist', 'config.js');
    const { CONFIG_SCHEMA } = (await import(pathToFileURL(file).href)) as {
      CONFIG_SCHEMA: string;
    };
    expect(UPFLY_SCHEMA).toBe(CONFIG_SCHEMA);
  });
});

/** The file the old extension's "Create Config File" wrote, as it reads once parsed. */
const TEMPLATE = {
  enabled: true,
  watchTargets: [{ path: 'public', format: 'webp', quality: 80 }],
  storageMode: 'in-place',
  inPlaceKeepOriginal: false,
  outputDirectory: './converted',
  originalDirectory: './originals',
  maxFileSize: 20000000,
};

describe('convertOldConfig', () => {
  it("writes Upfly 3's $schema, so the CLI reads the file as its own", () => {
    expect(convertOldConfig(TEMPLATE, ['public']).config.$schema).toBe(UPFLY_SCHEMA);
  });

  it('carries the watched folders into watch.folders', () => {
    expect(convertOldConfig(TEMPLATE, ['public', 'src']).config.watch).toEqual({
      folders: ['public'],
    });
  });

  it('names every folder the old name matched at any depth, as the old extension watched them', () => {
    const { config, carried } = convertOldConfig(TEMPLATE, [
      'apps',
      'apps/web',
      'apps/web/public',
      'public',
      'src/not-public',
    ]);
    expect(config.watch.folders).toEqual(['apps/web/public', 'public']);
    expect(carried).toContain(
      'The old extension watched every folder with a watched name, at any depth; Upfly 3 watches the folders it names, so each one is named.',
    );
  });

  it('names the folder as written when no folder of that name is in the project yet', () => {
    expect(convertOldConfig(TEMPLATE, ['src']).config.watch.folders).toEqual(['public']);
  });

  it('reads watched folders written as plain names, as the old settings wrote them', () => {
    const old = { watchTargets: ['assets\\images/', './static'] };
    expect(convertOldConfig(old, []).config.watch.folders).toEqual(['assets/images', 'static']);
  });

  it('leaves out a folder inside another watched one, as the old extension did', () => {
    const old = { watchTargets: ['public', 'public/blog'] };
    expect(convertOldConfig(old, ['public', 'public/blog']).config.watch.folders).toEqual([
      'public',
    ]);
  });

  it('watches folders named public when the old file named none, the old default', () => {
    expect(convertOldConfig({ storageMode: 'in-place' }, []).config.watch.folders).toEqual([
      'public',
    ]);
  });

  it('watches no folder when the old file turned watching off', () => {
    const { config, carried } = convertOldConfig({ ...TEMPLATE, enabled: false }, ['public']);
    expect(config.watch.folders).toEqual([]);
    expect(carried).toContain('enabled was false, so no folder is watched.');
  });

  it('watches no folder when the old list of watched folders was empty', () => {
    expect(convertOldConfig({ watchTargets: [] }, ['public']).config.watch.folders).toEqual([]);
  });

  it('keeps originals when the old file kept them', () => {
    const { config, carried } = convertOldConfig({ ...TEMPLATE, inPlaceKeepOriginal: true }, []);
    expect(config.watch.keepOriginals).toBe(true);
    expect(carried).toContain(
      'Keep originals: each original stays beside its converted image, as inPlaceKeepOriginal said.',
    );
  });

  it('writes no keepOriginals when the old file removed originals, the default in both', () => {
    expect(convertOldConfig(TEMPLATE, []).config.watch).not.toHaveProperty('keepOriginals');
  });

  it('keeps originals for a separate output folder, and says the folder has no equivalent', () => {
    const { config, dropped } = convertOldConfig(
      { ...TEMPLATE, storageMode: 'separate-output' },
      [],
    );
    expect(config.watch.keepOriginals).toBe(true);
    expect(dropped).toContain(
      'storageMode separate-output wrote each converted image into outputDirectory (./converted), which has no equivalent: Upfly 3 writes it beside its original.',
    );
  });

  it('keeps originals for a separate originals folder, and says the folder has no equivalent', () => {
    const { config, dropped } = convertOldConfig(
      { ...TEMPLATE, storageMode: 'separate-original' },
      [],
    );
    expect(config.watch.keepOriginals).toBe(true);
    expect(dropped).toContain(
      'storageMode separate-original moved each original into originalDirectory (./originals), which has no equivalent: Upfly 3 keeps it beside its converted image.',
    );
  });

  it('lists each setting with no equivalent, once', () => {
    const { dropped } = convertOldConfig(
      {
        ...TEMPLATE,
        watchTargets: [
          { path: 'public', format: 'avif', quality: 70 },
          { path: 'static', format: 'png', quality: 90 },
        ],
        useGlobalSettings: true,
        cloudUpload: { enabled: true, provider: 's3' },
      },
      [],
    );
    expect(dropped).toEqual([
      'format avif for public: Upfly 3 converts to one format for the whole project. To convert to AVIF, add "format": "avif" to upfly.config.json.',
      'format png for static: Upfly 3 converts to WebP or AVIF only.',
      'quality: Upfly 3 has no quality setting.',
      'outputDirectory and originalDirectory, which storageMode in-place does not use.',
      'maxFileSize: Upfly 3 has no such setting.',
      'useGlobalSettings: Upfly 3 reads only the project config, never VS Code settings.',
      'cloudUpload: upload to S3, Google Cloud Storage and Cloudinary is not in this version. It comes back later as its own feature, which you turn on.',
    ]);
  });

  it('says nothing about formats when every folder converted to WebP, the default', () => {
    expect(
      convertOldConfig(TEMPLATE, []).dropped.filter((line) => line.startsWith('format')),
    ).toEqual([]);
  });

  it('leaves out a pattern and a folder outside the project, and says why', () => {
    const { config, dropped } = convertOldConfig(
      { watchTargets: ['src/**/img', '../shared', 'C:/photos', 'public'] },
      [],
    );
    expect(config.watch.folders).toEqual(['public']);
    expect(dropped).toEqual([
      "watchTargets src/**/img: a pattern, which Upfly 3's watched folders cannot hold. Add the folders it matched to watch.folders.",
      'watchTargets ../shared: a folder outside the project, which Upfly 3 does not watch.',
      'watchTargets C:/photos: a folder outside the project, which Upfly 3 does not watch.',
    ]);
  });

  it('lists a setting neither extension reads', () => {
    expect(convertOldConfig({ ...TEMPLATE, colour: 'blue' }, []).dropped).toContain(
      'colour: not a setting of the old extension or of Upfly 3.',
    );
  });

  it('writes the config as two-space JSON ending in a newline', () => {
    const { text } = convertOldConfig(TEMPLATE, ['public']);
    expect(text).toBe(
      `{\n  "$schema": "./node_modules/upfly/schema/config.json",\n  "watch": {\n    "folders": [\n      "public"\n    ]\n  }\n}\n`,
    );
  });
});

describe('the converted config, as the watcher reads it', () => {
  const settingsOf = (text: string) =>
    watchSettings({ exists: (file) => file === JSON_CONFIG_FILE, read: () => text });

  it('watches the folders the old file watched, and keeps originals when it kept them', () => {
    const { text } = convertOldConfig({ ...TEMPLATE, inPlaceKeepOriginal: true }, [
      'apps/web/public',
      'public',
    ]);
    const settings = settingsOf(text);
    expect([settings.config, settings.folders, settings.keepOriginals]).toEqual([
      'json',
      ['apps/web/public', 'public'],
      true,
    ]);
    expect(isWatched('apps/web/public/hero.png', settings)).toBe(true);
    expect(isWatched('src/hero.png', settings)).toBe(false);
    expect(keepsOriginals('paste', settings)).toBe(true);
  });

  it('watches nothing when the old file turned watching off', () => {
    const settings = settingsOf(convertOldConfig({ ...TEMPLATE, enabled: false }, ['public']).text);
    expect(settings.folders).toEqual([]);
    expect(isWatched('public/hero.png', settings)).toBe(false);
  });
});
