/**
 * The review of the last run, in the code: each changed line highlighted, with the path it
 * had before beside it and Accept and Undo above it; Accept and Undo for the whole file at its
 * top, with a diff against the file before the run; and the same, with the whole run's, in the
 * Upfly view's Review list. Everything but the Accept marks is read from `upfly undo --list`
 * each time, so a run or an undo made in a terminal shows here too.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import type { UndoResult } from './contract.js';
import { plural } from './format.js';
import type { Host, HostOutcome } from './host.js';
import { nextStep } from './refusals.js';
import {
  type AcceptMarks,
  type Review,
  type ReviewFile,
  type ReviewLine,
  accept,
  beforeDocument,
  beforeText,
  reviewOf,
} from './review-model.js';
import { UNTRUSTED_WRITE } from './trust.js';

const MARKS_KEY = 'upfly.accepted';
const BEFORE_SCHEME = 'upfly-before';
/** How long a burst of file events waits before the review is read again. */
const SETTLE_MS = 700;

/** One folder's review: the run as last listed, or why it could not be read. */
interface FolderReview {
  readonly folder: vscode.WorkspaceFolder;
  run: UndoResult['run'] | undefined;
  review: Review | null;
  /** What the last action did, or why it was refused, in words. */
  last: string | null;
  error: string | null;
}

/** A row of the Review list. */
type ReviewItem =
  | { readonly kind: 'folder'; readonly entry: FolderReview }
  | { readonly kind: 'run'; readonly entry: FolderReview }
  | {
      readonly kind: 'note';
      readonly entry: FolderReview;
      readonly text: string;
      readonly icon: string;
    }
  | { readonly kind: 'file'; readonly entry: FolderReview; readonly file: ReviewFile }
  | { readonly kind: 'line'; readonly entry: FolderReview; readonly line: ReviewLine }
  | { readonly kind: 'originals'; readonly entry: FolderReview }
  | {
      readonly kind: 'original';
      readonly entry: FolderReview;
      readonly original: Review['originals'][number];
    };

/** What the review part gives the rest of the extension. */
export interface ReviewPart {
  show(folder: vscode.WorkspaceFolder, reveal: boolean): Promise<void>;
  /** The folder's review as last read, for the extension's tests. */
  current(
    folder: vscode.Uri,
  ): { review: Review | null; last: string | null; error: string | null } | undefined;
}

/**
 * Registers the review: its list, the lenses and highlights in the code, the diff, and the
 * Accept and Undo commands.
 *
 * @param context the extension's context, whose workspace state keeps the Accept marks
 * @param host the shared runner and log
 */
