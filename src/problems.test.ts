import { describe, expect, it } from 'vitest';
import type { Finding } from './contract.js';
import { brokenProblems } from './problems.js';

const TEXTS: Record<string, string> = {
  'about.html': '<h1>About</h1>\n<img src="images/missing-on-purpose.png">\n',
  'a.css': '.a {}\n.b { background: url(gone.png) }\n',
};
const textOf = (file: string) => TEXTS[file] ?? null;

function broken(extra: Partial<Extract<Finding, { kind: 'broken' }>> = {}): Finding {
  return {
    kind: 'broken',
    file: 'about.html',
    line: 2,
    where: 'about.html:2',
    rawPath: 'images/missing-on-purpose.png',
    ...extra,
  };
}

describe('brokenProblems', () => {
  it('places a broken reference at its line, on the path as written', () => {
    expect(brokenProblems([broken()], textOf)).toEqual([
      {
        file: 'about.html',
        line: 1,
        start: 10,
        end: 39,
        message: 'No file is at images/missing-on-purpose.png, which this line names as an image.',
      },
    ]);
  });

  it("adds the finding's note to the message", () => {
    const [problem] = brokenProblems(
      [broken({ note: 'images/Missing-On-Purpose.png differs only in letter case.' })],
      textOf,
    );
    expect(problem?.message).toBe(
      'No file is at images/missing-on-purpose.png, which this line names as an image. images/Missing-On-Purpose.png differs only in letter case.',
    );
  });

  it('finds the path in the file when the line is not known', () => {
    const [problem] = brokenProblems(
      [broken({ file: 'a.css', line: null, where: 'a.css', rawPath: 'gone.png' })],
      textOf,
    );
    expect([problem?.line, problem?.start, problem?.end]).toEqual([1, 21, 29]);
  });

  it('marks the start of the line when the path is not on it as written', () => {
    const [problem] = brokenProblems([broken({ rawPath: 'elsewhere.png' })], textOf);
    expect([problem?.line, problem?.start, problem?.end]).toEqual([1, 0, 0]);
  });

  it('marks the top of a file it cannot read', () => {
    const [problem] = brokenProblems([broken({ file: 'gone.html', line: null })], textOf);
    expect([problem?.line, problem?.start, problem?.end]).toEqual([0, 0, 0]);
  });

  it('leaves out every finding that is not a broken reference', () => {
    expect(
      brokenProblems([{ kind: 'dead', asset: 'a.png', bytes: 1, inPublicDir: false }], textOf),
    ).toEqual([]);
  });
});
