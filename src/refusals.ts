/**
 * What the person reads when the CLI stops: its own message, word for word, then the next step
 * in the editor's terms where the message alone does not give one, and buttons that take it.
 * The reasons are the CLI's stable names for why it stopped, listed in its AGENTS.md.
 */

import type { ErrorLine } from './contract.js';
import { codeConfigRefusal } from './trust.js';

/** What the stopped command was doing. */
export type Doing = 'read' | 'plan' | 'apply' | 'undo' | 'init';

/** A button beside a refusal; the extension decides what each kind does where it is shown. */
export interface StepAction {
  readonly kind:
    | 'choose-public'
    | 'init'
    | 'retry'
    | 'scm'
    | 'undo-run'
    | 'plan-again'
    | 'trust'
    | 'open-config'
    | 'convert-config'
    | 'output';
  readonly title: string;
}

/** A refusal as the person reads it. */
export interface NextStep {
  /** The CLI's message, or for an untrusted folder's code config, the editor's own sentence. */
  readonly message: string;
  /** What to do next, in the editor's terms, or null when the message says it. */
  readonly next: string | null;
  readonly actions: readonly StepAction[];
}

const SCM: StepAction = { kind: 'scm', title: 'Open Source Control' };

/**
 * The message, next step and buttons for an error line.
 *
 * @param error the error line the CLI printed
 * @param doing what the command was doing, since a reason can mean different things to do
 */
export function nextStep(error: ErrorLine, doing: Doing): NextStep {
  const step = (next: string | null, actions: StepAction[] = []): NextStep => ({
    message: error.message,
    next,
    actions,
  });
  switch (error.reason) {
    case 'SERVING_ROOT_UNKNOWN':
      return step(
        'Choose the folder the site is served from for this plan, or write it into upfly.config.json with upfly init, which says why it chose each folder.',
        [
          { kind: 'choose-public', title: 'Choose the served folder' },
          { kind: 'init', title: 'Write upfly.config.json' },
        ],
      );
    case 'TRANSACTION_LOCKED':
      return step(
        'Another Upfly run is writing to this project, perhaps in a terminal. Try again once it has finished.',
        [{ kind: 'retry', title: 'Try again' }],
      );
    case 'UNCOMMITTED_CHANGES':
      return step(
        'Commit or stash your changes, then apply again. To convert some images over uncommitted changes, right-click them and choose Optimize, which makes no commit.',
        [SCM],
      );
    case 'NO_REPOSITORY':
      return step(
        'Optimize workspace commits the run, and git does not track this folder. Start a repository in Source Control, or select the images, right-click them and choose Optimize, which makes no commit.',
        [SCM],
      );
    case 'NO_GIT_IDENTITY':
      return step(
        'Set the name and email git commits with, git config user.name and git config user.email, then apply again.',
      );
    case 'GIT_OPERATION_IN_PROGRESS':
      return step('Finish or abort it in Source Control, then apply again.', [SCM]);
    case 'GIT_COMMIT_FAILED':
      return step('The run is written: commit its files yourself, or undo it in the review.', [
        SCM,
      ]);
    case 'TRANSACTION_INTERRUPTED':
      return step('Undo that run first: it puts back what the run wrote.', [
        { kind: 'undo-run', title: 'Undo the interrupted run' },
      ]);
    case 'TRANSACTION_FOREIGN_CHANGE':
      return doing === 'undo'
        ? step(
            "Undo your own edit to that file to undo the run there, or keep the run's change and accept it.",
          )
        : step('Plan again to plan from the files as they are now.', [
            { kind: 'plan-again', title: 'Plan again' },
          ]);
    case 'CODE_CONFIG_NOT_RUN':
      return {
        message: codeConfigRefusal(error) ?? error.message,
        next: null,
        actions: [{ kind: 'trust', title: 'Manage Workspace Trust' }],
      };
    case 'CONFIG_EXISTS':
      return step('Edit that file instead.', [{ kind: 'open-config', title: 'Open the config' }]);
    case 'V2_EXTENSION_CONFIG':
      return step("Convert it to Upfly 3's config, keeping a copy of the old file in .upfly.", [
        { kind: 'convert-config', title: 'Convert upfly.config.json' },
      ]);
    case 'NOT_IN_RUN':
      return step('The review is read again from the run, as it stands now.');
    default:
      return error.exitCode === 4
        ? step('The Upfly output has the details.', [{ kind: 'output', title: 'Show output' }])
        : step(null);
  }
}
