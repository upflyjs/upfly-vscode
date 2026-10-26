/**
 * The originals kept beside their converted image only because they came from outside the
 * editor, such as an image an agent or a download wrote. Each waits until it is provably not
 * needed and can be removed; this list is where that removal finds them. It lives in the
 * workspace's state, so it outlasts a restart and stays out of the project's files.
 */

/** An original waiting to be removed. */
export interface WaitingOriginal {
  /** The workspace folder, as its URI. */
  readonly folder: string;
  /** The original, relative to the folder, with `/`. */
  readonly original: string;
  /** The converted image beside it. */
  readonly converted: string;
  /** When it was converted, as an ISO date. */
  readonly since: string;
}

/** Where the list is kept in the workspace's state. */
export const WAITING_KEY = 'upfly.waitingOriginals';

/** The part of VS Code's workspace state the list uses. */
export interface StateStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

/** The originals waiting to be removed, in the workspace's state. */
export class WaitingOriginals {
  /**
   * @param store the workspace's state
   * @param clock the time a conversion is recorded at
   */
  constructor(
    private readonly store: StateStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Every original waiting, in the order recorded. */
  all(): readonly WaitingOriginal[] {
    const value = this.store.get<unknown>(WAITING_KEY);
    return Array.isArray(value) ? value.filter(isWaiting) : [];
  }

  /**
   * The originals waiting in one workspace folder.
   *
   * @param folder the folder's URI
   */
  inFolder(folder: string): readonly WaitingOriginal[] {
    return this.all().filter((entry) => entry.folder === folder);
  }

  /**
   * Records originals kept by a conversion, replacing an earlier entry for the same original.
   *
   * @param folder the folder's URI
   * @param kept each original and the image converted from it
   */
  async add(
    folder: string,
    kept: readonly { readonly original: string; readonly converted: string }[],
  ): Promise<void> {
    const since = this.clock().toISOString();
    const named = new Set(kept.map((entry) => entry.original));
    await this.store.update(WAITING_KEY, [
      ...this.all().filter((entry) => entry.folder !== folder || !named.has(entry.original)),
      ...kept.map((entry) => ({
        folder,
        original: entry.original,
        converted: entry.converted,
        since,
      })),
    ]);
  }

  /**
   * Takes originals off the list, once removed or no longer waiting.
   *
   * @param folder the folder's URI
   * @param originals the originals, relative to the folder
   */
  async remove(folder: string, originals: readonly string[]): Promise<void> {
    const named = new Set(originals);
    await this.store.update(
      WAITING_KEY,
      this.all().filter((entry) => entry.folder !== folder || !named.has(entry.original)),
    );
  }
}

function isWaiting(value: unknown): value is WaitingOriginal {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return ['folder', 'original', 'converted', 'since'].every(
    (key) => typeof entry[key] === 'string',
  );
}
