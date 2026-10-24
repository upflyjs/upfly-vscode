/**
 * The plan document, built from the result of `upfly optimize --json` without `--apply`:
 * what converts and what it saves, every line to be rewritten with its text before and after,
 * the originals to be removed from a folder the site serves, and what is left alone and why.
 * The lines come from the files' text as it was when the plan arrived, and a file whose text
 * no longer has the hash the CLI planned on is named as changed instead.
 */

import { createHash } from 'node:crypto';
import type { OptimizeResult, Plan, Rewrite } from './contract.js';
import { codeSpan, formatBytes, plural } from './format.js';

/** Which images a plan is for: the ones a person chose, or every image in the folder. */
export type PlanScope =
  | { readonly kind: 'images'; readonly images: readonly string[] }
  | { readonly kind: 'workspace' };

/** One path a line's rewrite changes. */
export interface PlanPath {
  readonly before: string;
  readonly after: string;
  readonly inComment: boolean;
}

/** One line a plan rewrites. */
export interface PlanLine {
  /** Counted from 1. */
  readonly line: number;
  /** The line's text, or the part of a long line around its changes. */
  readonly before: string;
  readonly after: string;
  readonly paths: readonly PlanPath[];
}

/** What the plan document shows. */
export interface PlanView {
  /** The workspace folder's name. */
  readonly folder: string;
  readonly path: string;
  readonly when: string;
  readonly cliVersion: string;
  readonly scope: PlanScope;
  readonly keepOriginals: boolean;
  readonly result: OptimizeResult;
  /** Each rewritten file's text as read when the plan arrived, or null when it could not be. */
  readonly texts: ReadonlyMap<string, string | null>;
  /** Sentences about the plan's state, shown under the header: applied, refused, planned again. */
  readonly banner: readonly string[];
}

/** The counts in a plan's summary. */
export interface PlanSummary {
  readonly images: number;
  readonly savedBytes: number;
  /** References rewritten, not counting paths inside comments. */
  readonly references: number;
  readonly comments: number;
  readonly lines: number;
  readonly files: number;
  /** Originals removed once no file names them. */
  readonly removed: number;
  /** Of those, the ones in a folder the site serves. */
  readonly served: number;
  /** Images left alone. */
  readonly left: number;
  /** References left as written. */
  readonly leftReferences: number;
}

/** Above this many characters, a line is shown only around its changes. */
const LONG_LINE = 160;
/** How much of a long line is kept on each side of its changes. */
const CONTEXT = 40;

/**
 * The hash the CLI records for a file's text: SHA-256 of the text as UTF-8, in hexadecimal.
 *
 * @param text the file's text
 */
export function textHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The lines a rewrite changes, each with its text before and after, in the file's order.
 *
 * @param rewrite one file's edits, as the plan lists them
 * @param text the file's text the edits were planned on
 */
export function rewrittenLines(rewrite: Rewrite, text: string): PlanLine[] {
  const starts = [0];
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    starts.push(index + 1);
  }
  const byLine = new Map<number, Rewrite['edits'][number][]>();
  for (const edit of [...rewrite.edits].sort((a, b) => a.start - b.start)) {
    const line = lineOf(starts, edit.start);
    byLine.set(line, [...(byLine.get(line) ?? []), edit]);
  }
  return [...byLine].map(([index, edits]) => {
    const start = starts[index] as number;
    const next = starts[index + 1];
    const raw = text.slice(start, next === undefined ? text.length : next - 1);
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    let after = line;
    for (const edit of [...edits].reverse()) {
      after = after.slice(0, edit.start - start) + edit.replacement + after.slice(edit.end - start);
    }
    const first = (edits[0]?.start ?? start) - start;
    const last = (edits.at(-1)?.end ?? start) - start;
    const grown = after.length - line.length;
    return {
      line: index + 1,
      before: excerpt(line, first, last),
      after: excerpt(after, first, last + grown),
      paths: edits.map((edit) => ({
        before: text.slice(edit.start, edit.end),
        after: edit.replacement,
        inComment: edit.inComment === true,
      })),
    };
  });
}

