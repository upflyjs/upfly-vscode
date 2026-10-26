import { describe, expect, it } from 'vitest';
import { readConfigText } from './project-config.js';
import { normalFolder, skipEdit, watchSettings } from './watch-config.js';

const SCHEMA = './node_modules/upfly/schema/config.json';

/** A folder holding these files, by name. */
function folder(files: Record<string, string | null>) {
  return {
    exists: (file: string) => file in files,
    read: (file: string) => files[file] ?? null,
  };
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

describe('watchSettings', () => {
  it('watches every folder named public, converting to WebP, in a project with no config', () => {
    expect(watchSettings(folder({}))).toEqual({
      config: 'none',
      file: null,
      folders: null,
      skip: [],
      keepOriginals: false,
      outsideReplace: false,
      format: 'webp',
    });
  });

  it("reads the watch part and the format of Upfly 3's config", () => {
    const text = `{
      // Comments and trailing commas, as the CLI reads them
      "$schema": "${SCHEMA}",
      "format": "avif",
      "watch": {
        "folders": ["./images/", "site\\\\assets"],
        "skip": ["images/vendor"],
        "keepOriginals": true,
        "outside": "replace",
      },
    }`;
    expect(watchSettings(folder({ 'upfly.config.json': text }))).toEqual({
      config: 'json',
      file: 'upfly.config.json',
      folders: ['images', 'site/assets'],
      skip: ['images/vendor'],
      keepOriginals: true,
      outsideReplace: true,
      format: 'avif',
    });
  });

  it('keeps the default folders when the watch part names none, and an empty list as nothing', () => {
    const none = watchSettings(folder({ 'upfly.config.json': json({ watch: { skip: ['x'] } }) }));
    expect([none.folders, none.skip]).toEqual([null, ['x']]);
    const empty = watchSettings(folder({ 'upfly.config.json': json({ watch: { folders: [] } }) }));
    expect(empty.folders).toEqual([]);
  });

  it('drops a folder that is not inside the project, which the CLI refuses anyway', () => {
    const text = json({ watch: { folders: ['../other', 'C:/site', '/abs', 'public'] } });
    expect(watchSettings(folder({ 'upfly.config.json': text })).folders).toEqual(['public']);
  });

  it('treats a project whose config is code as having no watch part, since it is never run', () => {
    const settings = watchSettings(
      folder({
        'upfly.config.ts': 'export default { watch: { folders: [] } }',
        'upfly.config.json': json({ $schema: SCHEMA, watch: { folders: [] } }),
      }),
    );
    expect([settings.config, settings.file, settings.folders]).toEqual([
      'code',
      'upfly.config.ts',
      null,
    ]);
  });

  it("treats the old extension's config as no watch part, as the CLI refuses to read it", () => {
    const settings = watchSettings(
      folder({ 'upfly.config.json': json({ enabled: false, watchTargets: [] }) }),
    );
    expect([settings.config, settings.folders]).toEqual(['old', null]);
  });

  it('keeps the defaults for a config it cannot read or parse', () => {
    expect(watchSettings(folder({ 'upfly.config.json': null })).config).toBe('unreadable');
    expect(watchSettings(folder({ 'upfly.config.json': '{ "watch": ' })).config).toBe('unreadable');
    expect(watchSettings(folder({ 'upfly.config.json': '[1]' })).folders).toBe(null);
  });
});

describe('normalFolder', () => {
  it('writes a folder as the CLI reads it: with /, no leading ./ and no trailing /', () => {
    expect(['./public/', 'public\\vendor', 'public', '.', './', ''].map(normalFolder)).toEqual([
      'public',
      'public/vendor',
      'public',
      '.',
      '.',
      '.',
    ]);
  });

  it('refuses a folder outside the project', () => {
    expect(['../x', 'a/../../x', '/abs', 'C:/x', 'c:x'].map(normalFolder)).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
  });
});

describe('skipEdit', () => {
  const settingsOf = (files: Record<string, string | null>) => watchSettings(folder(files));

  it('writes a new config holding the $schema line and the watch part only, when there is none', () => {
    const edit = skipEdit(null, settingsOf({}), 'public/vendor');
    expect(edit.kind).toBe('write');
    if (edit.kind !== 'write') return;
    expect(readConfigText(edit.text)).toEqual({
      $schema: SCHEMA,
      watch: { skip: ['public/vendor'] },
    });
  });

  it('adds the folder to watch.skip, keeping comments and every other setting', () => {
    const text = `{
  // Where the site is served from
  "$schema": "${SCHEMA}",
  "publicDirs": ["."],
  "watch": {
    "folders": ["public"],
    "skip": ["public/old"] // kept as written
  }
}
`;
    const edit = skipEdit(text, settingsOf({ 'upfly.config.json': text }), 'public/vendor');
    if (edit.kind !== 'write') throw new Error(edit.kind);
    expect(edit.text).toContain('// Where the site is served from');
    expect(edit.text).toContain('// kept as written');
    expect(edit.text).toContain('"publicDirs": ["."]');
    expect(readConfigText(edit.text)).toEqual({
      $schema: SCHEMA,
      publicDirs: ['.'],
      watch: { folders: ['public'], skip: ['public/old', 'public/vendor'] },
    });
  });

  it('adds a watch part after the $schema line, leaving the settings after it as written', () => {
    const text = `{\n  "$schema": "${SCHEMA}",\n  "publicDirs": ["."]\n}\n`;
    const edit = skipEdit(text, settingsOf({ 'upfly.config.json': text }), 'public');
    if (edit.kind !== 'write') throw new Error(edit.kind);
    expect(edit.text).toContain('  "publicDirs": ["."]\n');
    expect(readConfigText(edit.text)).toEqual({
      $schema: SCHEMA,
      publicDirs: ['.'],
      watch: { skip: ['public'] },
    });
  });

  it("keeps the file's own line endings and indentation", () => {
    const text = `{\r\n\t"$schema": "${SCHEMA}"\r\n}\r\n`;
    const edit = skipEdit(text, settingsOf({ 'upfly.config.json': text }), 'public');
    if (edit.kind !== 'write') throw new Error(edit.kind);
    expect(edit.text.replace(/\r\n/g, '')).not.toContain('\n');
    expect(edit.text).toContain('\t"watch"');
  });

  it('says so, writing nothing, when the folder or one holding it is skipped already', () => {
    const text = json({ $schema: SCHEMA, watch: { skip: ['./public/'] } });
    const settings = settingsOf({ 'upfly.config.json': text });
    expect(skipEdit(text, settings, 'public')).toEqual({ kind: 'already', by: 'public' });
    expect(skipEdit(text, settings, 'public/vendor')).toEqual({ kind: 'already', by: 'public' });
  });

  it('refuses a project whose config is code, which Upfly never changes', () => {
    const settings = settingsOf({ 'upfly.config.mjs': 'export default {}' });
    expect(skipEdit(null, settings, 'public')).toEqual({
      kind: 'refused',
      message:
        'This project is configured in upfly.config.mjs, a config written as code, which Upfly does not change. To stop watching public, add it to watch.skip there.',
    });
  });

  it("refuses the old extension's config, which has to be converted first", () => {
    const text = json({ enabled: true, watchTargets: ['public'] });
    const edit = skipEdit(text, settingsOf({ 'upfly.config.json': text }), 'public');
    expect(edit.kind).toBe('refused');
  });

  it('refuses a config that is not valid JSON, or whose watch.skip is not a list', () => {
    const broken = '{ "watch": ';
    expect(skipEdit(broken, settingsOf({ 'upfly.config.json': broken }), 'x').kind).toBe('refused');
    const odd = json({ $schema: SCHEMA, watch: { skip: 'public' } });
    expect(skipEdit(odd, settingsOf({ 'upfly.config.json': odd }), 'x').kind).toBe('refused');
  });
});
