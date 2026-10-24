import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CODE_CONFIG_FILES,
  OLD_EXTENSION_KEYS,
  holdsUpflyConfig,
  isOldExtensionConfig,
  readConfigText,
} from './project-config.js';

const OLD = `{
  // Auto-convert images dropped into watched folders
  "enabled": true,
  "watchTargets": [
    { "path": "public", "format": "webp", "quality": 80 }
  ],
  "storageMode": "in-place",
}
`;

describe('isOldExtensionConfig', () => {
  it("recognises the old extension's file, comments and trailing commas included", () => {
    expect(isOldExtensionConfig(OLD)).toBe(true);
  });

  it("takes a file with Upfly 3's $schema for Upfly 3's, whatever else it holds", () => {
    expect(
      isOldExtensionConfig(
        JSON.stringify({ $schema: './node_modules/upfly/schema/config.json', enabled: true }),
      ),
    ).toBe(false);
  });

  it("takes a file with a setting only Upfly 3 has for Upfly 3's", () => {
    expect(isOldExtensionConfig(JSON.stringify({ watchTargets: ['public'], watch: {} }))).toBe(
      false,
    );
  });

  it("does not take a file with none of the old extension's settings for the old extension's", () => {
    expect(isOldExtensionConfig(JSON.stringify({ format: 'avif' }))).toBe(false);
  });

  it('does not take a file that is not valid JSON for the old extension, as the CLI does not', () => {
    expect(isOldExtensionConfig('{ "enabled": true')).toBe(false);
  });

  it('does not take a list for a config of either kind', () => {
    expect(isOldExtensionConfig('["enabled"]')).toBe(false);
  });
});

describe('readConfigText', () => {
  it('reads JSON with comments and trailing commas as the old extension wrote it', () => {
    expect(readConfigText(OLD)).toEqual({
      enabled: true,
      watchTargets: [{ path: 'public', format: 'webp', quality: 80 }],
      storageMode: 'in-place',
    });
  });

  it('gives undefined for text that is not valid JSON', () => {
    expect(readConfigText('{ "a": ')).toBeUndefined();
  });
});

describe('holdsUpflyConfig', () => {
  const folder = (files: Record<string, string>) => ({
    exists: (file: string) => file in files,
    read: (file: string) => files[file] ?? null,
  });

  it('counts a config written as code, without reading it', () => {
    const read = (file: string): string | null => {
      throw new Error(`read ${file}`);
    };
    expect(holdsUpflyConfig({ exists: (file) => file === 'upfly.config.ts', read })).toBe(true);
  });

  it("counts an upfly.config.json that is Upfly 3's", () => {
    const watched = JSON.stringify({ watch: { folders: ['public'] } });
    expect(holdsUpflyConfig(folder({ 'upfly.config.json': watched }))).toBe(true);
  });

  it("does not count the old extension's upfly.config.json", () => {
    expect(holdsUpflyConfig(folder({ 'upfly.config.json': OLD }))).toBe(false);
  });

  it('does not count a folder with no config', () => {
    expect(holdsUpflyConfig(folder({}))).toBe(false);
  });

  it('counts a code config beside the old extension file, which the CLI reads instead', () => {
    expect(
      holdsUpflyConfig(
        folder({ 'upfly.config.json': OLD, 'upfly.config.mjs': 'export default {}' }),
      ),
    ).toBe(true);
  });
});

describe('the rule, held to the CLI the extension carries', () => {
  const made: string[] = [];
  afterAll(() => {
    for (const dir of made) rmSync(dir, { recursive: true, force: true });
  });

  /** The carried CLI's own config module, which the extension does not load at run time. */
  async function cliConfig(): Promise<{
    CONFIG_FILES: readonly string[];
    V2_EXTENSION_KEYS: readonly string[];
    holdsExtensionConfig: (root: string) => Promise<boolean>;
  }> {
    const file = path.resolve('node_modules', 'upfly', 'dist', 'config.js');
    return import(pathToFileURL(file).href);
  }

  it('names the same config files as the CLI', async () => {
    const { CONFIG_FILES } = await cliConfig();
    expect([...CODE_CONFIG_FILES, 'upfly.config.json']).toEqual([...CONFIG_FILES]);
  });

  it("names the same keys of the old extension's file as the CLI", async () => {
    const { V2_EXTENSION_KEYS } = await cliConfig();
    expect([...OLD_EXTENSION_KEYS]).toEqual([...V2_EXTENSION_KEYS]);
  });

  it("tells the old file from Upfly 3's exactly as the CLI does", async () => {
    const { holdsExtensionConfig } = await cliConfig();
    const samples = [
      OLD,
      '{ "enabled": false }',
      '{ "watchTargets": ["public"], "$schema": "https://unpkg.com/upfly/schema/config.json" }',
      '{ "watchTargets": ["public"], "$schema": "./other/schema.json" }',
      '{ "storageMode": "in-place", "publicDirs": ["public"] }',
      '{ "format": "avif" }',
      '{ "cloudUpload": {}, "check": {} }',
      '{ "enabled": true,, }',
      '"enabled"',
      '{}',
    ];
    for (const text of samples) {
      const dir = mkdtempSync(path.join(tmpdir(), 'upfly-vscode-config-'));
      made.push(dir);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'upfly.config.json'), text);
      expect([text, isOldExtensionConfig(text)]).toEqual([text, await holdsExtensionConfig(dir)]);
    }
  });
});
