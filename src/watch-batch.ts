/**
 * One batch of new images as the CLI runs it, and what its answer means: the command line, the
 * images it converted and how much smaller, the ones it left and why, the originals it kept,
 * and which refusals stop the watcher in a folder until something there changes.
 */

import path from 'node:path';
import type { ErrorLine, OptimizeResult } from './contract.js';
import { plural } from './format.js';
import type { WatchSettings } from './watch-config.js';
import type { Kind } from './watch-queue.js';

/** The settings that decide what happens to an original. */
type OriginalSettings = Pick<WatchSettings, 'keepOriginals' | 'outsideReplace'>;

/** How much of a command line a batch's images may take, well inside every system's limit. */
const ARGUMENT_BUDGET = 24_000;

/**
 * Whether a batch keeps its images' originals: an image from outside the editor keeps it,
 * unless the config treats those as pastes, and the config can keep every original.
 *
 * @param kind how the images came
 * @param settings the project's watch settings
 */
export function keepsOriginals(kind: Kind, settings: OriginalSettings): boolean {
  return settings.keepOriginals || (kind === 'arrival' && !settings.outsideReplace);
}

/**
 * Whether a batch's kept originals wait to be removed: those kept only because they came from
 * outside the editor, not those the config keeps for good.
 *
 * @param kind how the images came
 * @param settings the project's watch settings
 */
export function waitsForRemoval(kind: Kind, settings: OriginalSettings): boolean {
  return kind === 'arrival' && !settings.outsideReplace && !settings.keepOriginals;
}

/**
 * The arguments of `upfly optimize` for a batch: applied over uncommitted changes, kept out of
 * what `upfly undo` puts back, for exactly these images.
 *
 * @param images the images, relative to the project with `/`
 * @param keepOriginals whether each original stays beside its converted image
 */
export function batchArgs(images: readonly string[], keepOriginals: boolean): string[] {
  return [
    '--apply',
    '--allow-dirty',
    '--no-undo',
    ...(keepOriginals ? ['--keep-originals'] : []),
    ...images.flatMap((image) => ['--image', image]),
  ];
}

/**
 * A batch's images in groups whose command line fits, in order: one run for each group.
 *
 * @param images the images
 * @param budget how many characters a group's images may take
 */
export function argumentGroups(
  images: readonly string[],
  budget: number = ARGUMENT_BUDGET,
): string[][] {
  const groups: string[][] = [];
  let group: string[] = [];
  let length = 0;
  for (const image of images) {
    // The flag, the spaces between and a pair of quotes.
    const cost = image.length + '--image'.length + 4;
    if (group.length > 0 && length + cost > budget) {
      groups.push(group);
      group = [];
      length = 0;
    }
    group.push(image);
    length += cost;
  }
  if (group.length > 0) groups.push(group);
  return groups;
}

/** An image the batch converted. */
export interface Converted {
  readonly image: string;
  readonly target: string;
  readonly savedBytes: number;
  readonly originalKept: boolean;
}

/** An image left, or an original kept, with the CLI's reason. */
export interface Left {
  readonly image: string;
  readonly reason: string;
}

/** What a batch's run did with each of its images. */
export interface BatchReport {
  readonly converted: readonly Converted[];
  /** Images the CLI declined to convert. */
  readonly declined: readonly Left[];
  /** Images the CLI did not take for the project's, such as one `.upflyignore` leaves out. */
  readonly unmatched: readonly string[];
  /** Converted images whose original stayed though the batch was to remove it. */
  readonly keptAnyway: readonly Left[];
  /** Converted images whose original waits to be removed. */
  readonly waiting: readonly Converted[];
  /** Images the CLI said nothing about. */
  readonly silent: readonly string[];
}

/**
 * What an applied batch did with each of its images.
 *
 * @param images the batch's images
 * @param kind how they came
 * @param settings the project's watch settings
 * @param result the CLI's result
 */
