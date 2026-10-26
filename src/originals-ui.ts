/**
 * The originals kept beside their converted image because they came from outside the editor,
 * and their removal: after a save whose text names a converted image, when a folder opens
 * (only those whose converted image a line uses), and when the person clicks the status bar's
 * count or runs the command (all of them). The CLI decides each removal, runs below normal
 * priority in the one queue every run shares, and makes no undo record. With a CLI that cannot
 * remove originals, the status bar only counts them.
 */

import { statSync } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { findBundledCli, removesOriginals } from './bundled-cli.js';
import type { OptimizeResult } from './contract.js';
import type { Host, HostOutcome } from './host.js';
import { type StepAction, nextStep } from './refusals.js';
import {
  type RemovalOutcome,
  clickedText,
  convertedNamedIn,
  notWaiting,
  originalNamedIn,
  removableOnOpen,
  removalArgs,
  removalOutcome,
  waitingLabel,
  waitingTooltip,
} from './removal.js';
import type { Stamp, WaitingOriginal, WaitingOriginals } from './waiting.js';
import { argumentGroups } from './watch-batch.js';

/** How a removal was asked for. */
export type Trigger = 'save' | 'open' | 'click';

/** One removal run, for the extension's tests. */
export interface RemovalRun {
  /** The workspace folder's name. */
  readonly folder: string;
  readonly trigger: Trigger;
  /** Whether the run wrote, or only planned. */
  readonly apply: boolean;
  readonly originals: readonly string[];
}

/** What the removal part gives the rest of the extension: read by its tests. */
export interface OriginalsPart {
  /** Whether the CLI the extension carries can remove kept originals. */
  canRemove(): boolean;
  /** Settles once no removal is waiting or running. */
  idle(): Promise<void>;
  /** The removal runs so far. */
  runs(): readonly RemovalRun[];
  /** What the status bar's count shows, or null while it is hidden. */
  statusBar(): {
    readonly text: string;
    readonly tooltip: string;
    readonly clickable: boolean;
  } | null;
}

/** How long saves settle before their removal runs, so Save All makes one run. */
const SETTLE_MS = 700;
const COMMAND = 'upfly.removeOriginals';

/**
 * Registers the count of kept originals, their removal and its command. Nothing runs until
 * the workspace is trusted.
 *
 * @param context the extension's context
 * @param host the shared runner and log
 * @param waiting the originals waiting to be removed
 */
