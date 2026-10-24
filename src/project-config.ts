/**
 * Which Upfly config a folder holds, read as data and never run. The old Upfly extension kept
 * its settings in a file with the same name as Upfly 3's config, `upfly.config.json`, so a file
 * of that name is Upfly 3's only when it carries nothing that marks it as the old extension's.
 * The CLI applies the same rule before it reads a project; a test holds this copy to the CLI
 * the extension carries, so the two cannot drift apart unnoticed.
 */

import { type ParseError, parse } from 'jsonc-parser';

/** The config files the CLI loads by running them, in the order it looks for them. */
export const CODE_CONFIG_FILES = [
  'upfly.config.ts',
  'upfly.config.mts',
  'upfly.config.cts',
  'upfly.config.js',
  'upfly.config.mjs',
  'upfly.config.cjs',
] as const;

/** The config the CLI reads as data. */
export const JSON_CONFIG_FILE = 'upfly.config.json';

/** The top-level settings of the old extension's `upfly.config.json`. */
export const OLD_EXTENSION_KEYS = [
  'enabled',
  'useGlobalSettings',
  'watchTargets',
  'storageMode',
  'outputDirectory',
  'originalDirectory',
  'maxFileSize',
  'inPlaceKeepOriginal',
  'cloudUpload',
] as const;

/** Settings only Upfly 3's config has. `format` is not one: the old extension used the name too. */
const UPFLY_3_KEYS = new Set(['publicDirs', 'publicPolicy', 'exclude', 'check', 'watch']);

/**
 * A config file's text as JSON with comments and trailing commas, the way both the old
 * extension and the CLI read it.
 *
 * @param text the file's contents
 * @returns the value, or undefined when the text is not valid JSON
 */
export function readConfigText(text: string): unknown {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  return errors.length === 0 ? value : undefined;
}

/**
 * Whether an `upfly.config.json` holds the old extension's settings: one of its keys, none
 * that only Upfly 3 has, and no `$schema` naming Upfly 3's config schema.
 *
 * @param text the file's contents
 */
export function isOldExtensionConfig(text: string): boolean {
  const value = readConfigText(text);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (!keys.some((key) => (OLD_EXTENSION_KEYS as readonly string[]).includes(key))) return false;
  if (keys.some((key) => UPFLY_3_KEYS.has(key))) return false;
  const schema = (value as { $schema?: unknown }).$schema;
  return !(
    typeof schema === 'string' &&
    /upfly/i.test(schema) &&
    schema.endsWith('schema/config.json')
  );
}

/** How a folder's files are looked at, so tests can stand in for the disk. */
export interface FolderFiles {
  /** Whether a file of this name is at the folder's top. */
  readonly exists: (file: string) => boolean;
  /** A file's text, or null when it cannot be read. */
  readonly read: (file: string) => string | null;
}

/**
 * Whether a folder holds a config Upfly 3 reads: one written as code, which is never read
 * here, or an `upfly.config.json` that is not the old extension's.
 *
 * @param files the folder's files
 */
export function holdsUpflyConfig(files: FolderFiles): boolean {
  if (CODE_CONFIG_FILES.some((file) => files.exists(file))) return true;
  if (!files.exists(JSON_CONFIG_FILE)) return false;
  const text = files.read(JSON_CONFIG_FILE);
  // A file that cannot be read is still the CLI's to report on.
  return text === null || !isOldExtensionConfig(text);
}
