/**
 * The review of the last run, built from `upfly undo --list --json` and the lines the person
 * accepted. The CLI's list is the record: which lines are undone, which files changed since
 * the run. Accepting changes no file, so the extension keeps those marks itself, by run id; a
 * mark for any other run counts for nothing, because the last run is then another one.
 */

import path from 'node:path';
import type { RunFile, RunList, RunPath, UndoResult } from './contract.js';
import type { HostOutcome } from './host.js';

/**
 * Where one changed line stands: waiting for Accept or Undo, accepted, undone, or in a file
 * changed since the run, which the CLI cannot undo line by line.
 */
export type LineState = 'pending' | 'accepted' | 'undone' | 'changed';

/** The lines accepted in the review of one run. */
export interface AcceptMarks {
  readonly runId: string;
  /** Each line's key, from `lineKey`. */
  readonly accepted: readonly string[];
}

/** One changed line in the review. */
export interface ReviewLine {
  readonly file: string;
  /** Counted from 1, or null for a run an older Upfly recorded. */
  readonly line: number | null;
  readonly key: string;
  readonly state: LineState;
  readonly paths: readonly RunPath[];
}

/** One rewritten file in the review. */
export interface ReviewFile {
  readonly path: string;
  readonly changedSince: boolean;
  readonly lines: readonly ReviewLine[];
}

/** The review of the last run. */
export interface Review {
  readonly runId: string;
  readonly startedAt: string;
  readonly state: RunList['state'];
  readonly files: readonly ReviewFile[];
  readonly originals: RunList['originals'];
  readonly created: readonly string[];
  /** Lines still waiting for Accept or Undo. */
  readonly pending: number;
  /** Whether the review goes on: some line waits, or the run stopped part way. */
  readonly open: boolean;
  /** Whether a line, a file or an original can be undone alone; only the whole undo puts back a run cut short. */
  readonly partsUndoable: boolean;
}

/**
 * The key a line is accepted under.
 *
 * @param file the file, as a path inside the project
 * @param line the line, counted from 1, or null when the run did not record it
 */
export function lineKey(file: string, line: number | null): string {
  return `${file}:${line ?? '?'}`;
}

/**
 * The review of a run, or null when no run has written to the project.
 *
 * @param run the last run, as `undo --list` lists it
 * @param marks the lines accepted so far, for whichever run they were accepted in
 */
export function reviewOf(run: RunList | null, marks: AcceptMarks | undefined): Review | null {
  if (run === null) return null;
  const accepted = new Set(marks?.runId === run.id ? marks.accepted : []);
  const files = run.files.map((file) => ({
    path: file.path,
    changedSince: file.changedSince,
    lines: file.changes.map((change): ReviewLine => {
      const key = lineKey(file.path, change.line);
      return {
        file: file.path,
        line: change.line,
        key,
        state: lineState(change.undone, accepted.has(key)),
        paths: change.paths,
      };
    }),
  }));
  const pending = files
    .flatMap((file) => file.lines)
    .filter((line) => line.state === 'pending' || line.state === 'changed').length;
  return {
    runId: run.id,
    startedAt: run.startedAt,
    state: run.state,
    files,
    originals: run.originals,
    created: run.created,
    pending,
    open: run.state === 'interrupted' || (run.state === 'applied' && pending > 0),
    partsUndoable: run.state === 'applied',
  };
}

function lineState(undone: boolean | null, accepted: boolean): LineState {
  if (undone === true) return 'undone';
  if (accepted) return 'accepted';
  return undone === null ? 'changed' : 'pending';
}

/**
 * The marks after accepting some lines of a run.
 *
 * @param marks the marks so far, perhaps of an earlier run
 * @param runId the run the lines belong to
 * @param keys the lines' keys
 */
export function accept(
  marks: AcceptMarks | undefined,
  runId: string,
  keys: readonly string[],
): AcceptMarks {
  const kept = marks?.runId === runId ? marks.accepted : [];
  return { runId, accepted: [...new Set([...kept, ...keys])] };
}

/**
 * A line's text as it was before the run: each path the run wrote put back to the one it
 * replaced, in their order on the line.
 *
 * @param text the line as it is now
 * @param paths the paths the run rewrote on it
 * @returns the text, or null when the line no longer holds one of the paths the run wrote
 */
export function beforeText(text: string, paths: readonly RunPath[]): string | null {
  let out = '';
  let from = 0;
  for (const path of paths) {
    if (path.after === null) return null;
    const at = text.indexOf(path.after, from);
    if (at === -1) return null;
    out += text.slice(from, at) + path.before;
    from = at + path.after.length;
  }
  return out + text.slice(from);
}

/**
 * A file's text as it was before the run, for a diff: every line the run changed and nobody
 * undid since, put back. A line that no longer holds what the run wrote is left as it is.
 *
 * @param text the file's text now
 * @param file the file's changes, as `undo --list` lists them
 */
export function beforeDocument(text: string, file: RunFile): string {
  const lines = text.split('\n');
  for (const change of file.changes) {
    if (change.line === null || change.undone !== false) continue;
    const index = change.line - 1;
    const now = lines[index];
    if (now === undefined) continue;
    const carriage = now.endsWith('\r');
    const before = beforeText(carriage ? now.slice(0, -1) : now, change.paths);
    if (before !== null) lines[index] = carriage ? `${before}\r` : before;
  }
  return lines.join('\n');
}

/**
 * What an undo put back, in words, from its result: the part undone, the originals back, the
 * converted files a whole undo removed, and the CLI's own notes.
 *
 * @param result the undo's result line
 * @param what what was undone, starting "Undo of" or "Bringing back"
 */
export function undoneText(result: UndoResult, what: string): string {
  const undone = result.undone;
  if (undone === null) return result.notes[0] ?? `${what}: there was nothing to undo.`;
  const done = what.replace(/^Undo of/, 'Undid').replace(/^Bringing back/, 'Brought back');
  const parts = [`${done}.`];
  if (undone.restored.length > 0) {
    parts.push(`${listed(undone.restored)} ${undone.restored.length === 1 ? 'is' : 'are'} back.`);
  }
  if (undone.removed.length > 0) {
    parts.push(
      `The converted ${undone.removed.length === 1 ? 'file' : 'files'} ${listed(undone.removed)} ${undone.removed.length === 1 ? 'is' : 'are'} gone again.`,
    );
  }
  return [...parts, ...result.notes].join(' ');
}

/** Names as a list in words: `a`, `a and b`, `a, b and c`. */
function listed(names: readonly string[]): string {
  return names.length < 2
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * The check an Undo runs first, in the same turn of the queue: the last run must still be the
 * one its button was shown for, since `undo --file` acts on whichever run is last.
 *
 * @param runId the run the button belongs to
 */
export function sameRun(runId: string): {
  command: 'undo';
  args: string[];
  accept: (outcome: HostOutcome) => string | null;
} {
  return {
    command: 'undo',
    args: ['--list'],
    accept: (outcome) =>
      outcome.kind === 'result' && (outcome.result as UndoResult).run?.id === runId
        ? null
        : `The last run is no longer run ${runId}, which this button was for, so nothing was undone. The review is read again.`,
  };
}

/**
 * Whether a file is a folder's record of its last run, `.upfly/manifest.json` at its top,
 * whose change means the review is read again. A run made without undo keeps its record in
 * `.upfly/no-undo/` and never becomes the last run, so the review does not follow it.
 *
 * @param folder the workspace folder, an absolute path
 * @param file the file that changed, an absolute path
 */
export function isLastRunRecord(folder: string, file: string): boolean {
  return file === path.join(folder, '.upfly', 'manifest.json');
}