/** The index of the line holding an offset, from the offsets the lines start at. */
function lineOf(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((starts[middle] as number) <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** A long line cut down to its changes and some text on each side. */
function excerpt(line: string, from: number, to: number): string {
  if (line.length <= LONG_LINE) return line;
  const start = Math.max(0, from - CONTEXT);
  const end = Math.min(line.length, to + CONTEXT);
  return `${start > 0 ? '...' : ''}${line.slice(start, end)}${end < line.length ? '...' : ''}`;
}

/**
 * The originals a plan removes that sit in a folder the site serves, which a link from outside
 * the project can name.
 *
 * @param plan the plan
 */
export function servedOriginals(plan: Plan): string[] {
  return plan.conversions
    .filter((conversion) => conversion.replacesOriginal && conversion.inPublicDir)
    .map((conversion) => conversion.asset);
}

/**
 * The counts a plan's summary gives.
 *
 * @param plan the plan
 * @param texts each rewritten file's text, to count its lines
 */
export function planSummary(plan: Plan, texts: ReadonlyMap<string, string | null>): PlanSummary {
  const edits = plan.rewrites.flatMap((rewrite) => rewrite.edits);
  const lines = plan.rewrites.reduce((sum, rewrite) => {
    const text = texts.get(rewrite.file);
    return (
      sum +
      (text === undefined || text === null || textHash(text) !== rewrite.textHash
        ? rewrite.edits.length
        : rewrittenLines(rewrite, text).length)
    );
  }, 0);
  return {
    images: plan.conversions.length,
    savedBytes: plan.conversions.reduce((sum, conversion) => sum + conversion.savedBytes, 0),
    references: edits.filter((edit) => edit.inComment !== true).length,
    comments: edits.filter((edit) => edit.inComment === true).length,
    lines,
    files: plan.rewrites.length,
    removed: plan.conversions.filter((conversion) => conversion.replacesOriginal).length,
    served: servedOriginals(plan).length,
    left: plan.declined.filter((entry) => entry.line === null).length,
    leftReferences: plan.declined.filter((entry) => entry.line !== null).length,
  };
}

/**
 * Renders the plan document.
 *
 * @param view the plan and what the document says about it
 * @returns the document's text, in Markdown
 */
export function renderPlan(view: PlanView): string {
  const { plan, notes, only } = view.result;
  const summary = planSummary(plan, view.texts);
  const out: string[] = [
    `# Upfly plan: ${view.folder}`,
    '',
    `The folder ${view.path}, planned at ${view.when} by upfly ${view.cliVersion} for ${scopeText(view.scope)}. Nothing changes until you apply the plan.`,
  ];
  if (view.banner.length > 0) out.push('', ...view.banner.map((line) => `> ${line}`));
  out.push('');
  if (plan.conversions.length === 0 && plan.rewrites.length === 0) {
    out.push('Nothing to convert: no image would be converted.');
  } else {
    out.push(...summaryLines(view, summary), '', applyRule(view.scope));
  }
  if (only !== null && only.unmatched.length > 0) {
    out.push('', `No image matched ${only.unmatched.map(codeSpan).join(', ')}.`);
  }

  const served = view.keepOriginals ? [] : servedOriginals(plan);
  if (served.length > 0) {
    const one = served.length === 1;
    section(
      out,
      `${plural(served.length, 'original')} to be removed ${one ? 'sits' : 'sit'} in a folder the site serves`,
      [
        `A link to ${one ? 'it' : 'one'} from outside the project, such as an email, another site or a CMS, stops working once the run applies. Keep these originals to leave each one beside its converted image.`,
        '',
        ...served.map((asset) => `- ${codeSpan(asset)}`),
      ],
    );
  }
  if (plan.conversions.length > 0) {
    section(
      out,
      'Converts',
      plan.conversions.map(
        (conversion) =>
          `- ${codeSpan(conversion.asset)} to ${codeSpan(conversion.target)}, ${formatBytes(conversion.savedBytes)} less; ${conversion.replacesOriginal ? 'the original is removed once no file names it' : 'the original stays'}.`,
      ),
    );
  }
  if (plan.rewrites.length > 0) {
    section(
      out,
      'Rewrites',
      plan.rewrites.flatMap((rewrite) => rewriteLines(rewrite, view.texts)),
    );
  }
  if (!view.keepOriginals && plan.keptOriginals.length > 0) {
    section(
      out,
      'Originals that stay',
      plan.keptOriginals.map((kept) => `- ${codeSpan(kept.asset)}: ${kept.reason}`),
    );
  }
  if (plan.declined.length > 0) {
    section(
      out,
      'Left alone',
      plan.declined.map(
        (entry) =>
          `- ${codeSpan(entry.line === null ? entry.path : `${entry.path}:${entry.line}`)}: ${entry.reason}`,
      ),
    );
  }
  if (notes.length > 0)
    section(
      out,
      'Notes',
      notes.map((note) => `- ${note}`),
    );
  return `${out.join('\n')}\n`;
}

function scopeText(scope: PlanScope): string {
  if (scope.kind === 'workspace') return 'every image in it';
  return scope.images.length === 1
    ? `the image you chose, ${codeSpan(scope.images[0] as string)}`
    : `the ${scope.images.length} images you chose`;
}

function summaryLines(view: PlanView, summary: PlanSummary): string[] {
  const formats = new Set(view.result.plan.conversions.map((conversion) => conversion.format));
  const to = formats.size > 1 ? 'WebP or AVIF' : formats.has('avif') ? 'AVIF' : 'WebP';
  const comments =
    summary.comments === 0 ? '' : `, and ${plural(summary.comments, 'path')} in comments`;
  const left = [
    summary.left === 0 ? null : `${plural(summary.left, 'image')} alone`,
    summary.leftReferences === 0
      ? null
      : `${plural(summary.leftReferences, 'reference')} as written`,
  ].filter((part) => part !== null);
  return [
    `- Converts ${plural(summary.images, 'image')} to ${to}, ${formatBytes(summary.savedBytes)} smaller together.`,
    `- Rewrites ${plural(summary.references, 'reference')}${comments} on ${plural(summary.lines, 'line')} in ${plural(summary.files, 'file')}.`,
    view.keepOriginals
      ? '- Keeps every original beside its converted image.'
      : `- Removes ${plural(summary.removed, 'original')} once no file names them.`,
    ...(left.length === 0 ? [] : [`- Leaves ${left.join(', and ')}.`]),
  ];
}

function applyRule(scope: PlanScope): string {
  const review = 'the review afterwards can undo any line, any file or the whole run.';
  return scope.kind === 'images'
    ? `Applying writes over uncommitted changes and makes no commit; ${review}`
    : `Applying needs a folder with no uncommitted changes, and commits the run as one commit; ${review}`;
}

function rewriteLines(rewrite: Rewrite, texts: ReadonlyMap<string, string | null>): string[] {
  const text = texts.get(rewrite.file);
  const head = [`### ${rewrite.file}`, ''];
  if (text === undefined || text === null) {
    return [...head, `${rewrite.file} could not be read, so its lines are not shown.`, ''];
  }
  if (textHash(text) !== rewrite.textHash) {
    return [
      ...head,
      `${rewrite.file} changed since this plan was made, so its lines are not shown. Plan again to see them.`,
      '',
    ];
  }
  return [
    ...head,
    ...rewrittenLines(rewrite, text).flatMap((line) => [
      `- Line ${line.line}: ${pathsText(line.paths)}`,
      `  - before: ${codeSpan(line.before)}`,
      `  - after: ${codeSpan(line.after)}`,
    ]),
    '',
  ];
}

/** The paths a line changes, each once, in their order. */
export function pathsText(paths: readonly PlanPath[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const path of paths) {
    const part = `${codeSpan(path.before)} to ${codeSpan(path.after)}${path.inComment ? ' (in a comment)' : ''}`;
    if (!seen.has(part)) parts.push(part);
    seen.add(part);
  }
  return parts.join(', ');
}

function section(out: string[], title: string, lines: readonly string[]): void {
  out.push('', `## ${title}`, '', ...lines);
  while (out.at(-1) === '') out.pop();
}
