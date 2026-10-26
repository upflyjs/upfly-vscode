/**
 * The order new images are converted in. File events settle into a burst; each burst's images
 * are examined, and the new ones of one folder and kind wait for a batch: one CLI run converts
 * every image of a batch, pastes before arrivals, one run at a time. A run reads the whole
 * project however few images it converts, which is why a batch takes every image waiting when
 * the run before it ends rather than one image at a time. Examining, the question, the runs
 * and the clock are given, so the order can be tested without VS Code or the CLI.
 */

import { plural } from './format.js';

/** How an image came: pasted or dropped in the editor, or arrived from outside it. */
export type Kind = 'paste' | 'arrival';

/** An image the watcher heard arrive. */
export interface Heard {
  /** The workspace folder, as a key that also reads well in the log. */
  readonly folder: string;
  /** Relative to the folder, with `/`. */
  readonly path: string;
  readonly kind: Kind;
}

/** An image found new, ready to convert. */
export interface NewImage {
  readonly path: string;
  readonly kind: Kind;
  /** Its size once it stopped growing, or null when not known. */
  readonly bytes: number | null;
}

/** The images one CLI run converts: one folder, one kind. */
export interface Batch {
  readonly folder: string;
  readonly kind: Kind;
  readonly images: readonly NewImage[];
}

/** What, once it changes, lets a folder's new images convert again. */
export type BlockCause = 'config' | 'record';

/** How a batch's run ended. */
export type BatchEnd =
  | { readonly kind: 'done' }
  | { readonly kind: 'cancelled' }
  /** Another run holds the project: these images are tried again later. */
  | { readonly kind: 'locked'; readonly left: readonly NewImage[] }
  /** A refusal every batch in the folder would meet again until `until` changes. */
  | { readonly kind: 'blocked'; readonly until: BlockCause; readonly why: string };

/** What the queue asks of the rest of the watcher. */
export interface QueueSteps {
  /** The new ones among a burst's images in one folder; the others are logged there. */
  examine(folder: string, heard: readonly Heard[]): Promise<readonly NewImage[]>;
  /** Asks whether to convert a burst of more than 50; true converts them. */
  ask(folder: string, images: readonly NewImage[]): Promise<boolean>;
  run(batch: Batch): Promise<BatchEnd>;
  log(text: string): void;
}

/** The timers the queue uses, so a test can drive them. */
export interface Clock {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}

/** How long file events must stop before they make a burst. */
export const SETTLE_MS = 700;
/** Above this many new images in one folder at once, the person is asked first. */
export const ASK_ABOVE = 50;
/** How long a batch is tried again while another run holds the project. */
export const RETRY_LIMIT_MS = 10 * 60_000;
/** How far apart the two looks at a file are. */
export const LOOK_INTERVAL_MS = 500;
/** How long a file may keep changing before it is left as it is. */
export const GIVE_UP_MS = 60_000;

const KINDS: readonly Kind[] = ['paste', 'arrival'];

/**
 * What a stopped folder waits for, as the person reads it after "until".
 *
 * @param cause what has to change
 */
export function untilText(cause: BlockCause): string {
  return cause === 'config'
    ? 'its Upfly config changes or VS Code starts again'
    : 'the run that stopped part way is put back or undone, or VS Code starts again';
}

/**
 * The wait before trying a locked batch again: 2, 4 and 8 seconds, then every 10.
 *
 * @param attempt how many times the batch was locked out, from 1
 */
export function retryDelay(attempt: number): number {
  return attempt <= 3 ? 1_000 * 2 ** attempt : 10_000;
}

/** The images heard, examined, waiting and running, and the folders that convert nothing. */
export class NewImageQueue {
  private readonly burst = new Map<string, Heard>();
  private settle: unknown = null;
  private readonly pending = new Map<string, Record<Kind, Map<string, NewImage>>>();
  /** A folder and kind waiting out another run's lock, with the timer that tries again. */
  private readonly held = new Map<string, unknown>();
  private readonly attempts = new Map<string, { count: number; since: number }>();
  private readonly blocks = new Map<string, { until: BlockCause; why: string }>();
  private examining = 0;
  private running = false;
  private disposed = false;

  /**
   * @param steps examining, asking, running and logging
   * @param clock the timers
   * @param now the time in milliseconds
   */
  constructor(
    private readonly steps: QueueSteps,
    private readonly clock: Clock,
    private readonly now: () => number,
  ) {}