export function reportOf(
  images: readonly string[],
  kind: Kind,
  settings: OriginalSettings,
  result: OptimizeResult,
): BatchReport {
  const named = new Set(images);
  const created = new Set(result.run?.created ?? []);
  const removed = new Set(result.run?.removed ?? []);
  const converted = result.plan.conversions
    .filter((conversion) => named.has(conversion.asset) && created.has(conversion.target))
    .map((conversion) => ({
      image: conversion.asset,
      target: conversion.target,
      savedBytes: conversion.savedBytes,
      originalKept: !removed.has(conversion.asset),
    }));
  const declined = result.plan.declined
    .filter(
      (entry) => named.has(entry.path) && !converted.some((done) => done.image === entry.path),
    )
    .map((entry) => ({ image: entry.path, reason: entry.reason }));
  const unmatched = (result.only?.unmatched ?? []).filter((image) => named.has(image));
  const keptAnyway = keepsOriginals(kind, settings)
    ? []
    : converted
        .filter((done) => done.originalKept)
        .map((done) => ({
          image: done.image,
          reason:
            result.plan.keptOriginals.find((kept) => kept.asset === done.image)?.reason ??
            'the original was kept.',
        }));
  const told = new Set([
    ...converted.map((done) => done.image),
    ...declined.map((entry) => entry.image),
    ...unmatched,
  ]);
  return {
    converted,
    declined,
    unmatched,
    keptAnyway,
    waiting: waitsForRemoval(kind, settings) ? converted.filter((done) => done.originalKept) : [],
    silent: images.filter((image) => !told.has(image)),
  };
}

/** What a refusal of a batch means for the folder's next ones. */
export type Refusal =
  /** Another run holds the project: try again after it. */
  | 'retry'
  /** Every batch would meet it again until the project's config changes. */
  | 'block-config'
  /** Every batch would meet it again until a run that stopped part way is dealt with. */
  | 'block-record'
  /** Only this batch is refused. */
  | 'refused';

/**
 * What a refusal of a batch means for the folder's next ones.
 *
 * @param error the CLI's error line
 * @param cutOff whether a run made without undo stopped part way in the folder, which every
 *   writing command puts back first, and is refused when a file it wrote changed since
 */
export function refusalOf(error: ErrorLine, cutOff: boolean): Refusal {
  switch (error.reason) {
    case 'TRANSACTION_LOCKED':
      return 'retry';
    case 'TRANSACTION_INTERRUPTED':
      return 'block-record';
    case 'TRANSACTION_FOREIGN_CHANGE':
      return cutOff ? 'block-record' : 'refused';
    case 'SERVING_ROOT_UNKNOWN':
    case 'CODE_CONFIG_NOT_RUN':
    case 'V2_EXTENSION_CONFIG':
      return 'block-config';
    default:
      // Exit 2 means the command line or the config is wrong, and the line is the extension's.
      return error.exitCode === 2 ? 'block-config' : 'refused';
  }
}

/** A format's name as a person reads it. */
export function formatName(format: 'webp' | 'avif'): string {
  return format === 'avif' ? 'AVIF' : 'WebP';
}

/**
 * What the status bar says once a batch converted: the image, or how many, and how much
 * smaller, as "hero.png converted to WebP, 82% smaller".
 *
 * @param converted the images converted
 * @param sizes each image's size before, or null when not known
 * @param format the format they converted to
 */
export function convertedText(
  converted: readonly Converted[],
  sizes: ReadonlyMap<string, number | null>,
  format: 'webp' | 'avif',
): string {
  const [first] = converted;
  const what =
    converted.length === 1 && first !== undefined
      ? path.posix.basename(first.image)
      : plural(converted.length, 'new image');
  let before = 0;
  let saved = 0;
  for (const done of converted) {
    const size = sizes.get(done.image);
    if (size === null || size === undefined || size <= 0) {
      return `${what} converted to ${formatName(format)}`;
    }
    before += size;
    saved += done.savedBytes;
  }
  const percent = Math.round((100 * saved) / before);
  const smaller = percent < 1 ? 'less than 1% smaller' : `${percent}% smaller`;
  return `${what} converted to ${formatName(format)}, ${smaller}`;
}

/**
 * The question asked before converting a burst of more than 50 images.
 *
 * @param count how many arrived
 * @param where the folder they arrived in
 * @param format the format they would convert to
 */
export function questionText(count: number, where: string, format: 'webp' | 'avif'): string {
  return `${count} new images arrived in ${where}. Convert them to ${formatName(format)}?`;
}

/**
 * The status bar's words while a batch converts, after "Upfly:".
 *
 * @param count how many images the batch converts
 */
export function convertingLabel(count: number): string {
  return `converting ${plural(count, 'new image')}`;
}
