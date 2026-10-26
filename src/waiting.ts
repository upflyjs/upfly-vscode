/**
 * The originals kept beside their converted image only because they came from outside the
 * editor, such as an image an agent or a download wrote. Each waits until it is provably not
 * needed and can be removed; this list is where that removal finds them. It lives in the
 * workspace's state, so it outlasts a restart and stays out of the project's files.
 */

/** A file's size and modification time, as seen once. */
export interface Stamp {
  readonly size: number;
  readonly mtimeMs: number;
}

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
  /** The original as the conversion left it, so a later edit of it can be told. */
  readonly originalStamp?: Stamp;
  /** The converted image as the conversion wrote it. */
  readonly convertedStamp?: Stamp;
  /** Why the last removal kept it, in the CLI's words. */
  readonly reason?: string;
}

/** An original a conversion kept, as it is recorded. */
export interface Kept {
  readonly original: string;
  readonly converted: string;
  readonly originalStamp?: Stamp;
  readonly convertedStamp?: Stamp;
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
  private readonly listeners = new Set<() => void>();

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
  async add(folder: string, kept: readonly Kept[]): Promise<void> {
    const since = this.clock().toISOString();
    const named = new Set(kept.map((entry) => entry.original));
    await this.save([
      ...this.all().filter((entry) => entry.folder !== folder || !named.has(entry.original)),
      ...kept.map((entry) => ({ folder, since, ...entry })),
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
    if (!this.inFolder(folder).some((entry) => named.has(entry.original))) return;
    await this.save(
      this.all().filter((entry) => entry.folder !== folder || !named.has(entry.original)),
    );
  }

  /**
   * Records why each original stayed when a removal kept it, or clears the reason with null.
   *
   * @param folder the folder's URI
   * @param reasons each original and the CLI's reason
   */
  async note(
    folder: string,
    reasons: readonly { readonly original: string; readonly reason: string | null }[],
  ): Promise<void> {
    const byOriginal = new Map(reasons.map((entry) => [entry.original, entry.reason]));
    let changed = false;
    const next = this.all().map((entry): WaitingOriginal => {
      if (entry.folder !== folder || !byOriginal.has(entry.original)) return entry;
      const reason = byOriginal.get(entry.original) ?? null;
      if ((entry.reason ?? null) === reason) return entry;
      changed = true;
      const rest = { ...entry };
      Reflect.deleteProperty(rest, 'reason');
      return reason === null ? rest : { ...rest, reason };
    });
    if (changed) await this.save(next);
  }

  /**
   * Calls the listener after every change of the list.
   *
   * @param listener what to call
   * @returns what stops the calls
   */
  onChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private async save(entries: readonly WaitingOriginal[]): Promise<void> {
    const saved = this.store.update(WAITING_KEY, entries);
    for (const listener of [...this.listeners]) listener();
    await saved;
  }
}

function isWaiting(value: unknown): value is WaitingOriginal {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    ['folder', 'original', 'converted', 'since'].every((key) => typeof entry[key] === 'string') &&
    ['originalStamp', 'convertedStamp'].every(
      (key) => entry[key] === undefined || isStamp(entry[key]),
    ) &&
    (entry.reason === undefined || typeof entry.reason === 'string')
  );
}

function isStamp(value: unknown): value is Stamp {
  if (typeof value !== 'object' || value === null) return false;
  const stamp = value as Record<string, unknown>;
  return typeof stamp.size === 'number' && typeof stamp.mtimeMs === 'number';
}