  /**
   * Takes an image that arrived into the burst being heard.
   *
   * @param heard the image, its folder and how it came
   */
  hear(heard: Heard): void {
    if (this.disposed) return;
    if (this.blocks.has(heard.folder)) {
      this.notConverted(heard.folder, heard.path);
      return;
    }
    const key = `${heard.folder}\0${heard.path}`;
    // An image pasted in the editor is also seen by the file watcher, before or after.
    if (this.burst.get(key)?.kind !== 'paste') this.burst.set(key, heard);
    this.clock.clearTimeout(this.settle);
    this.settle = this.clock.setTimeout(() => {
      this.settle = null;
      void this.examineBurst();
    }, SETTLE_MS);
  }

  /**
   * Lets a folder's new images convert again, when what it was waiting for has changed.
   *
   * @param folder the folder's key
   * @param cause what changed
   * @returns whether the folder was waiting for that
   */
  unblock(folder: string, cause: BlockCause): boolean {
    if (this.blocks.get(folder)?.until !== cause) return false;
    this.blocks.delete(folder);
    this.steps.log(`Upfly converts new images in ${folder} again.`);
    return true;
  }

  /**
   * Why a folder converts no new image for now, or undefined when it does.
   *
   * @param folder the folder's key
   */
  blocked(folder: string): { readonly until: BlockCause; readonly why: string } | undefined {
    return this.blocks.get(folder);
  }

  /** Whether anything is heard, examined, waiting or running. */
  busy(): boolean {
    const waiting = [...this.pending.values()].some((entry) =>
      KINDS.some((kind) => entry[kind].size > 0),
    );
    return (
      this.burst.size > 0 ||
      this.settle !== null ||
      this.examining > 0 ||
      this.running ||
      waiting ||
      this.held.size > 0
    );
  }

  /** Stops every timer; nothing runs after. */
  dispose(): void {
    this.disposed = true;
    this.clock.clearTimeout(this.settle);
    for (const timer of this.held.values()) this.clock.clearTimeout(timer);
    this.held.clear();
  }

  private async examineBurst(): Promise<void> {
    const byFolder = new Map<string, Heard[]>();
    for (const heard of this.burst.values()) {
      byFolder.set(heard.folder, [...(byFolder.get(heard.folder) ?? []), heard]);
    }
    this.burst.clear();
    this.examining += 1;
    try {
      for (const [folder, heard] of byFolder) {
        if (this.disposed) return;
        const images = await this.examine(folder, heard);
        if (images.length === 0) continue;
        if (images.length > ASK_ABOVE && !(await this.steps.ask(folder, images))) {
          this.steps.log(
            `Left as they are, as asked: ${plural(images.length, 'new image')} in ${folder}.`,
          );
          continue;
        }
        // The folder may have stopped converting while its images were examined.
        if (this.blocks.has(folder)) {
          for (const image of images) this.notConverted(folder, image.path);
          continue;
        }
        this.add(folder, images);
        this.pump();
      }
    } finally {
      this.examining -= 1;
    }
  }

