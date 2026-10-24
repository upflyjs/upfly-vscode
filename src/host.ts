/**
 * What the parts of the extension that change files share with its entry point: running a
 * command through the one queue, the log, and asking for the views to be read again.
 */

import type * as vscode from 'vscode';
import type { CommandName } from './contract.js';
import type { NextStep } from './refusals.js';
import type { RunOutcome } from './runner.js';

/** How a command run ended, or why it never started. */
export type HostOutcome = RunOutcome | { readonly kind: 'unavailable'; readonly message: string };

/** How a command runs. */
export interface RunOptions {
  /** The status bar's words while it runs, after "Upfly:". */
  readonly label: string;
  /** The view whose progress bar shows while it runs. */
  readonly viewId?: string;
  /** Stops this run: before it starts, it never does; while it runs, its process ends. */
  readonly signal?: AbortSignal;
  /**
   * A command run first, in the same turn of the queue, so nothing can run between the two.
   * `accept` returns null to go on, or the reason not to, which the run ends with.
   */
  readonly check?: {
    readonly command: CommandName;
    readonly args: readonly string[];
    readonly accept: (outcome: HostOutcome) => string | null;
  };
}

/** What the entry point gives the plan and review parts. */
export interface Host {
  readonly log: vscode.LogOutputChannel;
  /**
   * Runs one command in one folder, after any run already queued, with progress in the status
   * bar. In a workspace VS Code does not trust, it is given `--no-code-config`.
   */
  run(
    folder: vscode.WorkspaceFolder,
    command: CommandName,
    args: readonly string[],
    options: RunOptions,
  ): Promise<HostOutcome>;
  /** The version of the CLI the extension carries, once it has been found. */
  cliVersion(): string;
  /** Audits a folder again soon, quietly, so the views and the Problems panel follow a write. */
  refresh(folder: vscode.WorkspaceFolder): void;
  /** Shows a refusal of something the person asked for, with its next step and buttons. */
  refuse(step: NextStep, act: (kind: NextStep['actions'][number]['kind']) => void): void;
}