export function registerOriginals(
  context: vscode.ExtensionContext,
  host: Host,
  waiting: WaitingOriginals,
): OriginalsPart {
  const cli = findBundledCli(context.extensionPath);
  const canRemove = cli !== null && removesOriginals(cli);
  const status = vscode.window.createStatusBarItem(
    'upfly.originals',
    vscode.StatusBarAlignment.Left,
    9,
  );
  status.name = 'Upfly originals kept';
  const runs: RemovalRun[] = [];
  /** The originals each folder's saves named, waiting for the saves to settle. */
  const saved = new Map<string, { originals: Set<string>; timer: NodeJS.Timeout }>();
  /**
   * Folders where an automatic removal was refused, with the reason: none runs there by itself
   * again until the person asks.
   */
  const held = new Map<string, string>();
  /** Folders a removal runs in, whose deletions its own answer accounts for. */
  const removing = new Set<string>();
  let busy = 0;
  let started = false;

  function showStatus(): void {
    const entries = fileFolders().flatMap((folder) =>
      waiting
        .inFolder(folder.uri.toString())
        .map((entry) => ({ ...entry, folderName: folder.name })),
    );
    void vscode.commands.executeCommand(
      'setContext',
      'upfly.originalsWaiting',
      started && canRemove && entries.length > 0,
    );
    if (!started || entries.length === 0) {
      status.hide();
      return;
    }
    const stopped = new Map(
      fileFolders()
        .filter((folder) => held.has(folder.uri.toString()))
        .map((folder) => [folder.name, held.get(folder.uri.toString()) ?? '']),
    );
    status.text = `$(files) Upfly: ${waitingLabel(entries.length)}`;
    status.tooltip = waitingTooltip(entries, canRemove, stopped);
    status.command = canRemove ? COMMAND : undefined;
    status.show();
  }

  /**
   * Removes the originals named, after taking off the list those no longer worth waiting
   * for. Opening a folder first plans, then removes only what a line's use of the converted
   * image confirms.
   */
  async function removeIn(
    folder: vscode.WorkspaceFolder,
    asked: readonly WaitingOriginal[],
    trigger: Trigger,
  ): Promise<RemovalOutcome | null> {
    const key = folder.uri.toString();
    busy += 1;
    removing.add(key);
    try {
      const look = lookIn(folder);
      const live = await dropStale(folder, asked, look);
      if (live.length === 0) return null;
      let chosen = live;
      if (trigger === 'open') {
        const planned = await runGroups(folder, live, false, trigger);
        if (planned === null) return null;
        const removable = new Set(planned.flatMap(({ result }) => removableOnOpen(result)));
        await record(
          folder,
          sum(planned.map(({ group, result }) => removalOutcome(group, result, look))),
        );
        chosen = live.filter((entry) => removable.has(entry.original));
        if (chosen.length === 0) return null;
      }
      const applied = await runGroups(folder, chosen, true, trigger);
      if (applied === null) return null;
      const outcome = sum(applied.map(({ group, result }) => removalOutcome(group, result, look)));
      await record(folder, outcome);
      if (outcome.removed.length > 0 || trigger === 'save') host.refresh(folder);
      return outcome;
    } finally {
      busy -= 1;
      removing.delete(key);
    }
  }

  /** Takes off the list each original gone or changed since its conversion, saying why. */
  async function dropStale(
    folder: vscode.WorkspaceFolder,
    asked: readonly WaitingOriginal[],
    look: (relative: string) => Stamp | null,
  ): Promise<WaitingOriginal[]> {
    const stale = asked.flatMap((entry) => {
      const why = notWaiting(entry, look);
      return why === null ? [] : [{ original: entry.original, why }];
    });
    if (stale.length > 0) {
      for (const entry of stale) {
        host.log.info(
          `${folder.name}: ${entry.original} no longer waits to be removed: ${entry.why}.`,
        );
      }
      await waiting.remove(
        folder.uri.toString(),
        stale.map((entry) => entry.original),
      );
    }
    const gone = new Set(stale.map((entry) => entry.original));
    return asked.filter((entry) => !gone.has(entry.original));
  }

  /**
   * Runs the CLI on the originals, one run for each group that fits a command line.
   *
   * @returns each group with its result, or null when a run did not give one
   */
  async function runGroups(
    folder: vscode.WorkspaceFolder,
    entries: readonly WaitingOriginal[],
    apply: boolean,
    trigger: Trigger,
  ): Promise<{ group: WaitingOriginal[]; result: OptimizeResult }[] | null> {
    const byOriginal = new Map(entries.map((entry) => [entry.original, entry]));
    const done: { group: WaitingOriginal[]; result: OptimizeResult }[] = [];
    for (const names of argumentGroups(entries.map((entry) => entry.original))) {
      runs.push({ folder: folder.name, trigger, apply, originals: names });
      const outcome = await host.run(folder, 'optimize', removalArgs(names, apply), {
        label: apply
          ? `removing ${names.length === 1 ? 'an original' : `${names.length} originals`} kept`
          : 'checking the originals kept',
        steadyLabel: true,
        tooltip: 'Upfly is checking the originals kept beside converted images. Click to cancel.',
        // Reading the images' headers runs on libuv's thread pool, as encoding does.
        env: { UV_THREADPOOL_SIZE: '2' },
        lowPriority: true,
      });
      if (outcome.kind !== 'result') {
        stopped(folder, outcome, trigger);
        return null;
      }
      done.push({
        group: names.flatMap((name) => byOriginal.get(name) ?? []),
        result: outcome.result as OptimizeResult,
      });
    }
    return done;
  }

  /** Says why a run gave no result: to the person who clicked, otherwise in the log. */
  function stopped(
    folder: vscode.WorkspaceFolder,
    outcome: Exclude<HostOutcome, { kind: 'result' }>,
    trigger: Trigger,
  ): void {
    const key = folder.uri.toString();
    if (outcome.kind === 'cancelled') {
      host.log.info(`${folder.name}: removing the originals kept was cancelled.`);
      return;
    }
    const message = outcome.kind === 'stopped' ? outcome.error.message : outcome.message;
    if (trigger === 'click' && outcome.kind === 'stopped') {
      const step = nextStep(outcome.error, 'apply');
      host.refuse(
        { ...step, actions: step.actions.filter((action) => CLICK_ACTIONS.has(action.kind)) },
        (kind) => void act(folder, kind),
      );
      return;
    }
    host.log.warn(`${folder.name}: the originals kept were not removed: ${message}`);
    // Another run holding the project ends soon; the next save or start tries again.
    const locked = outcome.kind === 'stopped' && outcome.error.reason === 'TRANSACTION_LOCKED';
    if (trigger !== 'click' && !locked) {
      held.set(key, message);
      showStatus();
    }
  }

  async function act(folder: vscode.WorkspaceFolder, kind: StepAction['kind']): Promise<unknown> {
    switch (kind) {
      case 'retry':
        return removeAll(folder.uri);
      case 'trust':
        return vscode.commands.executeCommand('workbench.trust.manage');
      case 'convert-config':
        return vscode.commands.executeCommand('upfly.convertOldConfig', folder.uri);
      case 'undo-run':
        return vscode.commands.executeCommand('upfly.review.undoRun', folder.uri);
      case 'output':
        host.log.show();
        return undefined;
      default:
        return undefined;
    }
  }

  /** Writes down what a run's answer means: removed and dropped off the list, reasons kept. */
  async function record(folder: vscode.WorkspaceFolder, outcome: RemovalOutcome): Promise<void> {
    const key = folder.uri.toString();
    for (const original of outcome.removed) {
      host.log.info(
        `${folder.name}: removed ${original}, kept beside its converted image until now.`,
      );
    }
    for (const entry of outcome.dropped) {
      host.log.info(
        `${folder.name}: ${entry.original} no longer waits to be removed: ${entry.why}.`,
      );
    }
    for (const entry of outcome.staying) {
      if (entry.reason !== null) {
        host.log.info(`${folder.name}: ${entry.original} stays: ${entry.reason}.`);
      }
    }
    await waiting.remove(key, [
      ...outcome.removed,
      ...outcome.dropped.map((entry) => entry.original),
    ]);
    await waiting.note(key, [
      ...outcome.staying,
      ...outcome.removable.map((original) => ({ original, reason: null })),
    ]);
  }

  /** Every original waiting in the folder named, or in each folder: the person decided. */
  async function removeAll(target?: unknown): Promise<RemovalOutcome | undefined> {
    if (!canRemove) {
      void vscode.window.showInformationMessage(
        'Removing the originals kept beside converted images comes with a later version of Upfly.',
      );
      return undefined;
    }
    if (!vscode.workspace.isTrusted) {
      host.refuse(
        {
          message:
            'This workspace is not trusted, so Upfly changes no file in it. Trust the workspace to remove the originals kept.',
          next: null,
          actions: [{ kind: 'trust', title: 'Manage Workspace Trust' }],
        },
        () => void vscode.commands.executeCommand('workbench.trust.manage'),
      );
      return undefined;
    }
    const named =
      target instanceof vscode.Uri ? vscode.workspace.getWorkspaceFolder(target) : undefined;
    if (target instanceof vscode.Uri && named === undefined) return undefined;
    const folders = named === undefined ? fileFolders() : [named];
    const outcomes: RemovalOutcome[] = [];
    for (const folder of folders) {
      const entries = waiting.inFolder(folder.uri.toString());
      if (entries.length === 0) continue;
      held.delete(folder.uri.toString());
      const outcome = await removeIn(folder, entries, 'click');
      if (outcome !== null) outcomes.push(outcome);
    }
    showStatus();
    const total = sum(outcomes);
    const text = clickedText(total);
    host.log.info(text);
    vscode.window.setStatusBarMessage(`Upfly: ${text}`, 8_000);
    return total;
  }

  /** Collects the originals a save named; once saves settle, one run per folder removes them. */
  function heard(document: vscode.TextDocument): void {
    if (!started || document.uri.scheme !== 'file') return;
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (folder === undefined) return;
    const key = folder.uri.toString();
    const entries = waiting.inFolder(key);
    if (entries.length === 0) return;
    const text = document.getText();
    const named = canRemove && !held.has(key) ? convertedNamedIn(text, entries) : [];
    if (named.length === 0) {
      // A line naming a kept original gets its hint from the folder's next audit.
      if (originalNamedIn(text, entries)) host.refresh(folder);
      return;
    }
    const pending = saved.get(key);
    if (pending !== undefined) clearTimeout(pending.timer);
    const originals = new Set([
      ...(pending?.originals ?? []),
      ...named.map((entry) => entry.original),
    ]);
    const timer = setTimeout(() => {
      saved.delete(key);
      const current = waiting.inFolder(key).filter((entry) => originals.has(entry.original));
      if (current.length > 0) void removeIn(folder, current, 'save');
    }, SETTLE_MS);
    saved.set(key, { originals, timer });
  }

  /**
   * Removes, in each folder opened, the originals whose converted image a line uses. Those gone
   * or changed since leave the list even when the CLI cannot remove originals.
   */
  function opened(folders: readonly vscode.WorkspaceFolder[]): void {
    if (!started) return;
    for (const folder of folders) {
      if (folder.uri.scheme !== 'file') continue;
      const key = folder.uri.toString();
      const entries = waiting.inFolder(key);
      if (entries.length === 0) continue;
      if (canRemove && !held.has(key)) void removeIn(folder, entries, 'open');
      else void counted(dropStale(folder, entries, lookIn(folder)));
    }
  }

  /** Takes off the list the originals whose file, or converted image, was deleted. */
  function deleted(uri: vscode.Uri): void {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!started || folder === undefined || removing.has(folder.uri.toString())) return;
    const relative = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/');
    const under = (file: string) => file === relative || file.startsWith(`${relative}/`);
    const touched = waiting
      .inFolder(folder.uri.toString())
      .filter((entry) => under(entry.original) || under(entry.converted));
    if (touched.length > 0) void counted(dropStale(folder, touched, lookIn(folder)));
  }

  /** Counts a piece of work as busy until it settles, for the tests' idle. */
  async function counted<T>(work: Promise<T>): Promise<T> {
    busy += 1;
    try {
      return await work;
    } finally {
      busy -= 1;
    }
  }

  function start(): void {
    if (started) return;
    started = true;
    showStatus();
    opened(fileFolders());
  }

  const files = vscode.workspace.createFileSystemWatcher('**/*', true, true, false);
  context.subscriptions.push(
    status,
    files,
    files.onDidDelete(deleted),
    waiting.onChange(showStatus),
    vscode.commands.registerCommand(COMMAND, removeAll),
    vscode.workspace.onDidSaveTextDocument(heard),
    vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      showStatus();
      opened(event.added);
    }),
    {
      dispose: () => {
        for (const pending of saved.values()) clearTimeout(pending.timer);
      },
    },
  );
  void vscode.commands.executeCommand('setContext', 'upfly.canRemoveOriginals', canRemove);
  if (vscode.workspace.isTrusted) start();
  else context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(start));

  return {
    canRemove: () => canRemove,
    idle: async () => {
      while (busy > 0 || saved.size > 0) await new Promise((resolve) => setTimeout(resolve, 100));
    },
    runs: () => runs,
    statusBar: () =>
      started && status.text !== '' && waitingCount() > 0
        ? {
            text: status.text,
            tooltip: typeof status.tooltip === 'string' ? status.tooltip : '',
            clickable: status.command !== undefined,
          }
        : null,
  };

  function waitingCount(): number {
    return fileFolders().reduce(
      (count, folder) => count + waiting.inFolder(folder.uri.toString()).length,
      0,
    );
  }
}

/** The buttons a refused removal offers, of those a refusal can carry. */
const CLICK_ACTIONS = new Set<StepAction['kind']>([
  'retry',
  'trust',
  'convert-config',
  'undo-run',
  'output',
]);

/** Adds up the outcomes of several runs. */
function sum(outcomes: readonly RemovalOutcome[]): RemovalOutcome {
  return {
    removed: outcomes.flatMap((outcome) => outcome.removed),
    dropped: outcomes.flatMap((outcome) => outcome.dropped),
    staying: outcomes.flatMap((outcome) => outcome.staying),
    removable: outcomes.flatMap((outcome) => outcome.removable),
  };
}

/** A file's size and time in a folder, relative to it, or null when it is not a file there. */
function lookIn(folder: vscode.WorkspaceFolder): (relative: string) => Stamp | null {
  return (relative) => {
    try {
      const stats = statSync(path.join(folder.uri.fsPath, ...relative.split('/')));
      return stats.isFile() ? { size: stats.size, mtimeMs: stats.mtimeMs } : null;
    } catch {
      return null;
    }
  };
}

/** The workspace folders on disk; a virtual folder has no files the CLI could read. */
function fileFolders(): readonly vscode.WorkspaceFolder[] {
  return (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'file');
}
