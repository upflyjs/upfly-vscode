/**
 * Broken references as entries for the Problems panel, from an audit's findings: each at its
 * file and line, on the path as written where the line holds it.
 */

import type { Finding } from './contract.js';

/** One entry for the Problems panel. */
export interface Problem {
  /** Relative to the workspace folder, with `/`. */
  readonly file: string;
  /** Counted from 0, as the editor counts lines. */
  readonly line: number;
  /** The columns the entry covers on the line, in UTF-16 code units. */
  readonly start: number;
  readonly end: number;
  readonly message: string;
  /** The path as written, when the entry covers it on its line; null when it is not found there. */
  readonly written: string | null;
}

/**
 * The broken references among an audit's findings.
 *
 * @param findings the report's findings
 * @param textOf a file's text, or null when it cannot be read
 */
export function brokenProblems(
  findings: readonly Finding[],
  textOf: (file: string) => string | null,
): Problem[] {
  const problems: Problem[] = [];
  for (const finding of findings) {
    if (finding.kind !== 'broken') continue;
    const message = `No file is at ${finding.rawPath}, which this line names as an image.${finding.note === undefined ? '' : ` ${finding.note}`}`;
    const lines = textOf(finding.file)?.split('\n') ?? null;
    const placed = place(lines, finding.line, finding.rawPath);
    const written = placed.end > placed.start ? finding.rawPath : null;
    problems.push({ file: finding.file, message, ...placed, written });
  }
  return problems;
}

function place(
  lines: readonly string[] | null,
  line: number | null,
  path: string,
): { line: number; start: number; end: number } {
  if (lines === null) return { line: Math.max(0, (line ?? 1) - 1), start: 0, end: 0 };
  if (line !== null) {
    const column = (lines[line - 1] ?? '').indexOf(path);
    return column === -1
      ? { line: line - 1, start: 0, end: 0 }
      : { line: line - 1, start: column, end: column + path.length };
  }
  for (const [index, text] of lines.entries()) {
    const column = text.indexOf(path);
    if (column !== -1) return { line: index, start: column, end: column + path.length };
  }
  return { line: 0, start: 0, end: 0 };
}
