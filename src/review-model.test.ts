import { describe, expect, it } from 'vitest';
import type { RunFile, RunList, UndoResult } from './contract.js';
import {
  accept,
  beforeDocument,
  beforeText,
  lineKey,
  reviewOf,
  undoneText,
} from './review-model.js';

const LOGO = { before: 'images/logo.png', after: 'images/logo.webp', image: 'images/logo.png' };
const HERO = { before: 'images/hero.jpg', after: 'images/hero.webp', image: 'images/hero.jpg' };

function file(path: string, lines: (number | null)[], extra: Partial<RunFile> = {}): RunFile {
  return {
    path,
    changedSince: false,
    changes: lines.map((line) => ({
      line,
      undone: false,
      paths: [{ ...LOGO, inComment: false }],
    })),
    ...extra,
  };
}

function run(files: RunFile[], extra: Partial<RunList> = {}): RunList {
  return {
    id: 'r1',
    startedAt: '2026-10-24T20:00:00.000Z',
    state: 'applied',
    files,
    originals: [{ path: 'images/logo.png', movedTo: null, back: false, changedSince: false }],
    created: ['images/logo.webp'],
    ...extra,
  };
}

const states = (review: ReturnType<typeof reviewOf>) =>
  review?.files.flatMap((entry) => entry.lines.map((line) => `${line.key} ${line.state}`));

describe('reviewOf', () => {
  it('has nothing to review when no run has written to the project', () => {
    expect(reviewOf(null, undefined)).toBeNull();
  });

  it('starts with every changed line pending, and the review open', () => {
    const review = reviewOf(run([file('index.html', [10, 12])]), undefined);
    expect([states(review), review?.open]).toEqual([
      ['index.html:10 pending', 'index.html:12 pending'],
      true,
    ]);
  });

  it('shows a line the CLI lists as undone as undone', () => {
    const listed = file('index.html', [10, 12]);
    const changes = listed.changes.map((change) =>
      change.line === 12 ? { ...change, undone: true } : change,
    );
    expect(states(reviewOf(run([{ ...listed, changes }]), undefined))).toEqual([
      'index.html:10 pending',
      'index.html:12 undone',
    ]);
  });

  it('shows a line accepted for this run as accepted', () => {
    const marks = { runId: 'r1', accepted: [lineKey('index.html', 12)] };
    expect(states(reviewOf(run([file('index.html', [10, 12])]), marks))).toEqual([
      'index.html:10 pending',
      'index.html:12 accepted',
    ]);
  });

  it('ignores what was accepted for another run, since the last run is no longer that one', () => {
    const marks = { runId: 'r0', accepted: [lineKey('index.html', 12)] };
    expect(states(reviewOf(run([file('index.html', [12])]), marks))).toEqual([
      'index.html:12 pending',
    ]);
  });

  it('shows the lines of a file changed since the run as not undoable, and keeps the review open', () => {
    const changed = file('index.html', [10], { changedSince: true });
    const review = reviewOf(
      run([
        { ...changed, changes: changed.changes.map((change) => ({ ...change, undone: null })) },
      ]),
      undefined,
    );
    expect([states(review), review?.open]).toEqual([['index.html:10 changed'], true]);
  });

  it('ends once every line is accepted or undone', () => {
    const listed = file('index.html', [10, 12]);
    const changes = listed.changes.map((change) =>
      change.line === 12 ? { ...change, undone: true } : change,
    );
    const marks = { runId: 'r1', accepted: [lineKey('index.html', 10)] };
    expect(reviewOf(run([{ ...listed, changes }]), marks)?.open).toBe(false);
  });

  it('ends when the whole run is undone', () => {
    expect(reviewOf(run([file('index.html', [10])], { state: 'undone' }), undefined)?.open).toBe(
      false,
    );
  });

  it('stays open for a run that stopped part way, which only the whole undo puts back', () => {
    expect(
      reviewOf(run([file('index.html', [10])], { state: 'interrupted' }), {
        runId: 'r1',
        accepted: [lineKey('index.html', 10)],
      })?.open,
    ).toBe(true);
  });

  it('counts the lines still waiting for Accept or Undo', () => {
    expect(
      reviewOf(run([file('a.css', [2]), file('index.html', [10, 12])]), undefined)?.pending,
    ).toBe(3);
  });
});

