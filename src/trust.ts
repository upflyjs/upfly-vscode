/**
 * What may run in a workspace VS Code does not trust. The CLI reads `upfly.config.json` as
 * data, but loads a `upfly.config.ts` or `.js` by running it, which is the project's own code.
 * So in an untrusted workspace every command is given `--no-code-config`, and the CLI itself
 * stops before reading a folder that holds such a config. Nothing that writes runs there.
 */

import type { ErrorLine } from './contract.js';

/**
 * The arguments every command gets in a workspace of this trust.
 *
 * @param trusted whether VS Code trusts the workspace
 */
export function trustArgs(trusted: boolean): string[] {
  return trusted ? [] : ['--no-code-config'];
}

/**
 * What to say when the CLI would not read a folder of an untrusted workspace because its
 * config is code, or null for any other stop. The CLI's own message names `--no-code-config`,
 * which the person never typed, so this says what that means in the editor.
 *
 * @param error the error line the CLI printed
 * @returns the sentence to show where the folder's answer would be, or null
 */
export function codeConfigRefusal(error: ErrorLine): string | null {
  if (error.reason !== 'CODE_CONFIG_NOT_RUN') return null;
  const file = /^(upfly\.config\.[a-z]+) is a config written as code/.exec(error.message)?.[1];
  return `This workspace is not trusted, and reading ${file ?? 'its config'} would run code from the project. Trust the workspace to let Upfly read this folder.`;
}

/** Why a command that changes files does nothing in a workspace VS Code does not trust. */
export const UNTRUSTED_WRITE =
  'This workspace is not trusted, so Upfly changes no file in it. Trust the workspace to convert images or undo a run.';