export function registerReview(context: vscode.ExtensionContext, host: Host): ReviewPart {
  const entries = new Map<string, FolderReview>();
  const treeChanged = new vscode.EventEmitter<ReviewItem | undefined>();
  const lensesChanged = new vscode.EventEmitter<void>();
  const beforeChanged = new vscode.EventEmitter<vscode.Uri>();
  const pending = new Map<string, NodeJS.Timeout>();
  const pendingDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  const changedDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.removedLineBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.warningForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });

  const marksOf = (folder: vscode.WorkspaceFolder): AcceptMarks | undefined =>
    context.workspaceState.get<Record<string, AcceptMarks>>(MARKS_KEY, {})[folder.uri.toString()];
  const saveMarks = async (folder: vscode.WorkspaceFolder, marks: AcceptMarks): Promise<void> => {
    const all = context.workspaceState.get<Record<string, AcceptMarks>>(MARKS_KEY, {});
    await context.workspaceState.update(MARKS_KEY, { ...all, [folder.uri.toString()]: marks });
  };
  const entryFor = (folder: vscode.WorkspaceFolder): FolderReview => {
    const key = folder.uri.toString();
    const found = entries.get(key);
    if (found !== undefined) return found;
    const made: FolderReview = { folder, run: undefined, review: null, last: null, error: null };
    entries.set(key, made);
    return made;
  };
  const changedUi = (): void => {
    treeChanged.fire(undefined);
    lensesChanged.fire();
    decorate();
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.scheme === BEFORE_SCHEME) beforeChanged.fire(editor.document.uri);
    }
    const open = [...entries.values()].some((entry) => entry.review?.open === true);
    void vscode.commands.executeCommand('setContext', 'upfly.reviewing', open);
  };

  /** Reads the folder's last run from the CLI and shows its review. */
  async function show(folder: vscode.WorkspaceFolder, reveal: boolean): Promise<void> {
    const entry = entryFor(folder);
    const outcome = await host.run(folder, 'undo', ['--list'], { label: 'reading the last run' });
    if (outcome.kind === 'result') {
      entry.run = (outcome.result as UndoResult).run ?? null;
      entry.review = reviewOf(entry.run, marksOf(folder));
      entry.error = null;
    } else {
      entry.error = describe(outcome, 'read');
    }
    changedUi();
    if (reveal && entry.review?.open === true) {
      await vscode.commands.executeCommand('upfly.review.focus');
    }
  }

  /** Reads a folder's review again once file events stop arriving. */
  function later(folder: vscode.WorkspaceFolder): void {
    const key = folder.uri.toString();
    clearTimeout(pending.get(key));
    pending.set(
      key,
      setTimeout(() => {
        pending.delete(key);
        void show(folder, false);
      }, SETTLE_MS),
    );
  }

  function describe(outcome: HostOutcome, doing: 'read' | 'undo'): string {
    if (outcome.kind === 'stopped') {
      const step = nextStep(outcome.error, doing);
      return step.next === null ? step.message : `${step.message} ${step.next}`;
    }
    if (outcome.kind === 'cancelled') return 'The run was cancelled.';
    return outcome.kind === 'result' ? '' : outcome.message;
  }

  /** The folder and review a command was given, from a lens's arguments or a list row. */
  function targetOf(
    args: unknown[],
  ): { entry: FolderReview; item?: ReviewItem; file?: string; line?: number | null } | undefined {
    const [first, file, line] = args;
    if (first instanceof vscode.Uri) {
      const entry = entries.get(first.toString());
      return entry === undefined
        ? undefined
        : {
            entry,
            ...(typeof file === 'string' ? { file } : {}),
            ...(typeof line === 'number' || line === null ? { line } : {}),
          };
    }
    const item = first as ReviewItem | undefined;
    if (item === undefined || !('entry' in item)) {
      const only = [...entries.values()].filter((entry) => entry.review?.open === true);
      return only.length === 1 && only[0] !== undefined ? { entry: only[0] } : undefined;
    }
    if (item.kind === 'file') return { entry: item.entry, item, file: item.file.path };
    if (item.kind === 'line')
      return { entry: item.entry, item, file: item.line.file, line: item.line.line };
    if (item.kind === 'original') return { entry: item.entry, item, file: item.original.path };
    return { entry: item.entry, item };
  }

  async function acceptKeys(
    entry: FolderReview,
    keys: string[],
    what: string,
  ): Promise<Review | null> {
    const review = entry.review;
    if (review === null) return null;
    const marks = accept(marksOf(entry.folder), review.runId, keys);
    await saveMarks(entry.folder, marks);
    entry.review = reviewOf(entry.run ?? null, marks);
    entry.last =
      entry.review?.open === false
        ? `${what}. The review is finished: every change is accepted or undone.`
        : `${what}.`;
    changedUi();
    return entry.review;
  }

  async function undo(
    entry: FolderReview,
    args: string[],
    what: string,
    files: readonly string[],
  ): Promise<{ kind: string; reason?: string } | undefined> {
    if (!vscode.workspace.isTrusted) {
      host.refuse(
        {
          message: UNTRUSTED_WRITE,
          next: null,
          actions: [{ kind: 'trust', title: 'Manage Workspace Trust' }],
        },
        () => {
          void vscode.commands.executeCommand('workbench.trust.manage');
        },
      );
      return { kind: 'unavailable' };
    }
    const dirty = vscode.workspace.textDocuments
      .filter(
        (document) =>
          document.isDirty &&
          files.some((file) => document.uri.fsPath === path.join(entry.folder.uri.fsPath, file)),
      )
      .map((document) => vscode.workspace.asRelativePath(document.uri, false));
    if (dirty.length > 0) {
      const message = `${dirty.join(', ')} ${dirty.length === 1 ? 'has' : 'have'} changes not saved in the editor. Save or revert them first: Upfly undoes the file on disk, and a saved edit after the run means the run cannot be undone there.`;
      host.refuse({ message, next: null, actions: [] }, () => undefined);
      return { kind: 'unsaved' };
    }
    const outcome = await host.run(entry.folder, 'undo', args, { label: what.toLowerCase() });
    if (outcome.kind === 'result') {
      const result = outcome.result as UndoResult;
      entry.last = undoneText(result, what);
      vscode.window.setStatusBarMessage(`Upfly: ${entry.last}`, 8_000);
    } else {
      entry.last = `${what} was refused. ${describe(outcome, 'undo')}`;
      if (outcome.kind === 'stopped') {
        host.refuse(nextStep(outcome.error, 'undo'), (kind) => {
          if (kind === 'trust') void vscode.commands.executeCommand('workbench.trust.manage');
          if (kind === 'output') host.log.show();
        });
      }
    }
    await show(entry.folder, false);
    host.refresh(entry.folder);
    return {
      kind: outcome.kind,
      ...(outcome.kind === 'stopped' && outcome.error.reason !== undefined
        ? { reason: outcome.error.reason }
        : {}),
    };
  }

  const fileLines = (entry: FolderReview, file: string): ReviewLine[] => [
    ...(entry.review?.files.find((candidate) => candidate.path === file)?.lines ?? []),
  ];

  const commands: Record<string, (...args: unknown[]) => unknown> = {
    'upfly.review.acceptLine': async (...args) => {
      const target = targetOf(args);
      if (target?.file === undefined || target.line === undefined) return undefined;
      const line = fileLines(target.entry, target.file).find(
        (candidate) => candidate.line === target.line,
      );
      if (line === undefined) return undefined;
      return acceptKeys(target.entry, [line.key], `Accepted line ${target.line} of ${target.file}`);
    },
    'upfly.review.acceptFile': async (...args) => {
      const target = targetOf(args);
      if (target?.file === undefined) return undefined;
      const keys = fileLines(target.entry, target.file)
        .filter((line) => line.state !== 'undone')
        .map((line) => line.key);
      return acceptKeys(target.entry, keys, `Accepted every change in ${target.file}`);
    },
    'upfly.review.acceptRun': async (...args) => {
      const target = targetOf(args);
      const review = target?.entry.review;
      if (target === undefined || review === null || review === undefined) return undefined;
      const keys = review.files
        .flatMap((file) => file.lines)
        .filter((line) => line.state !== 'undone')
        .map((line) => line.key);
      return acceptKeys(target.entry, keys, `Accepted every change of run ${review.runId}`);
    },
    'upfly.review.undoLine': async (...args) => {
      const target = targetOf(args);
      if (target?.file === undefined || target.line === undefined || target.line === null)
        return undefined;
      return undo(
        target.entry,
        ['--file', target.file, '--line', String(target.line)],
        `Undo of line ${target.line} of ${target.file}`,
        [target.file],
      );
    },
    'upfly.review.undoFile': async (...args) => {
      const target = targetOf(args);
      if (target?.file === undefined) return undefined;
      return undo(target.entry, ['--file', target.file], `Undo of ${target.file}`, [target.file]);
    },
    'upfly.review.bringBack': async (...args) => {
      const target = targetOf(args);
      if (target?.file === undefined) return undefined;
      return undo(target.entry, ['--file', target.file], `Bringing back ${target.file}`, []);
    },
    'upfly.review.undoRun': async (...args) => {
      const first = args[0];
      if (first instanceof vscode.Uri && !entries.has(first.toString())) {
        const folder = vscode.workspace.getWorkspaceFolder(first);
        if (folder !== undefined) await show(folder, false);
      }
      const target = targetOf(args);
      if (target === undefined) return undefined;
      const files = target.entry.review?.files.map((file) => file.path) ?? [];
      return undo(
        target.entry,
        [],
        `Undo of the whole run${target.entry.review === null ? '' : ` ${target.entry.review.runId}`}`,
        files,
      );
    },
    'upfly.review.compare': async (...args) => {
      const target = targetOf(args);
      if (target?.file === undefined) return undefined;
      const file = target.file;
      const before = vscode.Uri.from({
        scheme: BEFORE_SCHEME,
        path: `/${file}`,
        query: target.entry.folder.uri.toString(),
      });
      const now = vscode.Uri.joinPath(target.entry.folder.uri, ...file.split('/'));
      return vscode.commands.executeCommand(
        'vscode.diff',
        before,
        now,
        `${path.posix.basename(file)}: before Upfly's run, and now`,
      );
    },
    'upfly.review.open': async (...args) => {
      const target = targetOf(args);
      if (target?.file === undefined) return undefined;
      const uri = vscode.Uri.joinPath(target.entry.folder.uri, ...target.file.split('/'));
      const line = typeof target.line === 'number' ? target.line - 1 : 0;
      return vscode.window.showTextDocument(uri, {
        selection: new vscode.Range(line, 0, line, 0),
        preview: true,
      });
    },
    'upfly.review.show': async () => vscode.commands.executeCommand('upfly.review.focus'),
  };

  const tree: vscode.TreeDataProvider<ReviewItem> = {
    onDidChangeTreeData: treeChanged.event,
    getChildren(item) {
      const shown = [...entries.values()].filter(
        (entry) => entry.review?.open === true || entry.error !== null || entry.last !== null,
      );
      if (item === undefined) {
        if (shown.length === 1 && shown[0] !== undefined)
          return childrenOf({ kind: 'folder', entry: shown[0] });
        return shown.map((entry) => ({ kind: 'folder', entry }));
      }
      return childrenOf(item);
    },
    getTreeItem: treeItem,
  };

  function childrenOf(item: ReviewItem): ReviewItem[] {
    const { entry } = item;
    const review = entry.review;
    switch (item.kind) {
      case 'folder': {
        const rows: ReviewItem[] = [];
        if (entry.last !== null)
          rows.push({ kind: 'note', entry, text: entry.last, icon: 'history' });
        if (entry.error !== null)
          rows.push({ kind: 'note', entry, text: entry.error, icon: 'warning' });
        if (review?.open === true) rows.push({ kind: 'run', entry });
        return rows;
      }
      case 'run': {
        if (review === null) return [];
        const rows: ReviewItem[] = review.files.map((file) => ({ kind: 'file', entry, file }));
        if (review.originals.length > 0) rows.push({ kind: 'originals', entry });
        return rows;
      }
      case 'file':
        return item.file.lines.map((line) => ({ kind: 'line', entry, line }));
      case 'originals':
        return (review?.originals ?? []).map((original) => ({ kind: 'original', entry, original }));
      default:
        return [];
    }
  }

  function treeItem(item: ReviewItem): vscode.TreeItem {
    const { entry } = item;
    const review = entry.review;
    const folderUri = entry.folder.uri;
    switch (item.kind) {
      case 'folder': {
        const row = new vscode.TreeItem(
          entry.folder.name,
          vscode.TreeItemCollapsibleState.Expanded,
        );
        row.iconPath = new vscode.ThemeIcon('root-folder');
        return row;
      }
      case 'note': {
        const row = new vscode.TreeItem(item.text, vscode.TreeItemCollapsibleState.None);
        row.tooltip = item.text;
        row.iconPath = new vscode.ThemeIcon(item.icon);
        return row;
      }
      case 'run': {
        const row = new vscode.TreeItem(
          `Run ${review?.runId ?? ''}`,
          vscode.TreeItemCollapsibleState.Expanded,
        );
        row.description = review === null ? '' : runText(review);
        row.tooltip =
          review?.state === 'interrupted'
            ? 'This run stopped part way. Only undoing the whole run puts back what it wrote.'
            : 'Accept keeps a change; Undo puts it back as it was before the run, with the original it names. Accepting changes no file.';
        row.iconPath = new vscode.ThemeIcon('history');
        row.contextValue =
          review?.state === 'interrupted' ? 'upfly.reviewRun.interrupted' : 'upfly.reviewRun';
        return row;
      }
      case 'file': {
        const waiting = item.file.lines.filter(
          (line) => line.state === 'pending' || line.state === 'changed',
        ).length;
        const row = new vscode.TreeItem(
          item.file.path,
          waiting > 0
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.Collapsed,
        );
        row.resourceUri = vscode.Uri.joinPath(folderUri, ...item.file.path.split('/'));
        row.description = item.file.changedSince
          ? 'changed since the run: Undo is unavailable here'
          : waiting === 0
            ? 'every change accepted or undone'
            : `${plural(waiting, 'change')} to review`;
        row.tooltip = item.file.changedSince
          ? "Something other than the run changed this file since, so Upfly cannot undo its lines, or the whole run, until the file holds what the run left again. Accept keeps the run's changes."
          : undefined;
        row.command = {
          command: 'upfly.review.open',
          title: 'Open',
          arguments: [folderUri, item.file.path, null],
        };
        row.contextValue = item.file.changedSince
          ? 'upfly.reviewFile.changed'
          : waiting > 0
            ? 'upfly.reviewFile'
            : 'upfly.reviewFile.done';
        return row;
      }
      case 'line': {
        const { line } = item;
        const row = new vscode.TreeItem(
          line.line === null ? 'A line' : `Line ${line.line}`,
          vscode.TreeItemCollapsibleState.None,
        );
        row.description = `${pathsText(line)}${STATE_WORDS[line.state]}`;
        row.tooltip = lineTooltip(entry, line);
        row.iconPath = new vscode.ThemeIcon(STATE_ICONS[line.state]);
        row.command = {
          command: 'upfly.review.open',
          title: 'Open',
          arguments: [folderUri, line.file, line.line],
        };
        row.contextValue = `upfly.reviewLine.${line.state}`;
        return row;
      }
      case 'originals': {
        const back = review?.originals.filter((original) => original.back).length ?? 0;
        const row = new vscode.TreeItem(
          'Originals the run removed',
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        row.description = `${review?.originals.length ?? 0}, ${back} back`;
        row.tooltip =
          'Undoing a line brings back the originals it names. Bring back puts one back on its own, and leaves the converted image and the lines as they are.';
        row.iconPath = new vscode.ThemeIcon('file-media');
        return row;
      }
      case 'original': {
        const { original } = item;
        const row = new vscode.TreeItem(original.path, vscode.TreeItemCollapsibleState.None);
        row.description = original.back
          ? 'back'
          : original.changedSince
            ? 'another file is there now: cannot be brought back'
            : original.movedTo === null
              ? 'removed'
              : `moved to ${original.movedTo}`;
        row.iconPath = new vscode.ThemeIcon(original.back ? 'check' : 'trash');
        row.contextValue =
          !original.back && !original.changedSince
            ? 'upfly.reviewOriginal'
            : 'upfly.reviewOriginal.done';
        return row;
      }
    }
  }

  /** The review entry and line for a file in a folder under review, or undefined. */
  function reviewedFile(uri: vscode.Uri): { entry: FolderReview; file: ReviewFile } | undefined {
    if (uri.scheme !== 'file') return undefined;
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const entry = folder === undefined ? undefined : entries.get(folder.uri.toString());
    if (entry?.review?.open !== true || folder === undefined) return undefined;
    const relative = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/');
    const file = entry.review.files.find((candidate) => candidate.path === relative);
    return file === undefined ? undefined : { entry, file };
  }

  const lenses: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: lensesChanged.event,
    provideCodeLenses(document) {
      const found = reviewedFile(document.uri);
      if (found === undefined) return [];
      const { entry, file } = found;
      const folderUri = entry.folder.uri;
      const waiting = file.lines.filter(
        (line) => line.state === 'pending' || line.state === 'changed',
      );
      if (waiting.length === 0) return [];
      const top = new vscode.Range(0, 0, 0, 0);
      const lens = (range: vscode.Range, title: string, command: string, ...args: unknown[]) =>
        new vscode.CodeLens(range, { title, command, arguments: [folderUri, ...args] });
      const lensList: vscode.CodeLens[] = [
        new vscode.CodeLens(top, {
          title: file.changedSince
            ? `Upfly: ${plural(waiting.length, 'change')} from run ${entry.review?.runId}; this file changed since, so Undo is unavailable`
            : `Upfly: ${plural(waiting.length, 'change')} from run ${entry.review?.runId} to review`,
          command: 'upfly.review.show',
        }),
        lens(top, 'Accept file', 'upfly.review.acceptFile', file.path),
      ];
      if (!file.changedSince)
        lensList.push(lens(top, 'Undo file', 'upfly.review.undoFile', file.path));
      lensList.push(lens(top, 'Compare with before the run', 'upfly.review.compare', file.path));
      for (const line of waiting) {
        if (line.line === null || line.line > document.lineCount) continue;
        const range = new vscode.Range(line.line - 1, 0, line.line - 1, 0);
        lensList.push(lens(range, 'Accept', 'upfly.review.acceptLine', file.path, line.line));
        if (line.state === 'pending')
          lensList.push(lens(range, 'Undo', 'upfly.review.undoLine', file.path, line.line));
      }
      return lensList;
    },
  };

  function decorate(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const found = reviewedFile(editor.document.uri);
      const lines = found?.file.lines ?? [];
      const options = (state: 'pending' | 'changed'): vscode.DecorationOptions[] =>
        lines
          .filter(
            (line) =>
              line.state === state && line.line !== null && line.line <= editor.document.lineCount,
          )
          .map((line) => {
            const index = (line.line as number) - 1;
            return {
              range: editor.document.lineAt(index).range,
              hoverMessage: new vscode.MarkdownString().appendText(lineTooltip(found?.entry, line)),
              renderOptions: {
                after: {
                  contentText: `   was ${[...new Set(line.paths.map((entry) => entry.before))].join(', ')}`,
                  color: new vscode.ThemeColor('editorCodeLens.foreground'),
                  fontStyle: 'italic',
                },
              },
            };
          });
      editor.setDecorations(pendingDecoration, options('pending'));
      editor.setDecorations(changedDecoration, options('changed'));
    }
  }

  function lineTooltip(entry: FolderReview | undefined, line: ReviewLine): string {
    const now = entry === undefined ? null : lineNow(entry.folder, line);
    const before = now === null || line.state === 'undone' ? null : beforeText(now, line.paths);
    const words: Record<ReviewLine['state'], string> = {
      pending: 'Waiting for Accept or Undo.',
      accepted: 'Accepted.',
      undone: 'Undone: the line is as it was before the run.',
      changed: 'The file changed since the run, so Upfly cannot undo this line. Accept keeps it.',
    };
    return [
      words[line.state],
      ...(before === null ? [] : [`Before: ${before.trim()}`]),
      ...(now === null ? [] : [`Now: ${now.trim()}`]),
    ].join('\n');
  }

  const watcher = vscode.workspace.createFileSystemWatcher('**/.upfly/manifest.json');
  const onRecord = (uri: vscode.Uri): void => {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder !== undefined && path.dirname(path.dirname(uri.fsPath)) === folder.uri.fsPath)
      later(folder);
  };

  context.subscriptions.push(
    treeChanged,
    lensesChanged,
    beforeChanged,
    pendingDecoration,
    changedDecoration,
    watcher,
    watcher.onDidCreate(onRecord),
    watcher.onDidChange(onRecord),
    watcher.onDidDelete(onRecord),
    vscode.window.registerTreeDataProvider('upfly.review', tree),
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, lenses),
    vscode.workspace.registerTextDocumentContentProvider(BEFORE_SCHEME, {
      onDidChange: beforeChanged.event,
      provideTextDocumentContent(uri) {
        const entry = entries.get(uri.query);
        const file = uri.path.slice(1);
        const listed = entry?.run?.files.find((candidate) => candidate.path === file);
        if (entry === undefined || listed === undefined) return '';
        try {
          return beforeDocument(
            readFileSync(path.join(entry.folder.uri.fsPath, file), 'utf8'),
            listed,
          );
        } catch {
          return '';
        }
      },
    }),
    vscode.window.onDidChangeVisibleTextEditors(() => decorate()),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (reviewedFile(document.uri) !== undefined) {
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (folder !== undefined) later(folder);
      }
    }),
    ...Object.entries(commands).map(([name, run]) => vscode.commands.registerCommand(name, run)),
    {
      dispose: () => {
        for (const timer of pending.values()) clearTimeout(timer);
      },
    },
  );

  return {
    show,
    current: (folder) => {
      const entry = entries.get(folder.toString());
      return entry === undefined
        ? undefined
        : { review: entry.review, last: entry.last, error: entry.error };
    },
  };
}

