/**
 * The watcher for new images. VS Code's file events become the queue's bursts: a file created
 * through the editor (a paste or a drop in the Explorer, or another extension's edit) is a
 * paste, one only the file watcher reports came from outside. Each image is examined (watched,
 * convertible, done growing, new), batches run the CLI without undo, and what happened shows
 * in the status bar, the Problems panel and the Output channel. In a workspace VS Code does
 * not trust nothing is watched; watching starts once the workspace is trusted.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import type { ErrorLine, OptimizeResult, UndoResult } from './contract.js';
import { plural } from './format.js';
import type { Host } from './host.js';
import {
  type Git,
  gitIn,
  isRepository,
  repositoryAbove,
  restoredOriginals,
  sortByGit,
} from './new-images.js';
import { CODE_CONFIG_FILES, JSON_CONFIG_FILE } from './project-config.js';
import { type StepAction, nextStep } from './refusals.js';
import { codeConfigRefusal } from './trust.js';
import type { Kept, WaitingOriginal, WaitingOriginals } from './waiting.js';
import {
  type BatchReport,
  argumentGroups,
  batchArgs,
  convertedText,
  convertingLabel,
  keepsOriginals,
  questionText,
  refusalOf,
  reportOf,
} from './watch-batch.js';
import { type WatchSettings, skipEdit, watchSettings } from './watch-config.js';
import { commonFolder, isCandidate, isNeverWatched, isWatched } from './watch-paths.js';
import {
  type Batch,
  type BatchEnd,
  type BlockCause,
  type Heard,
  type Kind,
  type NewImage,
  NewImageQueue,
  untilText,
  waitUntilSteady,
} from './watch-queue.js';

/** What happened to one image the watcher heard, for the extension's tests. */
export interface Decision {
  /** The workspace folder's name. */
  readonly folder: string;
  readonly path: string;
  readonly outcome: string;
}

/** One automatic run's images, for the extension's tests. */
export interface WatchRun {
  readonly folder: string;
  readonly kind: Kind;
  readonly images: readonly string[];
}

/** What the watcher gives the rest of the extension: read by its tests. */
export interface WatchPart {
  /** Whether the watcher listens to file events, which it does only once the workspace is trusted. */
  started(): boolean;
  /** Settles once nothing heard is waiting, examined or converting. */
  idle(): Promise<void>;
  /** Each question asked about a burst so far, as its text. */
  questions(): readonly string[];
  /** Answers every later question this way instead of asking the person. */
  answerQuestions(answer: 'Convert' | 'Leave them' | undefined): void;
  /** The originals kept for coming from outside the editor, waiting to be removed. */
  waiting(): readonly WaitingOriginal[];
  /** What happened to each image heard so far, oldest first. */
  decisions(): readonly Decision[];
  /** The automatic runs so far. */
  runs(): readonly WatchRun[];
}

const CONVERT = 'Convert';
const LEAVE = 'Leave them';
/** How long file events about a batch's own writes are still ignored once its run ends. */
const GRACE_MS = 3_000;
/** How long an image moved or renamed in the Explorer is not taken for a new one. */
const RENAMED_MS = 3_000;
/** How deep and how wide a new folder is looked through for images. */
const WALK_DEPTH = 10;
const WALK_FILES = 5_000;
/** How many decisions the tests can read back. */
const KEPT_DECISIONS = 2_000;
const PROBLEM_SOURCE = 'Upfly';

/**
 * Registers the watcher: it starts at once in a trusted workspace, and when trust is granted
 * otherwise.
 *
 * @param context the extension's context
 * @param host the shared runner and log
 * @param waiting the originals kept for coming from outside the editor, waiting to be removed
 */
