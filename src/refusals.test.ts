import { describe, expect, it } from 'vitest';
import type { ErrorLine } from './contract.js';
import { nextStep } from './refusals.js';

const stop = (reason: string | undefined, message = 'The CLI said why.', exitCode: 2 | 3 | 4 = 3) =>
  ({
    type: 'error',
    command: 'optimize',
    exitCode,
    message,
    ...(reason === undefined ? {} : { reason }),
  }) as ErrorLine;

const kinds = (error: ErrorLine, during: Parameters<typeof nextStep>[1] = 'apply') =>
  nextStep(error, during).actions.map((action) => action.kind);

describe('nextStep', () => {
  it("keeps the CLI's own message, word for word", () => {
    expect(
      nextStep(stop('TRANSACTION_LOCKED', 'Another Upfly run is in progress.'), 'apply').message,
    ).toBe('Another Upfly run is in progress.');
  });

  it('offers to choose the served folder, or to write the config, when it is not known', () => {
    expect(kinds(stop('SERVING_ROOT_UNKNOWN'), 'plan')).toEqual(['choose-public', 'init']);
  });

  it('offers to try again while another run holds the project', () => {
    expect(kinds(stop('TRANSACTION_LOCKED'))).toEqual(['retry']);
  });

  it('says that right-click Optimize works over uncommitted changes, and opens Source Control', () => {
    const step = nextStep(stop('UNCOMMITTED_CHANGES'), 'apply');
    expect([step.next, step.actions.map((action) => action.kind)]).toEqual([
      'Commit or stash your changes, then apply again. To convert some images over uncommitted changes, right-click them and choose Optimize, which makes no commit.',
      ['scm'],
    ]);
  });

  it('never offers to apply anyway over uncommitted changes', () => {
    expect(kinds(stop('UNCOMMITTED_CHANGES'))).not.toContain('apply-anyway');
  });

  it('says the commit needs a repository, and that right-click Optimize makes none', () => {
    expect(nextStep(stop('NO_REPOSITORY'), 'apply').next).toContain(
      'right-click them and choose Optimize, which makes no commit',
    );
  });

  it('offers to undo an interrupted run first', () => {
    expect(kinds(stop('TRANSACTION_INTERRUPTED'))).toEqual(['undo-run']);
  });

  it('offers to plan again when a file changed after the plan read it', () => {
    expect(kinds(stop('TRANSACTION_FOREIGN_CHANGE'), 'apply')).toEqual(['plan-again']);
  });

  it('says how to undo again when a file changed since the run', () => {
    expect(nextStep(stop('TRANSACTION_FOREIGN_CHANGE'), 'undo').next).toBe(
      "Undo your own edit to that file to undo the run there, or keep the run's change and accept it.",
    );
  });

  it('offers to manage trust when the folder holds a code config', () => {
    expect(kinds(stop('CODE_CONFIG_NOT_RUN'), 'read')).toEqual(['trust']);
  });

  it('offers to open the config that is already there', () => {
    expect(kinds(stop('CONFIG_EXISTS'), 'init')).toEqual(['open-config']);
  });

  it('adds nothing where the message itself says what to do', () => {
    expect(nextStep(stop('IGNORED_BY_GIT'), 'apply')).toEqual({
      message: 'The CLI said why.',
      next: null,
      actions: [],
    });
  });

  it('offers the output for a failure nobody anticipated', () => {
    expect(kinds(stop(undefined, 'It broke.', 4))).toEqual(['output']);
  });
});
