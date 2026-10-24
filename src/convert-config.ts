/**
 * The old Upfly extension's `upfly.config.json` turned into Upfly 3's: the choices that have an
 * equivalent carried into the `watch` part of the config, and a sentence for each that has
 * none. The old file's meaning is the old extension's own: a watched folder's name matched a
 * folder of that name at any depth, a missing list meant folders named `public`, and the
 * storage mode decided where the converted image and its original went.
 */

/** The `$schema` `upfly init` writes, which marks a JSON config as Upfly 3's. */
export const UPFLY_SCHEMA = './node_modules/upfly/schema/config.json';

/** The `watch` part of Upfly 3's config, as far as a conversion writes it. */
export interface WatchSettings {
  readonly folders: readonly string[];
  readonly keepOriginals?: true;
}

/** An old config, converted. */
export interface ConvertedConfig {
  readonly config: { readonly $schema: string; readonly watch: WatchSettings };
  /** The new file's text. */
  readonly text: string;
  /** What was carried over, a sentence each. */
  readonly carried: readonly string[];
  /** What has no equivalent in Upfly 3, a sentence each. */
  readonly dropped: readonly string[];
}

/** One watched folder of the old file, as the old extension read it. */
interface OldTarget {
  readonly path: string;
  readonly format: string;
  readonly quality: unknown;
}

type Old = Readonly<Record<string, unknown>>;

const OLD_DEFAULT: OldTarget = { path: 'public', format: 'webp', quality: undefined };
const KNOWN = new Set([
  '$schema',
  'enabled',
  'useGlobalSettings',
  'watchTargets',
  'storageMode',
  'outputDirectory',
  'originalDirectory',
  'maxFileSize',
  'inPlaceKeepOriginal',
  'cloudUpload',
  'format',
]);
/** The settings with no equivalent at all, and what to say of each. */
const NO_EQUIVALENT = [
  ['maxFileSize', 'maxFileSize: Upfly 3 has no such setting.'],
  [
    'useGlobalSettings',
    'useGlobalSettings: Upfly 3 reads only the project config, never VS Code settings.',
  ],
  [
    'cloudUpload',
    'cloudUpload: upload to S3, Google Cloud Storage and Cloudinary is not in this version. It comes back later as its own feature, which you turn on.',
  ],
  ['format', 'format at the top of the old file, which the old extension did not read.'],
] as const;

/**
 * Converts the old extension's settings into Upfly 3's config.
 *
 * @param old the old file's settings, parsed
 * @param dirs every folder in the project, relative to it with `/`, which a watched name is
 *   matched against
 * @returns the new config, its text, and what was and was not carried over
 */
export function convertOldConfig(old: Old, dirs: readonly string[]): ConvertedConfig {
  const carried: string[] = [];
  const dropped: string[] = [];
  const targets = oldTargets(old.watchTargets);
  const found = watchedFolders(targets ?? [OLD_DEFAULT], dirs, dropped);
  const watched = old.enabled !== false && targets?.length !== 0 ? found.folders : [];
  carried.push(...watchLines(old, targets, watched, found.widened));
  const keep = keepOriginals(old, carried, dropped);
  for (const [key, line] of NO_EQUIVALENT) {
    if (old[key] !== undefined) dropped.push(line);
  }
  for (const key of Object.keys(old).filter((entry) => !KNOWN.has(entry))) {
    dropped.push(`${key}: not a setting of the old extension or of Upfly 3.`);
  }
  const watch: WatchSettings = keep
    ? { folders: watched, keepOriginals: true }
    : { folders: watched };
  const config = { $schema: UPFLY_SCHEMA, watch };
  return { config, text: `${JSON.stringify(config, null, 2)}\n`, carried, dropped };
}

/**
 * The old file's watched folders as the old extension read them: a name stands for a folder
 * converting to WebP, an entry it could not read for its default, and null for no list at all.
 */
function oldTargets(raw: unknown): OldTarget[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.map((item: unknown): OldTarget => {
    if (typeof item === 'string') return { path: item, format: 'webp', quality: undefined };
    if (typeof item === 'object' && item !== null) {
      const { path, format, quality } = item as Record<string, unknown>;
      if (typeof path === 'string' && path !== '') {
        const written = typeof format === 'string' && format !== '' ? format : 'webp';
        return { path, format: written, quality };
      }
    }
    return OLD_DEFAULT;
  });
}