export function registerWatch(
  context: vscode.ExtensionContext,
  host: Host,
  waiting: WaitingOriginals,
): WatchPart {
  const problems = vscode.languages.createDiagnosticCollection('upfly-new-images');
  const decisions: Decision[] = [];
  const runs: WatchRun[] = [];
  const asked: string[] = [];
  let answer: { value: string | undefined } | null = null;
  /** Paths a batch named or wrote, ignored until the time given, by folder and path. */
  const ownWrites = new Map<string, number>();
  /** Paths moved or renamed in the Explorer, ignored until the time given. */
  const renamed = new Map<string, number>();
  /** Images whose conversion the person cancelled, never converted again by themselves. */
  const cancelled = new Set<string>();
  /** Where each folder's stop shows in the Problems panel. */
  const blockShown = new Map<string, vscode.Uri>();
  let started = false;

  const keyOf = (folder: vscode.WorkspaceFolder): string => {
    const named = fileFolders().filter((entry) => entry.name === folder.name);
    return named.length > 1 ? folder.uri.fsPath : folder.name;
  };
  const folderOf = (key: string): vscode.WorkspaceFolder | undefined =>
    fileFolders().find((folder) => keyOf(folder) === key);
  const settingsOf = (folder: vscode.WorkspaceFolder): WatchSettings => {
    const root = folder.uri.fsPath;
    return watchSettings({
      exists: (file) => existsSync(path.join(root, file)),
      read: (file) => readText(path.join(root, file)),
    });
  };
  const decide = (folder: vscode.WorkspaceFolder, image: string, outcome: string): void => {
    decisions.push({ folder: folder.name, path: image, outcome });
    if (decisions.length > KEPT_DECISIONS) decisions.shift();
    host.log.debug(`${folder.name}: ${image}: ${outcome}`);
  };
  const imageUri = (folder: vscode.WorkspaceFolder, image: string): vscode.Uri =>
    vscode.Uri.joinPath(folder.uri, ...image.split('/'));
  const writeKey = (folder: vscode.WorkspaceFolder, image: string): string =>
    `${folder.uri.fsPath}\0${image}`;

  /** Whether an event for this path is the watcher's own doing, or a move in the Explorer. */
  function ignored(folder: vscode.WorkspaceFolder, image: string): boolean {
    const now = Date.now();
    const key = writeKey(folder, image);
    const until = ownWrites.get(key);
    if (until !== undefined) {
      if (until > now) return true;
      ownWrites.delete(key);
    }
    if (cancelled.has(key)) return true;
    const absolute = path.join(folder.uri.fsPath, ...image.split('/'));
    for (const [moved, expiry] of renamed) {
      if (expiry <= now) renamed.delete(moved);
      else if (absolute === moved || absolute.startsWith(`${moved}${path.sep}`)) return true;
    }
    return false;
  }

  /** Takes a file or folder that appeared into the queue, each image under a folder too. */
  function hearUri(uri: vscode.Uri, kind: Kind): void {
    if (uri.scheme !== 'file') return;
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder === undefined) return;
    const relative = relativeTo(folder, uri.fsPath);
    if (relative === null || isNeverWatched(`${relative}/`)) return;
    if (looksConvertible(relative)) {
      hear(folder, relative, kind);
      return;
    }
    let directory = false;
    try {
      directory = statSync(uri.fsPath).isDirectory();
    } catch {
      return;
    }
    if (!directory) return;
    for (const file of imagesUnder(uri.fsPath)) {
      const inner = relativeTo(folder, file);
      if (inner !== null) hear(folder, inner, kind);
    }
  }

  function hear(folder: vscode.WorkspaceFolder, image: string, kind: Kind): void {
    if (isNeverWatched(image) || ignored(folder, image)) return;
    queue.hear({ folder: keyOf(folder), path: image, kind });
  }

  /** Which of a burst's images are new, with their sizes once they stopped growing. */
  async function examine(key: string, heard: readonly Heard[]): Promise<readonly NewImage[]> {
    const folder = folderOf(key);
    if (folder === undefined || !vscode.workspace.isTrusted) return [];
    const settings = settingsOf(folder);
    const kinds = new Map(heard.map((entry) => [entry.path, entry.kind]));
    const watched: string[] = [];
    for (const entry of heard) {
      if (!isWatched(entry.path, settings)) decide(folder, entry.path, 'not in a watched folder');
      else if (!isCandidate(entry.path, settings.format)) {
        decide(folder, entry.path, 'already in the format images convert to');
      } else watched.push(entry.path);
    }
    if (watched.length === 0) return [];
    const root = folder.uri.fsPath;
    const steadiness = await waitUntilSteady(
      watched,
      (image) => look(root, image),
      sleep,
      Date.now,
    );
    for (const image of steadiness.gone) decide(folder, image, 'gone before it stopped changing');
    for (const image of steadiness.growing) {
      decide(folder, image, 'still being written after a minute');
      host.log.info(
        `Not converted: ${image} in ${folder.name} was still being written after a minute, so it is left as it is.`,
      );
    }
    let fresh = await newOnes(folder, [...steadiness.steady.keys()]);
    fresh = await notPutBack(folder, fresh);
    if (fresh.length > 0) {
      host.log.info(`${plural(fresh.length, 'new image')} in ${folder.name}: ${fresh.join(', ')}`);
    }
    return fresh.map((image) => ({
      path: image,
      kind: kinds.get(image) ?? 'arrival',
      bytes: steadiness.steady.get(image) ?? null,
    }));
  }

  /** The images git does not know; in a folder without git, every one. */
  async function newOnes(folder: vscode.WorkspaceFolder, images: string[]): Promise<string[]> {
    if (images.length === 0) return [];
    const git: Git = gitIn(folder.uri.fsPath);
    const repository = await isRepository(git);
    if (repository === null && repositoryAbove(folder.uri.fsPath)) {
      for (const image of images) decide(folder, image, 'not converted: git could not be started');
      host.log.warn(
        `Not converted: the new images in ${folder.name}, since git could not be started, so Upfly cannot tell them from images git brought in.`,
      );
      return [];
    }
    if (repository !== true) return images;
    const sorted = await sortByGit(git, images);
    for (const image of sorted.ignored) decide(folder, image, 'ignored by git');
    for (const image of sorted.known) decide(folder, image, 'not new: git has it');
    return [...sorted.fresh];
  }

  /** Leaves out the originals `upfly undo` has just put back, which the person wants back. */
  async function notPutBack(folder: vscode.WorkspaceFolder, images: string[]): Promise<string[]> {
    if (images.length === 0) return images;
    if (!existsSync(path.join(folder.uri.fsPath, '.upfly', 'manifest.json'))) return images;
    const outcome = await host.run(folder, 'undo', ['--list'], {
      label: 'checking what undo put back',
      steadyLabel: true,
    });
    if (outcome.kind !== 'result') return images;
    const back = restoredOriginals((outcome.result as UndoResult).run);
    for (const image of images.filter((entry) => back.has(entry))) {
      decide(folder, image, 'put back by upfly undo');
    }
    return images.filter((image) => !back.has(image));
  }

  async function ask(key: string, images: readonly NewImage[]): Promise<boolean> {
    const folder = folderOf(key);
    if (folder === undefined) return false;
    const where = commonFolder(images.map((image) => image.path)) || folder.name;
    const text = questionText(images.length, where, settingsOf(folder).format);
    asked.push(text);
    host.log.info(text);
    const choice =
      answer === null
        ? await vscode.window.showInformationMessage(text, CONVERT, LEAVE)
        : answer.value;
    if (choice !== CONVERT) {
      for (const image of images) decide(folder, image.path, 'left as they are, as asked');
    }
    return choice === CONVERT;
  }

  /** Converts one batch, a CLI run for each group of images that fits a command line. */
  async function run(batch: Batch): Promise<BatchEnd> {
    const folder = folderOf(batch.folder);
    if (folder === undefined || !vscode.workspace.isTrusted) return { kind: 'done' };
    const named = batch.images.map((image) => image.path);
    for (const image of named) {
      ownWrites.set(writeKey(folder, image), Number.POSITIVE_INFINITY);
      problems.delete(imageUri(folder, image));
    }
    runs.push({ folder: folder.name, kind: batch.kind, images: named });
    const wrote = { any: false };
    try {
      const groups = argumentGroups(named);
      for (const [index, group] of groups.entries()) {
        const end = await runGroup(folder, batch, group, groups.slice(index).flat(), wrote);
        if (end !== null) return end;
      }
      return { kind: 'done' };
    } finally {
      // The file events of the run's own writes can arrive a moment after it ends.
      for (const image of named) ownWrites.set(writeKey(folder, image), Date.now() + GRACE_MS);
      if (wrote.any) host.refresh(folder);
    }
  }

  /**
   * Runs the CLI on one group of a batch's images.
   *
   * @returns null to go on with the next group, or how the batch ends
   */
  async function runGroup(
    folder: vscode.WorkspaceFolder,
    batch: Batch,
    group: readonly string[],
    left: readonly string[],
    wrote: { any: boolean },
  ): Promise<BatchEnd | null> {
    const settings = settingsOf(folder);
    const outcome = await host.run(
      folder,
      'optimize',
      batchArgs(group, keepsOriginals(batch.kind, settings)),
      {
        label: convertingLabel(group.length),
        steadyLabel: true,
        tooltip: 'Upfly is converting new images. Click to cancel.',
        // sharp encodes on libuv's thread pool, so two threads mean at most two images
        // encode at once: a decoded 4000x3000 photo alone holds about 48 MB.
        env: { UV_THREADPOOL_SIZE: '2' },
        lowPriority: true,
      },
    );
    switch (outcome.kind) {
      case 'result': {
        const result = outcome.result as OptimizeResult;
        const report = reportOf(group, batch.kind, settings, result);
        showConverted(folder, report, result, sizesOf(batch), settings.format);
        showLeft(folder, report);
        wrote.any ||= result.run !== null;
        return null;
      }
      case 'cancelled':
        for (const image of left) {
          cancelled.add(writeKey(folder, image));
          decide(folder, image, 'cancelled');
        }
        return { kind: 'cancelled' };
      case 'stopped':
        return refusalEnd(folder, batch, group, left, outcome.error);
      default:
        refused(folder, group, outcome.message);
        return null;
    }
  }

  /** What a refused group means: the batch tried again, the folder stopped, or the group refused. */
  function refusalEnd(
    folder: vscode.WorkspaceFolder,
    batch: Batch,
    group: readonly string[],
    left: readonly string[],
    error: ErrorLine,
  ): BatchEnd | null {
    const refusal = refusalOf(error, cutOff(folder));
    if (refusal === 'retry') {
      const again = new Set(left);
      return { kind: 'locked', left: batch.images.filter((image) => again.has(image.path)) };
    }
    if (refusal === 'refused') {
      refused(folder, group, error.message);
      return null;
    }
    return stop(folder, group, error, refusal === 'block-config' ? 'config' : 'record');
  }

  /** Says what a group converted, and records the originals that wait for their removal. */
  function showConverted(
    folder: vscode.WorkspaceFolder,
    report: BatchReport,
    result: OptimizeResult,
    sizes: ReadonlyMap<string, number | null>,
    format: WatchSettings['format'],
  ): void {
    for (const file of [...(result.run?.created ?? []), ...(result.run?.changed ?? [])]) {
      ownWrites.set(writeKey(folder, file), Date.now() + GRACE_MS);
    }
    for (const done of report.converted) {
      decide(folder, done.image, done.originalKept ? 'converted, original kept' : 'converted');
    }
    if (report.converted.length > 0) {
      const text = convertedText(report.converted, sizes, format);
      host.log.info(`${folder.name}: ${text}.`);
      vscode.window.setStatusBarMessage(`Upfly: ${text}`, 5_000);
    }
    if (report.waiting.length > 0) {
      const root = folder.uri.fsPath;
      void waiting.add(
        folder.uri.toString(),
        report.waiting.map((done): Kept => {
          // As the run left them, so a later edit of either can be told.
          const originalStamp = look(root, done.image);
          const convertedStamp = look(root, done.target);
          return {
            original: done.image,
            converted: done.target,
            ...(originalStamp === null ? {} : { originalStamp }),
            ...(convertedStamp === null ? {} : { convertedStamp }),
          };
        }),
      );
    }
  }

  /** Puts what a group left, and why, in the Problems panel and the log. */
  function showLeft(folder: vscode.WorkspaceFolder, report: BatchReport): void {
    for (const entry of report.declined) {
      problem(folder, entry.image, `Upfly did not convert this image: ${entry.reason}`, false);
      decide(folder, entry.image, `declined: ${entry.reason}`);
    }
    for (const entry of report.keptAnyway) {
      problem(folder, entry.image, sentence(`Upfly ${entry.reason}`), false);
    }
    for (const image of report.unmatched) {
      decide(folder, image, 'not taken by the CLI, as .upflyignore or its own rules leave it out');
    }
    for (const image of report.silent) decide(folder, image, 'not converted');
  }

  /** Stops a folder's conversions after a refusal every batch there would meet again. */
  function stop(
    folder: vscode.WorkspaceFolder,
    images: readonly string[],
    error: ErrorLine,
    until: BlockCause,
  ): BatchEnd {
    for (const image of images) decide(folder, image, `not converted: ${error.message}`);
    showStop(folder, error, until);
    return { kind: 'blocked', until, why: error.message };
  }

  function refused(folder: vscode.WorkspaceFolder, images: readonly string[], why: string): void {
    for (const image of images) {
      problem(folder, image, `Upfly did not convert this image: ${why}`, true);
      decide(folder, image, `not converted: ${why}`);
    }
  }

  function problem(folder: vscode.WorkspaceFolder, image: string, text: string, warn: boolean) {
    const entry = new vscode.Diagnostic(
      new vscode.Range(0, 0, 0, 0),
      text,
      warn ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information,
    );
    entry.source = PROBLEM_SOURCE;
    entry.code = 'new-image';
    problems.set(imageUri(folder, image), [entry]);
  }

  /** Shows, once, that a folder converts no new image until something changes there. */
  function showStop(folder: vscode.WorkspaceFolder, error: ErrorLine, until: BlockCause): void {
    const message = codeConfigRefusal(error) ?? error.message;
    const next = `Upfly converts no new image in ${folder.name} until ${untilText(until)}.`;
    const where = stopLocation(folder, error);
    const entry = new vscode.Diagnostic(
      new vscode.Range(0, 0, 0, 0),
      `${message} ${next}`,
      vscode.DiagnosticSeverity.Warning,
    );
    entry.source = PROBLEM_SOURCE;
    entry.code = 'new-images-stopped';
    problems.set(where, [entry]);
    blockShown.set(keyOf(folder), where);
    const actions = stopActions(nextStep(error, 'apply').actions, folder);
    host.refuse({ message, next, actions }, (kind) => void act(folder, kind));
  }

  /** The buttons that fit a stopped watcher: what a plan's own buttons do has no meaning here. */
  function stopActions(actions: readonly StepAction[], folder: vscode.WorkspaceFolder) {
    const hasJson = existsSync(path.join(folder.uri.fsPath, JSON_CONFIG_FILE));
    return actions
      .filter((action) => STOP_ACTIONS.has(action.kind))
      .map(
        (action): StepAction =>
          action.kind === 'init' && hasJson
            ? { kind: 'open-config', title: 'Open the config' }
            : action,
      );
  }

  async function act(folder: vscode.WorkspaceFolder, kind: StepAction['kind']): Promise<unknown> {
    switch (kind) {
      case 'init': {
        const outcome = await host.run(folder, 'init', [], { label: 'writing upfly.config.json' });
        if (outcome.kind === 'stopped') {
          host.refuse(nextStep(outcome.error, 'init'), (next) => void act(folder, next));
          return undefined;
        }
        return outcome.kind === 'result'
          ? vscode.window.showTextDocument(vscode.Uri.joinPath(folder.uri, JSON_CONFIG_FILE))
          : undefined;
      }
      case 'open-config': {
        const file = [JSON_CONFIG_FILE, ...CODE_CONFIG_FILES].find((name) =>
          existsSync(path.join(folder.uri.fsPath, name)),
        );
        return file === undefined
          ? undefined
          : vscode.window.showTextDocument(vscode.Uri.joinPath(folder.uri, file));
      }
      case 'convert-config':
        return vscode.commands.executeCommand('upfly.convertOldConfig', folder.uri);
      case 'trust':
        return vscode.commands.executeCommand('workbench.trust.manage');
      case 'undo-run':
        return vscode.commands.executeCommand('upfly.review.undoRun', folder.uri);
      case 'output':
        host.log.show();
        return undefined;
      default:
        return undefined;
    }
  }

  function unblock(uri: vscode.Uri, cause: BlockCause): void {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder === undefined) return;
    const key = keyOf(folder);
    if (!queue.unblock(key, cause)) return;
    const shown = blockShown.get(key);
    if (shown !== undefined) problems.delete(shown);
    blockShown.delete(key);
  }

  /**
   * Adds a folder chosen in the Explorer to `watch.skip` of its project's `upfly.config.json`,
   * so no new image there is converted. Returns what the person was told, for the tests.
   */
  async function stopWatching(target?: unknown): Promise<string | undefined> {
    if (!(target instanceof vscode.Uri) || target.scheme !== 'file' || !isFolder(target.fsPath)) {
      return tell('Right-click a folder in the Explorer and choose Stop watching this folder.');
    }
    const folder = vscode.workspace.getWorkspaceFolder(target);
    if (folder === undefined) {
      return say(
        `Upfly watches folders inside an open workspace folder only, and ${target.fsPath} is outside every one.`,
      );
    }
    if (!vscode.workspace.isTrusted) {
      host.refuse(
        {
          message:
            'This workspace is not trusted, so Upfly changes no file in it. Trust the workspace to stop watching a folder.',
          next: null,
          actions: [{ kind: 'trust', title: 'Manage Workspace Trust' }],
        },
        () => void vscode.commands.executeCommand('workbench.trust.manage'),
      );
      return undefined;
    }
    const relative = relativeTo(folder, target.fsPath) ?? '.';
    const shown = relative === '.' ? folder.name : relative;
    if (isNeverWatched(`${relative}/`)) {
      return tell(
        `Upfly never converts new images in ${shown}: no folder named .upfly, .git or node_modules is watched.`,
      );
    }
    const file = path.join(folder.uri.fsPath, JSON_CONFIG_FILE);
    if (vscode.workspace.textDocuments.some((doc) => doc.isDirty && doc.uri.fsPath === file)) {
      return say(
        `upfly.config.json in ${folder.name} has changes not saved in the editor. Save or revert them first: Upfly writes the file on disk.`,
      );
    }
    const edit = skipEdit(readText(file), settingsOf(folder), relative);
    if (edit.kind === 'refused') return say(edit.message);
    if (edit.kind === 'already') {
      return tell(
        `Upfly does not watch ${shown} for new images: watch.skip in upfly.config.json holds ${edit.by}.`,
      );
    }
    writeFileSync(file, edit.text);
    return tell(
      `Upfly no longer watches ${shown} for new images: it is in watch.skip in upfly.config.json.`,
    );
  }

  /** Tells the person something, and logs it. */
  function tell(text: string): string {
    host.log.info(text);
    void vscode.window.showInformationMessage(text);
    return text;
  }

  /** Refuses what the person asked for, with the reason. */
  function say(text: string): string {
    host.refuse({ message: text, next: null, actions: [] }, () => undefined);
    return text;
  }

  const queue = new NewImageQueue(
    { examine, ask, run, log: (text) => host.log.info(text) },
    {
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout),
    },
    Date.now,
  );

  function start(): void {
    if (started) return;
    started = true;
    const files = vscode.workspace.createFileSystemWatcher('**/*');
    const configs = vscode.workspace.createFileSystemWatcher(
      `**/{${[JSON_CONFIG_FILE, ...CODE_CONFIG_FILES].join(',')}}`,
    );
    const records = vscode.workspace.createFileSystemWatcher('**/.upfly/**/manifest.json');
    const onConfig = (uri: vscode.Uri): void => {
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      if (folder !== undefined && path.dirname(uri.fsPath) === folder.uri.fsPath) {
        unblock(uri, 'config');
      }
    };
    context.subscriptions.push(
      files,
      configs,
      records,
      files.onDidCreate((uri) => hearUri(uri, 'arrival')),
      files.onDidDelete((uri) => forget(uri)),
      vscode.workspace.onDidCreateFiles((event) => {
        for (const uri of event.files) hearUri(uri, 'paste');
      }),
      vscode.workspace.onDidRenameFiles((event) => {
        for (const { newUri } of event.files) renamed.set(newUri.fsPath, Date.now() + RENAMED_MS);
      }),
      configs.onDidCreate(onConfig),
      configs.onDidChange(onConfig),
      configs.onDidDelete(onConfig),
      records.onDidCreate((uri) => unblock(uri, 'record')),
      records.onDidChange((uri) => unblock(uri, 'record')),
      records.onDidDelete((uri) => unblock(uri, 'record')),
    );
    host.log.info('Upfly watches the workspace for new images.');
  }

  /** Drops the Problems entries of a file or folder that is gone. */
  function forget(uri: vscode.Uri): void {
    const gone = [...problems]
      .map(([entry]) => entry)
      .filter(
        (entry) =>
          entry.fsPath === uri.fsPath || entry.fsPath.startsWith(`${uri.fsPath}${path.sep}`),
      );
    for (const entry of gone) problems.delete(entry);
  }

  context.subscriptions.push(
    problems,
    { dispose: () => queue.dispose() },
    vscode.commands.registerCommand('upfly.stopWatching', stopWatching),
  );
  if (vscode.workspace.isTrusted) start();
  else context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(start));

  return {
    started: () => started,
    idle: async () => {
      while (queue.busy()) await sleep(100);
    },
    questions: () => asked,
    answerQuestions: (value) => {
      answer = { value };
    },
    waiting: () => waiting.all(),
    decisions: () => decisions,
    runs: () => runs,
  };
}

