/**
 * Removing the originals kept beside their converted image: the CLI's command lines, which
 * saves call for a removal, and what each run's answer means for the list of waiting
 * originals. The CLI decides whether an original may go; this decides when to ask it, and
 * which originals are still worth waiting for.
 */

import path from 'node:path';
import type { OptimizeResult } from './contract.js';
import { plural } from './format.js';
import type { Stamp, WaitingOriginal } from './waiting.js';

/**
 * The arguments of `upfly optimize` that remove these originals, or with `apply` false, that
 * plan their removal and write nothing. An applied removal makes no undo record, as the
 * conversion that kept them made none.
 *
 * @param originals the originals, relative to the project with `/`
 * @param apply whether to write
 */
export function removalArgs(originals: readonly string[], apply: boolean): string[] {
  return [
    ...(apply ? ['--apply', '--allow-dirty', '--no-undo'] : []),
    '--remove-originals',
    ...originals.flatMap((original) => ['--image', original]),
  ];
}

/**
 * The waiting originals whose converted image a text names by its file name, such as
 * `hero.webp`: a cheap sign that a line may now use it, after which the CLI decides.
 *
 * @param text a saved document's text
 * @param waiting the originals waiting in its folder
 */
export function convertedNamedIn(
  text: string,
  waiting: readonly WaitingOriginal[],
): WaitingOriginal[] {
  return waiting.filter((entry) => text.includes(path.posix.basename(entry.converted)));
}

/**
 * Whether a text names a waiting original by its file name, so a line in it may now use the
 * original rather than its converted image.
 *
 * @param text a saved document's text
 * @param waiting the originals waiting in its folder
 */
export function originalNamedIn(text: string, waiting: readonly WaitingOriginal[]): boolean {
  return waiting.some((entry) => text.includes(path.posix.basename(entry.original)));
}

/**
 * Why an original is no longer worth waiting for, or null when it still is: it is gone, its
 * converted image is gone, or it changed since the conversion, so the converted image no
 * longer shows it and removing it would lose that change.
 *
 * @param entry the waiting original
 * @param look a file's size and time, relative to the project, or null when it is not there
 */
export function notWaiting(
  entry: WaitingOriginal,
  look: (relative: string) => Stamp | null,
): string | null {
  const original = look(entry.original);
  if (original === null) return `${entry.original} is gone`;
  if (look(entry.converted) === null) {
    return `${entry.converted} is gone, so nothing stands in for ${entry.original}`;
  }
  if (entry.originalStamp !== undefined && !sameStamp(original, entry.originalStamp)) {
    return `${entry.original} changed since it was converted, so ${entry.converted} no longer shows it`;
  }
  return null;
}

/** What one removal run's answer means for the originals it was asked about. */
export interface RemovalOutcome {
  /** Removed by the run. */
  readonly removed: readonly string[];
  /** No longer waiting, with why. */
  readonly dropped: readonly { readonly original: string; readonly why: string }[];
  /** Still waiting, with the CLI's reason, or null when it gave none. */
  readonly staying: readonly { readonly original: string; readonly reason: string | null }[];
  /** What the CLI's rules let go, in a run that wrote nothing. */
  readonly removable: readonly string[];
}

/**
 * Sorts the originals a removal run was asked about by what its answer says of each. One the
 * CLI kept stays waiting with its reason, unless nothing is left to wait for: it is gone or
 * changed since, or its converted image is gone, or changed since the conversion wrote it,
 * which is how it came to be another picture.
 *
 * @param asked the waiting originals the run named
 * @param result the CLI's result
 * @param look a file's size and time, relative to the project, or null when it is not there
 */
export function removalOutcome(
  asked: readonly WaitingOriginal[],
  result: OptimizeResult,
  look: (relative: string) => Stamp | null,
): RemovalOutcome {
  const answer: Answer = {
    removed: new Set(result.run?.removed ?? []),
    unmatched: new Set(result.only?.unmatched ?? []),
    declined: new Map(result.plan.declined.map((entry) => [entry.path, entry.reason])),
    planned: new Set((result.plan.removals ?? []).map((removal) => removal.asset)),
    wrote: result.run !== null,
  };
  const outcome = {
    removed: [] as string[],
    dropped: [] as { original: string; why: string }[],
    staying: [] as { original: string; reason: string | null }[],
    removable: [] as string[],
  };
  for (const entry of asked) {
    const { original } = entry;
    const said = fateOf(entry, answer, look);
    if (said.kind === 'removed') outcome.removed.push(original);
    else if (said.kind === 'dropped') outcome.dropped.push({ original, why: said.why });
    else if (said.kind === 'removable') outcome.removable.push(original);
    else outcome.staying.push({ original, reason: said.reason });
  }
  return outcome;
}

/** A removal run's answer, read for looking up one original at a time. */
interface Answer {
  readonly removed: ReadonlySet<string>;
  readonly unmatched: ReadonlySet<string>;
  readonly declined: ReadonlyMap<string, string>;
  readonly planned: ReadonlySet<string>;
  readonly wrote: boolean;
}