const STATE_WORDS: Record<ReviewLine['state'], string> = {
  pending: '',
  accepted: '; accepted',
  undone: '; undone',
  changed: '; the file changed since',
};

const STATE_ICONS: Record<ReviewLine['state'], string> = {
  pending: 'diff-modified',
  accepted: 'check',
  undone: 'discard',
  changed: 'warning',
};

function pathsText(line: ReviewLine): string {
  return [...new Set(line.paths.map((entry) => `${entry.before} to ${entry.after ?? '?'}`))].join(
    ', ',
  );
}

function runText(review: Review): string {
  const when = new Date(review.startedAt).toLocaleString();
  if (review.state === 'interrupted')
    return `stopped part way, ${when}: only Undo all puts it back`;
  return `applied ${when}, ${plural(review.pending, 'change')} to review`;
}

function lineNow(folder: vscode.WorkspaceFolder, line: ReviewLine): string | null {
  if (line.line === null) return null;
  const open = vscode.workspace.textDocuments.find(
    (document) => document.uri.fsPath === path.join(folder.uri.fsPath, line.file),
  );
  try {
    const text = open?.getText() ?? readFileSync(path.join(folder.uri.fsPath, line.file), 'utf8');
    const value = text.split('\n')[line.line - 1];
    return value === undefined ? null : value.replace(/\r$/, '');
  } catch {
    return null;
  }
}

/** What an undo put back, in words, from its result. */
export function undoneText(result: UndoResult, what: string): string {
  const undone = result.undone;
  if (undone === null) return result.notes[0] ?? `${what}: there was nothing to undo.`;
  const back =
    undone.restored.length === 0
      ? ''
      : ` ${undone.restored.join(', ')} ${undone.restored.length === 1 ? 'is' : 'are'} back.`;
  const removed =
    undone.removed.length === 0 ? '' : ` Removed again: ${undone.removed.join(', ')}.`;
  const notes = result.notes.length === 0 ? '' : ` ${result.notes.join(' ')}`;
  return `${what.replace(/^Undo of/, 'Undid').replace(/^Bringing back/, 'Brought back')}.${back}${removed}${notes}`;
}
