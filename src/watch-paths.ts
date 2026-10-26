/**
 * Which files the watcher looks at: images the CLI converts, inside a watched folder, and
 * never inside Upfly's own folder, git's or a dependency. Paths are relative to the project,
 * with `/`, as the CLI writes them.
 */

import path from 'node:path';

/**
 * The image extensions the CLI reads, lowercase with their dot, as its engine lists them. A
 * test holds this copy to the engine the extension carries.
 */
export const IMAGE_EXTENSIONS = [
  '.avif',
  '.gif',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.tif',
  '.tiff',
  '.webp',
] as const;

/** The vectors among them, which the CLI never encodes. */
export const VECTOR_EXTENSIONS = ['.svg'] as const;

/** The folders no new image is ever converted in: Upfly's own, git's, and dependencies. */
const NEVER_WATCHED = new Set(['.upfly', '.git', 'node_modules']);

/** The folder watched in a project whose config names none, at any depth. */
const DEFAULT_FOLDER = 'public';

/** The watched and skipped folders, relative to the project with `/`. */
export interface WatchedFolders {
  /** The folders watched, `.` for the whole project; null for every folder named public. */
  readonly folders: readonly string[] | null;
  /** Folders inside the watched ones where nothing is converted. */
  readonly skip: readonly string[];
}

/**
 * Whether a path lies in Upfly's own folder, git's, or a dependency's, at any depth.
 *
 * @param relative a path relative to the project, with `/`
 */
export function isNeverWatched(relative: string): boolean {
  return relative
    .split('/')
    .slice(0, -1)
    .some((segment) => NEVER_WATCHED.has(segment));
}

/**
 * Whether a file lies in a watched folder and in no skipped one.
 *
 * @param relative the file, relative to the project, with `/`
 * @param watched the watched and skipped folders
 */
export function isWatched(relative: string, watched: WatchedFolders): boolean {
  if (isNeverWatched(relative)) return false;
  if (watched.skip.some((folder) => holds(folder, relative))) return false;
  if (watched.folders === null) {
    return relative.split('/').slice(0, -1).includes(DEFAULT_FOLDER);
  }
  return watched.folders.some((folder) => holds(folder, relative));
}

/**
 * Whether a file is one the CLI could convert: an image that is not a vector and not already
 * in the format images convert to.
 *
 * @param relative the file, relative to the project, with `/`
 * @param format the format the project converts to
 */
export function isCandidate(relative: string, format: 'webp' | 'avif'): boolean {
  const extension = path.posix.extname(relative).toLowerCase();
  return (
    (IMAGE_EXTENSIONS as readonly string[]).includes(extension) &&
    !(VECTOR_EXTENSIONS as readonly string[]).includes(extension) &&
    extension !== `.${format}`
  );
}

/**
 * The deepest folder holding every one of the paths, or an empty string for the project
 * itself.
 *
 * @param paths files relative to the project, with `/`
 */
export function commonFolder(paths: readonly string[]): string {
  const folders = paths.map((file) => file.split('/').slice(0, -1));
  const [first = [], ...rest] = folders;
  let depth = first.length;
  for (const other of rest) {
    let same = 0;
    while (same < Math.min(depth, other.length) && other[same] === first[same]) same += 1;
    depth = same;
  }
  return first.slice(0, depth).join('/');
}

/** Whether a folder, `.` for the project, holds a path. */
function holds(folder: string, relative: string): boolean {
  return folder === '.' || relative.startsWith(`${folder}/`);
}