type Fate =
  | { readonly kind: 'removed' }
  | { readonly kind: 'dropped'; readonly why: string }
  | { readonly kind: 'removable' }
  | { readonly kind: 'staying'; readonly reason: string | null };

function fateOf(
  entry: WaitingOriginal,
  answer: Answer,
  look: (relative: string) => Stamp | null,
): Fate {
  const { original } = entry;
  if (answer.removed.has(original)) return { kind: 'removed' };
  if (answer.unmatched.has(original)) {
    return { kind: 'dropped', why: `${original} is no longer an image in the project` };
  }
  const reason = answer.declined.get(original);
  const why = notWaiting(entry, look) ?? (reason === undefined ? null : replaced(entry, look));
  if (why !== null) return { kind: 'dropped', why };
  if (reason !== undefined) return { kind: 'staying', reason };
  if (answer.planned.has(original) && !answer.wrote) return { kind: 'removable' };
  return { kind: 'staying', reason: null };
}

/**
 * The originals a dry run found removable whose converted image a line in the project uses:
 * the ones opening a folder removes, since the CLI lets an original go once nothing names it,
 * even when nothing names its converted image yet.
 *
 * @param result the dry run's result
 */
export function removableOnOpen(result: OptimizeResult): string[] {
  const used = new Set(result.report.keptOriginals.assets.map((kept) => kept.asset));
  return (result.plan.removals ?? []).map((removal) => removal.asset).filter((a) => used.has(a));
}

/**
 * What the person reads once the removal they asked for ran.
 *
 * @param outcome what the runs did, in every folder
 */
export function clickedText(outcome: RemovalOutcome): string {
  const { removed, staying, dropped } = outcome;
  const sentences: string[] = [];
  if (removed.length > 0) {
    sentences.push(
      `Removed ${plural(removed.length, 'original')} kept beside ${removed.length === 1 ? 'its converted image' : 'their converted images'}.`,
    );
  }
  const [only] = staying;
  if (staying.length === 1 && only !== undefined && only.reason !== null) {
    sentences.push(`${only.original} stays: ${only.reason}.`);
  } else if (staying.length > 0) {
    const why = staying.some((entry) => entry.reason !== null)
      ? ': the count in the status bar says why'
      : '';
    sentences.push(
      `${plural(staying.length, 'original')} ${staying.length === 1 ? 'stays' : 'stay'}${why}.`,
    );
  }
  if (dropped.length > 0) {
    sentences.push(
      `${plural(dropped.length, 'original')} no longer ${dropped.length === 1 ? 'waits' : 'wait'} to be removed: the Upfly output says why.`,
    );
  }
  return sentences.length === 0
    ? 'No original kept beside a converted image was waiting to be removed.'
    : sentences.join(' ');
}

/**
 * The status bar's words for the waiting originals.
 *
 * @param count how many are waiting
 */
export function waitingLabel(count: number): string {
  return `${plural(count, 'original')} kept`;
}

/** How many originals the tooltip names before it says how many more there are. */
const LISTED = 8;

/**
 * The status bar's tooltip for the waiting originals: what they are, what happens to them, and
 * each one with why it stayed.
 *
 * @param waiting the originals waiting, with the name of each one's workspace folder
 * @param canRemove whether the carried CLI can remove them
 * @param held why Upfly stopped removing them by itself in a folder, by the folder's name
 */
export function waitingTooltip(
  waiting: readonly (WaitingOriginal & { readonly folderName: string })[],
  canRemove: boolean,
  held: ReadonlyMap<string, string> = new Map(),
): string {
  const folders = new Set(waiting.map((entry) => entry.folderName));
  const lines = waiting.slice(0, LISTED).map((entry) => {
    const where = folders.size > 1 ? `${entry.folderName}: ` : '';
    const why = entry.reason === undefined ? '' : `, kept because ${entry.reason}`;
    return `${where}${entry.original}${why}`;
  });
  if (waiting.length > LISTED) lines.push(`and ${waiting.length - LISTED} more`);
  const what =
    waiting.length === 1
      ? 'An image from outside the editor was converted, and its original is kept beside the converted image.'
      : `${waiting.length} images from outside the editor were converted, and their originals are kept beside the converted images.`;
  const next = canRemove
    ? 'Upfly removes each one once a line names its converted image and none names the original, checked when a file is saved and when the folder opens. Click to remove them now.'
    : 'Removing them comes with a later version of Upfly. Until then, delete each one yourself once no line names it.';
  const stopped = [...held].map(
    ([folder, why]) =>
      `Upfly stopped removing them by itself in ${folder}: ${why} Click to try again.`,
  );
  return [what, next, ...stopped, '', ...lines].join('\n');
}

function replaced(entry: WaitingOriginal, look: (relative: string) => Stamp | null) {
  const now = look(entry.converted);
  return entry.convertedStamp !== undefined && now !== null && !sameStamp(now, entry.convertedStamp)
    ? `${entry.converted} changed since Upfly wrote it, so it may be another picture`
    : null;
}

function sameStamp(a: Stamp, b: Stamp): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
}