describe('accept', () => {
  it('adds the lines to what this run has accepted', () => {
    expect(accept({ runId: 'r1', accepted: ['a.css:2'] }, 'r1', ['index.html:10'])).toEqual({
      runId: 'r1',
      accepted: ['a.css:2', 'index.html:10'],
    });
  });

  it("starts again for a new run, dropping the last run's marks", () => {
    expect(accept({ runId: 'r0', accepted: ['a.css:2'] }, 'r1', ['index.html:10'])).toEqual({
      runId: 'r1',
      accepted: ['index.html:10'],
    });
  });
});

describe('undoneText', () => {
  const result = (extra: Partial<UndoResult> = {}): UndoResult => ({
    type: 'result',
    command: 'undo',
    exitCode: 0,
    undone: { id: 'r1', restored: [], reverted: ['index.html'], removed: [], moved: [] },
    part: { file: 'index.html', line: 12 },
    commit: null,
    notes: [],
    ...extra,
  });

  it('says which line was undone and which originals came back', () => {
    const undone = {
      id: 'r1',
      restored: ['a.jpg', 'b.jpg'],
      reverted: ['index.html'],
      removed: [],
      moved: [],
    };
    expect(undoneText(result({ undone }), 'Undo of line 12 of index.html')).toBe(
      'Undid line 12 of index.html. a.jpg and b.jpg are back.',
    );
  });

  it('says which converted files the whole undo removed', () => {
    const undone = { id: 'r1', restored: ['a.jpg'], reverted: [], removed: ['a.webp'], moved: [] };
    expect(undoneText(result({ undone, part: null }), 'Undo of the whole run r1')).toBe(
      'Undid the whole run r1. a.jpg is back. The converted file a.webp is gone again.',
    );
  });

  it("gives the CLI's note when there was nothing to undo", () => {
    expect(
      undoneText(
        result({ undone: null, notes: ['Line 12 is already undone.'] }),
        'Undo of line 12',
      ),
    ).toBe('Line 12 is already undone.');
  });

  it("adds the CLI's notes, such as what to do about a commit", () => {
    expect(undoneText(result({ notes: ['The commit stays.'] }), 'Undo of index.html')).toBe(
      'Undid index.html. The commit stays.',
    );
  });
});

describe('beforeText', () => {
  it('puts back each path the run wrote on the line, in order', () => {
    expect(
      beforeText('<img src="images/hero.webp" srcset="images/hero.webp 1x">', [
        { ...HERO, inComment: false },
        { ...HERO, inComment: false },
      ]),
    ).toBe('<img src="images/hero.jpg" srcset="images/hero.jpg 1x">');
  });

  it('is null when the line no longer holds a path the run wrote', () => {
    expect(beforeText('<img src="images/other.png">', [{ ...LOGO, inComment: false }])).toBeNull();
  });
});

describe('beforeDocument', () => {
  it('is the file as it was before the run, but for the lines already undone', () => {
    const text = [
      '<img src="images/logo.webp">',
      '<img src="images/hero.jpg">',
      '<p>images/logo.webp stays as written</p>',
      '',
    ].join('\n');
    const changes: RunFile = {
      path: 'index.html',
      changedSince: false,
      changes: [
        { line: 1, undone: false, paths: [{ ...LOGO, inComment: false }] },
        { line: 2, undone: true, paths: [{ ...HERO, inComment: false }] },
      ],
    };
    expect(beforeDocument(text, changes)).toBe(
      [
        '<img src="images/logo.png">',
        '<img src="images/hero.jpg">',
        '<p>images/logo.webp stays as written</p>',
        '',
      ].join('\n'),
    );
  });
});