  private async examine(folder: string, heard: readonly Heard[]): Promise<readonly NewImage[]> {
    if (this.blocks.has(folder)) {
      for (const entry of heard) this.notConverted(folder, entry.path);
      return [];
    }
    try {
      return await this.steps.examine(folder, heard);
    } catch (error) {
      this.steps.log(
        `Not converted: ${plural(heard.length, 'image')} that arrived in ${folder}, since Upfly could not tell whether they are new: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }

  private add(folder: string, images: readonly NewImage[]): void {
    const entry = this.pending.get(folder) ?? { paste: new Map(), arrival: new Map() };
    this.pending.set(folder, entry);
    for (const image of images) {
      if (image.kind === 'arrival' && entry.paste.has(image.path)) continue;
      if (image.kind === 'paste') entry.arrival.delete(image.path);
      entry[image.kind].set(image.path, image);
    }
  }

  /** The next batch: every waiting image of the first folder and kind not held, pastes first. */
  private next(): Batch | null {
    for (const kind of KINDS) {
      for (const [folder, entry] of this.pending) {
        if (entry[kind].size === 0 || this.held.has(`${folder}\0${kind}`)) continue;
        const images = [...entry[kind].values()];
        entry[kind].clear();
        if (KINDS.every((other) => entry[other].size === 0)) this.pending.delete(folder);
        return { folder, kind, images };
      }
    }
    return null;
  }

  private pump(): void {
    if (this.running || this.disposed) return;
    const batch = this.next();
    if (batch === null) return;
    this.running = true;
    void (async () => {
      let end: BatchEnd;
      try {
        end = await this.steps.run(batch);
      } catch (error) {
        this.steps.log(
          `Converting ${plural(batch.images.length, 'new image')} in ${batch.folder} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        end = { kind: 'done' };
      }
      this.ended(batch, end);
      this.running = false;
      this.pump();
    })();
  }

  private ended(batch: Batch, end: BatchEnd): void {
    const key = `${batch.folder}\0${batch.kind}`;
    switch (end.kind) {
      case 'done':
        this.attempts.delete(key);
        return;
      case 'cancelled':
        this.attempts.delete(key);
        this.steps.log(
          `Cancelled: ${plural(batch.images.length, 'new image')} in ${batch.folder} left as they are.`,
        );
        return;
      case 'blocked':
        this.block(batch.folder, end.until, end.why);
        return;
      case 'locked': {
        const attempt = this.attempts.get(key) ?? { count: 0, since: this.now() };
        attempt.count += 1;
        if (this.now() - attempt.since >= RETRY_LIMIT_MS) {
          this.attempts.delete(key);
          this.steps.log(
            `Not converted: ${plural(end.left.length, 'new image')} in ${batch.folder}, since another Upfly run held the project for 10 minutes.`,
          );
          return;
        }
        this.attempts.set(key, attempt);
        this.add(batch.folder, end.left);
        const delay = retryDelay(attempt.count);
        this.steps.log(
          `Another Upfly run is writing to ${batch.folder}: the new images there are converted after it, trying again in ${delay / 1_000} s.`,
        );
        this.held.set(
          key,
          this.clock.setTimeout(() => {
            this.held.delete(key);
            this.pump();
          }, delay),
        );
        return;
      }
    }
  }

  private block(folder: string, until: BlockCause, why: string): void {
    this.blocks.set(folder, { until, why });
    const entry = this.pending.get(folder);
    const dropped = KINDS.reduce((count, kind) => count + (entry?.[kind].size ?? 0), 0);
    this.pending.delete(folder);
    for (const kind of KINDS) {
      const key = `${folder}\0${kind}`;
      this.clock.clearTimeout(this.held.get(key));
      this.held.delete(key);
      this.attempts.delete(key);
    }
    this.steps.log(
      `Upfly converts no new image in ${folder} until ${untilText(until)}: ${why}${dropped > 0 ? ` Left as they are: ${plural(dropped, 'new image')} waiting there.` : ''}`,
    );
  }

  private notConverted(folder: string, image: string): void {
    const until = this.blocks.get(folder)?.until ?? 'config';
    this.steps.log(
      `Not converted: ${image}, which arrived in ${folder}, since Upfly converts no new image there until ${untilText(until)}.`,
    );
  }
}

/** A file's size and modification time. */
export interface Look {
  readonly size: number;
  readonly mtimeMs: number;
}

/** Which files stopped changing, with their sizes, which went, and which kept changing. */
export interface Steadiness {
  readonly steady: ReadonlyMap<string, number>;
  readonly gone: readonly string[];
  readonly growing: readonly string[];
}

/**
 * Waits until each file stops changing: the same size and modification time on two looks half
 * a second apart, so a file still being written is not converted half done. A file still
 * changing after a minute is left as it is.
 *
 * @param files the files
 * @param look a file's size and time, or null when it is gone
 * @param sleep waits the given milliseconds
 * @param now the time in milliseconds
 */
export async function waitUntilSteady(
  files: readonly string[],
  look: (file: string) => Look | null,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
): Promise<Steadiness> {
  const steady = new Map<string, number>();
  const gone: string[] = [];
  const start = now();
  let last = new Map<string, Look>();
  for (const file of files) {
    const seen = look(file);
    if (seen === null) gone.push(file);
    else last.set(file, seen);
  }
  while (last.size > 0 && now() - start < GIVE_UP_MS) {
    await sleep(LOOK_INTERVAL_MS);
    const changing = new Map<string, Look>();
    for (const [file, before] of last) {
      const seen = look(file);
      if (seen === null) gone.push(file);
      else if (seen.size === before.size && seen.mtimeMs === before.mtimeMs) {
        steady.set(file, seen.size);
      } else changing.set(file, seen);
    }
    last = changing;
  }
  return { steady, gone, growing: [...last.keys()] };
}
