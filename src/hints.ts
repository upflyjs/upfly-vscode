/**
 * The Problems panel's hint to use a converted image: on each line naming an original kept
 * beside its converted image, and on each broken reference whose path, with the converted
 * format's extension, names a file that is there. The fix re-spells only the path's
 * extension, as a conversion does, and is applied only when the person picks it.
 */

import path from 'node:path';
import type { AuditImage } from './contract.js';
import type { WaitingOriginal } from './waiting.js';
import { formatName } from './watch-batch.js';
import { IMAGE_EXTENSIONS, VECTOR_EXTENSIONS } from './watch-paths.js';

/** The formats Upfly converts to. */
export type Format = 'webp' | 'avif';

/** A path written on a line, and what to write there to name the converted image instead. */
export interface PathFix {
  /** Counted from 0, as the editor counts lines. */
  readonly line: number;
  /** The columns of the path as written, in UTF-16 code units. */
  readonly start: number;
  readonly end: number;
  /** The path as written. */
  readonly written: string;
  /** The path re-spelled for the converted image. */
  readonly replacement: string;
}

/** A hint for the Problems panel: a line naming an original that has a converted image beside it. */
export interface Hint extends PathFix {
  /** Relative to the workspace folder, with `/`. */
  readonly file: string;
  readonly message: string;
}

/**
 * A path with its image extension swapped for the format's, everything before it kept as
 * written, as a conversion re-spells a reference.
 *
 * @param written the path as written
 * @param format the format to name
 * @returns the path re-spelled, or null when it does not end in an extension Upfly converts
 *   from
 */
export function respelled(written: string, format: Format): string | null {
  const extension = path.posix.extname(written);
  const lower = extension.toLowerCase();
  const convertible =
    (IMAGE_EXTENSIONS as readonly string[]).includes(lower) &&
    !(VECTOR_EXTENSIONS as readonly string[]).includes(lower) &&
    lower !== `.${format}`;
  return convertible ? `${written.slice(0, written.length - extension.length)}.${format}` : null;
}

/**
 * Where a path is written on its line, or null when the line does not hold it.
 *
 * @param text the file's text, or null when it cannot be read
 * @param line counted from 1, or null when not known
 * @param written the path as written
 */
export function placeOf(
  text: string | null,
  line: number | null,
  written: string,
): { line: number; start: number; end: number } | null {
  if (text === null || line === null || written === '') return null;
  const column = (text.split('\n')[line - 1] ?? '').indexOf(written);
  return column === -1 ? null : { line: line - 1, start: column, end: column + written.length };
}

/**
 * The hints for the lines naming each waiting original, from the references the audit found
 * to it.
 *
 * @param images the audit's images, each with its references' file, line and path as written
 * @param waiting the originals waiting in the folder
 * @param textOf a file's text, or null when it cannot be read
 */
export function waitingHints(
  images: readonly AuditImage[],
  waiting: readonly WaitingOriginal[],
  textOf: (file: string) => string | null,
): Hint[] {
  const byPath = new Map(images.map((image) => [image.path, image]));
  const hints: Hint[] = [];
  for (const entry of waiting) {
    const format = formatOf(entry.converted);
    const image = byPath.get(entry.original);
    if (format === null || image === undefined) continue;
    const message = `${entry.original} has ${article(format)} ${formatName(format)} beside it: ${entry.converted}`;
    for (const reference of image.references) {
      const replacement = respelled(reference.text, format);
      const place = placeOf(textOf(reference.file), reference.line, reference.text);
      if (replacement === null || place === null) continue;
      hints.push({ file: reference.file, message, written: reference.text, replacement, ...place });
    }
  }
  return hints;
}

/**
 * The path a broken reference could name instead: the path re-spelled for the format, when
 * that names a file that is there, read from the referring file's folder or a folder the site
 * is served from.
 *
 * @param reference the broken reference: its file and the path as written
 * @param roots the folders the site is served from, relative to the project, `''` for itself
 * @param format the format images convert to
 * @param exists whether a file is there, relative to the project with `/`
 * @returns the re-spelled path, or null
 */
export function brokenReplacement(
  reference: { readonly file: string; readonly rawPath: string },
  roots: readonly string[],
  format: Format,
  exists: (relative: string) => boolean,
): string | null {
  const replacement = respelled(reference.rawPath, format);
  if (replacement === null) return null;
  const rooted = replacement.startsWith('/');
  const bare = rooted ? replacement.slice(1) : replacement;
  const candidates = [
    ...(rooted ? [] : [path.posix.join(path.posix.dirname(reference.file), bare)]),
    ...roots.map((root) => path.posix.join(root, bare)),
    path.posix.normalize(bare),
  ];
  return candidates.some((candidate) => isInside(candidate) && exists(candidate))
    ? replacement
    : null;
}

/** The format a converted image's name says, or null for another file. */
function formatOf(converted: string): Format | null {
  const extension = path.posix.extname(converted).toLowerCase();
  return extension === '.webp' ? 'webp' : extension === '.avif' ? 'avif' : null;
}

function article(format: Format): string {
  return format === 'avif' ? 'an' : 'a';
}

function isInside(relative: string): boolean {
  return relative !== '..' && !relative.startsWith('../') && !path.posix.isAbsolute(relative);
}