/** The buttons a stopped watcher offers, of those a refusal can carry. */
const STOP_ACTIONS = new Set<StepAction['kind']>([
  'init',
  'open-config',
  'convert-config',
  'trust',
  'undo-run',
  'output',
]);

/**
 * Whether a run made without undo stopped part way in the folder: every writing command puts it
 * back first, and refuses when a file it wrote changed since.
 */
function cutOff(folder: vscode.WorkspaceFolder): boolean {
  return existsSync(path.join(folder.uri.fsPath, '.upfly', 'no-undo', 'manifest.json'));
}

/** Where a folder's stop shows: the file the CLI named, its config, or the folder itself. */
function stopLocation(folder: vscode.WorkspaceFolder, error: ErrorLine): vscode.Uri {
  const file =
    error.file ??
    [JSON_CONFIG_FILE, ...CODE_CONFIG_FILES].find((name) =>
      existsSync(path.join(folder.uri.fsPath, name)),
    );
  return file === undefined ? folder.uri : vscode.Uri.joinPath(folder.uri, ...file.split('/'));
}

/** A path relative to the folder, with `/`, or null when it is outside it or is the folder. */
function relativeTo(folder: vscode.WorkspaceFolder, file: string): string | null {
  const relative = path.relative(folder.uri.fsPath, file);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

/** Whether a name ends like an image some project could convert, before its config is read. */
function looksConvertible(relative: string): boolean {
  return isCandidate(relative, 'webp') || isCandidate(relative, 'avif');
}

/** The images under a new folder, looked for only so deep and so wide. */
function imagesUnder(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > WALK_DEPTH) return;
    for (const entry of entriesOf(dir)) {
      if (found.length >= WALK_FILES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && !isNeverWatched(`${entry.name}/`)) walk(full, depth + 1);
      else if (entry.isFile() && looksConvertible(entry.name)) found.push(full);
    }
  };
  walk(root, 1);
  return found;
}

function entriesOf(dir: string): { name: string; isDirectory(): boolean; isFile(): boolean }[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Each image's size once it stopped growing. */
function sizesOf(batch: Batch): Map<string, number | null> {
  return new Map(batch.images.map((image) => [image.path, image.bytes]));
}

function isFolder(file: string): boolean {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}

function look(root: string, image: string): { size: number; mtimeMs: number } | null {
  try {
    const stats = statSync(path.join(root, ...image.split('/')));
    return stats.isFile() ? { size: stats.size, mtimeMs: stats.mtimeMs } : null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Text ending as a sentence does. */
function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** The workspace folders on disk; a virtual folder has no files the CLI could read. */
function fileFolders(): readonly vscode.WorkspaceFolder[] {
  return (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'file');
}