/** The folders the old targets watched, and whether a name stood for folders deeper down. */
function watchedFolders(
  targets: readonly OldTarget[],
  dirs: readonly string[],
  dropped: string[],
): { folders: string[]; widened: boolean } {
  const folders: string[] = [];
  let widened = false;
  for (const target of targets) {
    const name = oldPath(target.path);
    if (name.includes('*')) {
      dropped.push(
        `watchTargets ${target.path}: a pattern, which Upfly 3's watched folders cannot hold. Add the folders it matched to watch.folders.`,
      );
    } else if (/^[A-Za-z]:/.test(name) || name.split('/').includes('..')) {
      dropped.push(
        `watchTargets ${target.path}: a folder outside the project, which Upfly 3 does not watch.`,
      );
    } else {
      const found = name === '.' ? ['.'] : matching(name, dirs);
      widened ||= found.some((dir) => dir !== name);
      folders.push(...found);
    }
    if (target.format !== 'webp') dropped.push(formatLine(target));
  }
  if (targets.some((target) => target.quality !== undefined)) {
    dropped.push('quality: Upfly 3 has no quality setting.');
  }
  return { folders: outermost(folders), widened };
}

/** What became of watching, a sentence each. */
function watchLines(
  old: Old,
  targets: readonly OldTarget[] | null,
  watched: readonly string[],
  widened: boolean,
): string[] {
  if (old.enabled === false) return ['enabled was false, so no folder is watched.'];
  if (targets?.length === 0) return ['watchTargets was empty, so no folder is watched.'];
  if (watched.length === 0) return [];
  return [
    `Watched folders: ${watched.join(', ')}.`,
    ...(targets === null
      ? [
          'The old file named no watched folder, so the old extension watched folders named public, its default.',
        ]
      : []),
    ...(widened
      ? [
          'The old extension watched every folder with a watched name, at any depth; Upfly 3 watches the folders it names, so each one is named.',
        ]
      : []),
  ];
}

/** A watched folder's path as the old extension spelled it, with `.` for the whole project. */
function oldPath(written: string): string {
  const path = written
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+|\/+$/g, '');
  return path === '' ? '.' : path;
}

/** The project's folders a watched name matched, or the name itself when none is there yet. */
function matching(name: string, dirs: readonly string[]): string[] {
  const found = dirs.filter((dir) => dir === name || dir.endsWith(`/${name}`));
  return found.length > 0 ? found : [name];
}

/** The folders once, sorted, without any inside another of them. */
function outermost(folders: readonly string[]): string[] {
  const unique = [...new Set(folders)];
  if (unique.includes('.')) return ['.'];
  return unique
    .filter((folder) => !unique.some((other) => folder.startsWith(`${other}/`)))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function formatLine(target: OldTarget): string {
  const name = oldPath(target.path);
  return target.format === 'avif'
    ? `format avif for ${name}: Upfly 3 converts to one format for the whole project. To convert to AVIF, add "format": "avif" to upfly.config.json.`
    : `format ${target.format} for ${name}: Upfly 3 converts to WebP or AVIF only.`;
}

/** Whether originals are kept, with what the storage mode and its folders become. */
function keepOriginals(old: Old, carried: string[], dropped: string[]): boolean {
  const mode = old.storageMode ?? 'in-place';
  const output = typeof old.outputDirectory === 'string' ? old.outputDirectory : null;
  const originals = typeof old.originalDirectory === 'string' ? old.originalDirectory : null;
  if (mode === 'separate-output' || mode === 'separate-original') {
    carried.push(
      `Keep originals: storageMode ${mode} kept each original, so Upfly 3 keeps it too.`,
    );
    dropped.push(...separateMode(mode, output, originals));
    return true;
  }
  if (mode !== 'in-place') {
    dropped.push(`storageMode ${String(mode)}: not a mode the old extension had.`);
  }
  const unused = [
    ...(output === null ? [] : ['outputDirectory']),
    ...(originals === null ? [] : ['originalDirectory']),
  ];
  if (unused.length > 0) {
    dropped.push(`${unused.join(' and ')}, which storageMode in-place does not use.`);
  }
  if (old.inPlaceKeepOriginal !== true) return false;
  carried.push(
    'Keep originals: each original stays beside its converted image, as inPlaceKeepOriginal said.',
  );
  return true;
}

/** What a mode that put files in a folder of their own becomes. */
function separateMode(
  mode: 'separate-output' | 'separate-original',
  output: string | null,
  originals: string | null,
): string[] {
  if (mode === 'separate-output') {
    return [
      `storageMode separate-output wrote each converted image into outputDirectory (${output ?? 'not set'}), which has no equivalent: Upfly 3 writes it beside its original.`,
      ...(originals === null
        ? []
        : ['originalDirectory, which storageMode separate-output does not use.']),
    ];
  }
  return [
    `storageMode separate-original moved each original into originalDirectory (${originals ?? 'not set'}), which has no equivalent: Upfly 3 keeps it beside its converted image.`,
    ...(output === null
      ? []
      : ['outputDirectory, which storageMode separate-original does not use.']),
  ];
}
