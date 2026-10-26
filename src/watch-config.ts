/**
 * The `watch` part of a project's `upfly.config.json`, read as data, and the edit that adds a
 * folder to its `skip` list. The extension never runs a config written as code
 * (`upfly.config.ts`, `.js` and the rest), and no CLI command prints the settings it holds, so
 * a project configured that way is watched as if it had no `watch` part.
 */

import { type FormattingOptions, applyEdits, modify } from 'jsonc-parser';
import { UPFLY_SCHEMA } from './convert-config.js';
import {
  CODE_CONFIG_FILES,
  type FolderFiles,
  JSON_CONFIG_FILE,
  isOldExtensionConfig,
  readConfigText,
} from './project-config.js';
import type { WatchedFolders } from './watch-paths.js';

/** Which config the project holds, as far as the watcher can read it. */
export type ConfigKind = 'none' | 'json' | 'code' | 'old' | 'unreadable';

/** How the watcher treats a project's new images. */
export interface WatchSettings extends WatchedFolders {
  readonly config: ConfigKind;
  /** The config file the CLI reads, relative to the project, or null when there is none. */
  readonly file: string | null;
  /** Keep each converted image's original beside it. */
  readonly keepOriginals: boolean;
  /** Convert an image from outside the editor as one pasted in it, its original removed. */
  readonly outsideReplace: boolean;
  /** The format images convert to. */
  readonly format: 'webp' | 'avif';
}

const DEFAULTS = {
  folders: null,
  skip: [],
  keepOriginals: false,
  outsideReplace: false,
  format: 'webp',
} as const;

/**
 * The watch settings of a project, from the config at its top.
 *
 * @param files the project folder's files
 */
export function watchSettings(files: FolderFiles): WatchSettings {
  const code = CODE_CONFIG_FILES.find((file) => files.exists(file));
  if (code !== undefined) return { ...DEFAULTS, config: 'code', file: code };
  if (!files.exists(JSON_CONFIG_FILE)) return { ...DEFAULTS, config: 'none', file: null };
  const text = files.read(JSON_CONFIG_FILE);
  const value = text === null ? undefined : readConfigText(text);
  if (text === null || !isRecord(value)) {
    return { ...DEFAULTS, config: 'unreadable', file: JSON_CONFIG_FILE };
  }
  if (isOldExtensionConfig(text)) return { ...DEFAULTS, config: 'old', file: JSON_CONFIG_FILE };
  const watch = isRecord(value.watch) ? value.watch : {};
  return {
    config: 'json',
    file: JSON_CONFIG_FILE,
    folders: Array.isArray(watch.folders) ? folderList(watch.folders) : null,
    skip: Array.isArray(watch.skip) ? folderList(watch.skip) : [],
    keepOriginals: watch.keepOriginals === true,
    outsideReplace: watch.outside === 'replace',
    format: value.format === 'avif' ? 'avif' : 'webp',
  };
}

/**
 * A folder as the CLI reads one from the config: with `/`, no leading `./` and no trailing
 * `/`, `.` for the project itself.
 *
 * @param written the folder as the config writes it
 * @returns the folder, or null when it is not inside the project
 */
export function normalFolder(written: string): string | null {
  const slashed = written.replace(/\\/g, '/');
  if (slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed)) return null;
  const segments = slashed.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.includes('..')) return null;
  return segments.length === 0 ? '.' : segments.join('/');
}

/** What adding a folder to `watch.skip` comes to. */
export type SkipEdit =
  /** The config's new text. */
  | { readonly kind: 'write'; readonly text: string }
  /** The folder, or one holding it, is skipped already. */
  | { readonly kind: 'already'; readonly by: string }
  | { readonly kind: 'refused'; readonly message: string };

/**
 * Adds a folder to `watch.skip` in `upfly.config.json`, keeping its comments and every other
 * setting as written, or writes a new config holding the `$schema` line `upfly init` writes
 * and the `watch` part only.
 *
 * @param text the config's text, or null when there is none or it could not be read
 * @param settings the project's watch settings, read from the same text
 * @param folder the folder, relative to the project with `/`
 */
export function skipEdit(text: string | null, settings: WatchSettings, folder: string): SkipEdit {
  if (settings.config === 'code') {
    return refused(
      `This project is configured in ${settings.file}, a config written as code, which Upfly does not change. To stop watching ${folder}, add it to watch.skip there.`,
    );
  }
  if (settings.config === 'old') {
    return refused(
      "This project's upfly.config.json is the old Upfly extension's. Convert it to Upfly 3's config first, then stop watching the folder.",
    );
  }
  const by = settings.skip.find(
    (skip) => skip === '.' || skip === folder || folder.startsWith(`${skip}/`),
  );
  if (by !== undefined) return { kind: 'already', by };
  if (settings.config === 'none') {
    const config = { $schema: UPFLY_SCHEMA, watch: { skip: [folder] } };
    return { kind: 'write', text: `${JSON.stringify(config, null, 2)}\n` };
  }
  const value = text === null ? undefined : readConfigText(text);
  if (text === null || settings.config === 'unreadable' || !isRecord(value)) {
    return refused(
      "This project's upfly.config.json is not valid JSON, so Upfly does not change it. Correct it, then try again.",
    );
  }
  const watch = value.watch;
  const skip = isRecord(watch) ? watch.skip : undefined;
  if ((watch !== undefined && !isRecord(watch)) || (skip !== undefined && !Array.isArray(skip))) {
    return refused(
      'watch.skip in upfly.config.json is not a list of folders, so Upfly does not change it. Correct it, then try again.',
    );
  }
  const formattingOptions = formattingOf(text);
  const edits = !isRecord(watch)
    ? // After the $schema line, so the edit reformats no line the person wrote.
      modify(
        text,
        ['watch'],
        { skip: [folder] },
        { formattingOptions, getInsertionIndex: afterSchema },
      )
    : skip === undefined
      ? modify(text, ['watch', 'skip'], [folder], {
          formattingOptions,
          getInsertionIndex: () => 0,
        })
      : modify(text, ['watch', 'skip', -1], folder, { formattingOptions, isArrayInsertion: true });
  return { kind: 'write', text: applyEdits(text, edits) };
}

function refused(message: string): SkipEdit {
  return { kind: 'refused', message };
}

/** The file's own line endings and indentation, so an edit matches what is there. */
function formattingOf(text: string): FormattingOptions {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const indent = /^([ \t]+)\S/m.exec(text)?.[1] ?? '  ';
  return indent.startsWith('\t')
    ? { insertSpaces: false, tabSize: 1, eol }
    : { insertSpaces: true, tabSize: indent.length, eol };
}

function afterSchema(properties: string[]): number {
  const at = properties.indexOf('$schema');
  return at === -1 ? 0 : at + 1;
}

/** The folders of a list in the config, each as the CLI reads it, those outside the project left out. */
function folderList(written: readonly unknown[]): string[] {
  return written
    .filter((entry): entry is string => typeof entry === 'string')
    .map(normalFolder)
    .filter((entry): entry is string => entry !== null);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
