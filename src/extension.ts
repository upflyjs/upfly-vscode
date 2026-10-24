/**
 * The extension's entry point: the commands, the two views, the report document and the
 * status bar. Every answer comes from the CLI the extension carries, run in a child process
 * through its JSON contract; nothing here reads a project itself.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import * as vscode from 'vscode';
import { type McpServer, registerAgents } from './agents-ui.js';
import { type TreeNode, auditNodes } from './audit-model.js';
import {
  type BundledCli,
  findBundledCli,
  projectCliVersion,
  versionNotice,
} from './bundled-cli.js';
import type { AuditResult, CommandName, ErrorLine, RefsResult } from './contract.js';
import type { Host } from './host.js';
import { openLocation } from './locations.js';
import { type NodeRuntime, chooseNode, nodeOnPath, versionOf } from './node-runtime.js';
import { type PlanOutcome, registerOptimize } from './optimize-ui.js';
import { brokenProblems } from './problems.js';
import { progressText } from './progress-text.js';
import { refsNodes } from './refs-model.js';
import { type ReviewPart, registerReview } from './review-ui.js';
import { type RunHandle, type RunOutcome, startRun } from './runner.js';
import { NodeTree, type ViewNode, viewNodes } from './tree.js';
import { codeConfigRefusal, trustArgs } from './trust.js';

const IMAGE_GLOB = '**/*.{avif,gif,jpeg,jpg,png,svg,tif,tiff,webp}';
const REPORT_SCHEME = 'upfly-report';
/** Every image with its references for the view, and the report in the CLI's own words. */
const AUDIT_ARGS = ['--include-images', '--include-text'];

/** One folder's last audit, as the views and the report show it. */
type FolderAudit =
  | {
      readonly kind: 'result';
      readonly result: AuditResult;
      readonly when: Date;
      readonly cliVersion: string;
      readonly notice: string | null;
    }
  | { readonly kind: 'message'; readonly text: string; readonly icon: string };

/** What a command run gives back: read by the extension's own tests, not a public API. */
export interface FolderOutcome {
  readonly folder: string;
  readonly kind: RunOutcome['kind'] | 'unavailable';
  readonly result?: AuditResult | RefsResult;
  /** The CLI's error line, when it stopped. */
  readonly error?: ErrorLine;
}

/** What the extension exports: read by its own tests, not a public API. */
export interface UpflyExports {
  /** The Node.js that runs the CLI, and the CLI's version, or why there is none. */
  engine(): Promise<{ node: NodeRuntime; cli: string } | { message: string }>;
  /** The audit view's rows, each with the rows under it. */
  auditRows(): readonly TreeNode[];
  /** The rows of "Where it is used", each with the rows under it. */
  refsRows(): readonly TreeNode[];
  /** Settles once the next run's process has started. */
  nextRunStarted(): Promise<void>;
  /** A folder's plan document and where it stands. */
  plan(folder: vscode.Uri): PlanOutcome | undefined;
  /** A folder's review, as last read from the CLI. */
  review(folder: vscode.Uri): ReturnType<ReviewPart['current']>;
  /** Every entry Upfly put in the Problems panel. */
  problems(): [vscode.Uri, readonly vscode.Diagnostic[]][];
  /** Each refusal shown to the person so far, as its text. */
  refusals(): readonly string[];
  /** Settles once no run is queued or running and no re-audit is waiting. */
  idle(): Promise<void>;
  /** The MCP servers the editor is given now. */
  mcpServers(): Promise<readonly McpServer[]>;
  /** The labels of the MCP servers the editor has started. */
  mcpStarted(): readonly string[];
}

/**
 * Called by VS Code the first time a command or a view of the extension is used.
 *
 * @param context the extension's context
 * @returns what the extension's tests read
 */
export function activate(context: vscode.ExtensionContext): UpflyExports {
  const log = vscode.window.createOutputChannel('Upfly', { log: true });
  const audits = new Map<string, FolderAudit>();
  const auditTree = new NodeTree();
  const refsTree = new NodeTree();
  const reportChanged = new vscode.EventEmitter<vscode.Uri>();
  const status = vscode.window.createStatusBarItem(
    'upfly.progress',
    vscode.StatusBarAlignment.Left,
    10,
  );
  status.name = 'Upfly';
  status.command = 'upfly.cancel';
  status.tooltip = 'Upfly is reading the project. Click to cancel.';

  let current: RunHandle | null = null;
  let cancelled = false;
  let queue: Promise<unknown> = Promise.resolve();
  let found: { node: NodeRuntime; cli: BundledCli } | null = null;
  const started: (() => void)[] = [];
  const problems = vscode.languages.createDiagnosticCollection('upfly');
  /** The folder a quiet re-audit is reading, which a run the person asks for stops. */
  let quietly: vscode.WorkspaceFolder | null = null;
  const refreshes = new Map<string, NodeJS.Timeout>();
  let active = 0;
  /** Jobs the person asked for that are queued and not started yet. */
  let waiting = 0;
  const refused: string[] = [];

  /** The Node.js and CLI to run, chosen once and kept, or the message saying what is missing. */
  async function engine(): Promise<{ node: NodeRuntime; cli: BundledCli } | { message: string }> {
    if (found !== null) return found;
    const cli = findBundledCli(context.extensionPath);
    if (cli === null) {
      return {
        message:
          'This copy of the Upfly extension is missing the CLI it carries. Reinstall the extension.',
      };
    }
    const { tooOld } = createRequire(cli.bin)(cli.bin) as {
      tooOld: (version: string) => string | null;
    };
    const choice = await chooseNode({
      editor: { execPath: process.execPath, version: process.versions.node },
      tooOld,
      onPath: () => nodeOnPath(process.env, process.platform),
      versionOf,
    });
    if (choice.kind === 'missing') return { message: choice.message };
    found = { node: choice.runtime, cli };
    log.info(
      choice.runtime.kind === 'editor'
        ? `upfly ${cli.version} runs on this editor's own Node.js ${choice.runtime.version}.`
        : `upfly ${cli.version} runs on the Node.js ${choice.runtime.version} at ${choice.runtime.execPath}, since this editor's own Node.js ${process.versions.node} is too old for it.`,
    );
    return found;
  }

  /**
   * Runs jobs one after another, so two commands never read the disk at once. A job the
   * person asked for stops a quiet re-audit that is running, which runs again after it.
   */
  function enqueue<T>(job: () => Promise<T>, quiet = false): Promise<T> {
    if (!quiet && quietly !== null) {
      const folder = quietly;
      current?.cancel();
      refresh(folder);
    }
    active += 1;
    if (!quiet) waiting += 1;
    const started = (): Promise<T> => {
      if (!quiet) waiting -= 1;
      return job();
    };
    const next = queue.then(started, started).finally(() => {
      active -= 1;
    });
    queue = next.catch(() => undefined);
    return next;
  }

  /** Audits a folder again once writes have settled, so the views follow what changed. */
  function refresh(folder: vscode.WorkspaceFolder): void {
    const key = folder.uri.toString();
    clearTimeout(refreshes.get(key));
    refreshes.set(
      key,
      setTimeout(() => {
        refreshes.delete(key);
        void enqueue(async () => {
          // A job the person asked for is waiting behind this one: it goes first.
          if (waiting > 0) {
            refresh(folder);
            return;
          }
          quietly = folder;
          try {
            await auditFolder(await engine(), folder, 'reading the folder again', true);
          } finally {
            quietly = null;
          }
        }, true);
      }, 1_500),
    );
  }

  /** One folder's audit, shown in the view, the report and the Problems panel. */
  async function auditFolder(
    chosen: { node: NodeRuntime; cli: BundledCli } | { message: string },
    folder: vscode.WorkspaceFolder,
    label: string,
    quiet: boolean,
  ): Promise<RunOutcome | { kind: 'unavailable'; message: string }> {
    const key = folder.uri.toString();
    if (!quiet) {
      audits.set(key, { kind: 'message', text: 'Auditing...', icon: 'sync~spin' });
      showAudits();
    }
    const outcome = await runIn(chosen, folder, 'audit', AUDIT_ARGS, 'upfly.audit', label);
    if (quiet && outcome.kind !== 'result') return outcome;
    audits.set(key, auditState(outcome, folder));
    if (outcome.kind === 'result') showProblems(folder, outcome.result as AuditResult);
    showAudits();
    reportChanged.fire(reportUri(folder));
    return outcome;
  }

  /** Replaces a folder's entries in the Problems panel with its audit's broken references. */
  function showProblems(folder: vscode.WorkspaceFolder, result: AuditResult): void {
    const stale = [...problems]
      .map(([uri]) => uri)
      .filter(
        (uri) => vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() === folder.uri.toString(),
      );
    for (const uri of stale) problems.delete(uri);
    const byFile = new Map<string, vscode.Diagnostic[]>();
    const textOf = (file: string): string | null => {
      try {
        return readFileSync(path.join(folder.uri.fsPath, file), 'utf8');
      } catch {
        return null;
      }
    };
    for (const problem of brokenProblems(result.report.findings, textOf)) {
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(problem.line, problem.start, problem.line, problem.end),
        problem.message,
        vscode.DiagnosticSeverity.Warning,
      );
      diagnostic.source = 'Upfly';
      diagnostic.code = 'broken-reference';
      byFile.set(problem.file, [...(byFile.get(problem.file) ?? []), diagnostic]);
    }
    for (const [file, list] of byFile) {
      problems.set(vscode.Uri.joinPath(folder.uri, ...file.split('/')), list);
    }
  }

  /** The engine for a command, or null after saying, once, what is missing. */
  async function engineOrSay(): Promise<
    { node: NodeRuntime; cli: BundledCli } | { message: string }
  > {
    const chosen = await engine();
    if ('message' in chosen) {
      log.error(chosen.message);
      void vscode.window.showErrorMessage(chosen.message);
    }
    return chosen;
  }

  /** Runs one command in one folder, with progress in the status bar and the view. */
  async function runIn(
    chosen: { node: NodeRuntime; cli: BundledCli } | { message: string },
    folder: vscode.WorkspaceFolder,
    command: CommandName,
    args: readonly string[],
    viewId: string | undefined,
    label: string,
    signal?: AbortSignal,
  ): Promise<RunOutcome | { kind: 'unavailable'; message: string }> {
    if ('message' in chosen) return { kind: 'unavailable', message: chosen.message };
    const all = [...args, ...trustArgs(vscode.workspace.isTrusted)];
    log.info(`upfly ${command} ${all.join(' ')} --json, in ${folder.uri.fsPath}`);
    status.text = `$(sync~spin) Upfly: ${label}`;
    status.show();
    await vscode.commands.executeCommand('setContext', 'upfly.running', true);
    try {
      const location = viewId === undefined ? vscode.ProgressLocation.Window : { viewId };
      return await vscode.window.withProgress({ location }, async () => {
        const handle = startRun(
          { node: chosen.node, cliBin: chosen.cli.bin },
          {
            command,
            args: all,
            cwd: folder.uri.fsPath,
            onProgress: (line) => {
              status.text = `$(sync~spin) Upfly: ${progressText(line)}`;
            },
            onDiagnostic: (line) =>
              log.info(`${line.relative ?? line.asset ?? ''}: ${line.detail}`),
            onStray: (line) => log.warn(`A line outside Upfly's JSON output: ${line}`),
          },
        );
        current = handle;
        if (signal?.aborted) handle.cancel();
        signal?.addEventListener('abort', () => handle.cancel(), { once: true });
        for (const resolve of started.splice(0)) resolve();
        const outcome = await handle.outcome;
        if (outcome.kind === 'crashed') {
          log.error(`${outcome.message}\n${outcome.detail}`);
          void vscode.window
            .showErrorMessage(`${outcome.message} The Upfly output has the details.`, 'Show output')
            .then((choice) => {
              if (choice === 'Show output') log.show();
            });
        }
        if (outcome.kind === 'stopped') log.warn(outcome.error.message);
        return outcome;
      });
    } finally {
      current = null;
      status.hide();
      await vscode.commands.executeCommand('setContext', 'upfly.running', false);
    }
  }

  function showAudits(): void {
    const folders = fileFolders();
    const rows = folders.map((folder) => {
      const audit = audits.get(folder.uri.toString());
      const rowsFor = audit === undefined ? [] : auditRowsFor(audit);
      return { folder, rows: rowsFor };
    });
    if (rows.length === 1) {
      const only = rows[0];
      auditTree.show(only === undefined ? [] : viewNodes(only.rows, only.folder.uri));
    } else {
      auditTree.show(
        rows
          .filter((entry) => audits.has(entry.folder.uri.toString()))
          .map((entry) => ({
            node: {
              label: entry.folder.name,
              description: entry.folder.uri.fsPath,
              icon: 'root-folder',
            },
            folder: entry.folder.uri,
            children: viewNodes(entry.rows, entry.folder.uri),
          })),
      );
    }
    void vscode.commands.executeCommand(
      'setContext',
      'upfly.hasAudit',
      [...audits.values()].some((audit) => audit.kind === 'result'),
    );
  }

  async function auditWorkspace(): Promise<FolderOutcome[]> {
    return enqueue(async () => {
      cancelled = false;
      const folders = fileFolders();
      if (folders.length === 0) {
        void vscode.window.showInformationMessage('Open a folder to audit its images.');
        return [];
      }
      const chosen = await engineOrSay();
      const outcomes: FolderOutcome[] = [];
      for (const [index, folder] of folders.entries()) {
        const key = folder.uri.toString();
        if (cancelled) {
          audits.set(key, {
            kind: 'message',
            text: 'Not audited: the run was cancelled.',
            icon: 'circle-slash',
          });
          outcomes.push({ folder: folder.uri.fsPath, kind: 'cancelled' });
          continue;
        }
        const label =
          folders.length > 1
            ? `auditing ${folder.name} (${index + 1} of ${folders.length})`
            : 'auditing';
        outcomes.push(folderOutcome(folder, await auditFolder(chosen, folder, label, false)));
      }
      return outcomes;
    });
  }

  function auditState(
    outcome: RunOutcome | { kind: 'unavailable'; message: string },
    folder: vscode.WorkspaceFolder,
  ): FolderAudit {
    switch (outcome.kind) {
      case 'result': {
        const cli = found?.cli.version ?? '';
        const notice = versionNotice(projectCliVersion(folder.uri.fsPath), cli);
        if (notice !== null) log.info(notice);
        return {
          kind: 'result',
          result: outcome.result as AuditResult,
          when: new Date(),
          cliVersion: cli,
          notice,
        };
      }
      case 'stopped': {
        const untrusted = codeConfigRefusal(outcome.error);
        return untrusted === null
          ? { kind: 'message', text: outcome.error.message, icon: 'warning' }
          : { kind: 'message', text: untrusted, icon: 'shield' };
      }
      case 'crashed':
        return { kind: 'message', text: outcome.message, icon: 'error' };
      case 'cancelled':
        return {
          kind: 'message',
          text: 'Not audited: the run was cancelled.',
          icon: 'circle-slash',
        };
      case 'unavailable':
        return {
          kind: 'message',
          text: outcome.message,
          icon: vscode.workspace.isTrusted ? 'error' : 'shield',
        };
    }
  }

  async function whereUsed(target?: unknown): Promise<FolderOutcome | undefined> {
    const image = await imageFor(target);
    if (image === undefined) return undefined;
    const folder = vscode.workspace.getWorkspaceFolder(image);
    if (folder === undefined) {
      void vscode.window.showInformationMessage(
        'Upfly reads images inside an open workspace folder only.',
      );
      return undefined;
    }
    return enqueue(async () => {
      cancelled = false;
      await vscode.commands.executeCommand('upfly.refs.focus');
      const relative = path.relative(folder.uri.fsPath, image.fsPath).split(path.sep).join('/');
      refsTree.show(
        viewNodes([{ label: `Searching for ${relative}...`, icon: 'sync~spin' }], null),
      );
      const chosen = await engineOrSay();
      const outcome = await runIn(
        chosen,
        folder,
        'refs',
        [relative],
        'upfly.refs',
        `searching for ${path.basename(relative)}`,
      );
      refsTree.show(viewNodes(refsRowsFor(outcome), folder.uri));
      return folderOutcome(folder, outcome);
    });
  }

  async function showReport(target?: unknown): Promise<void> {
    let audited = fileFolders().filter(
      (folder) => audits.get(folder.uri.toString())?.kind === 'result',
    );
    if (audited.length === 0) {
      await auditWorkspace();
      audited = fileFolders().filter(
        (folder) => audits.get(folder.uri.toString())?.kind === 'result',
      );
    }
    const named =
      target instanceof vscode.Uri
        ? audited.find((entry) => entry.uri.toString() === target.toString())
        : undefined;
    const folder =
      named !== undefined || audited.length <= 1
        ? (named ?? audited[0])
        : (
            await vscode.window.showQuickPick(
              audited.map((entry) => ({ label: entry.name, description: entry.uri.fsPath, entry })),
              { placeHolder: 'Which folder?' },
            )
          )?.entry;
    if (folder === undefined) return;
    const document = await vscode.workspace.openTextDocument(reportUri(folder));
    await vscode.window.showTextDocument(document, { preview: true });
  }

  const reports: vscode.TextDocumentContentProvider = {
    onDidChange: reportChanged.event,
    provideTextDocumentContent(uri) {
      const folder = fileFolders().find((entry) => entry.uri.toString() === uri.query);
      const audit = folder === undefined ? undefined : audits.get(folder.uri.toString());
      if (folder === undefined || audit?.kind !== 'result') {
        return 'Upfly audit\n\nThis folder has not been audited yet. Run Upfly: Audit workspace.\n';
      }
      return audit.result.text ?? 'Upfly audit\n\nThis audit carries no report text.\n';
    },
  };

  const host: Host = {
    log,
    run: (folder, command, args, options) =>
      enqueue(async () => {
        if (options.signal?.aborted) return { kind: 'cancelled' } as const;
        const chosen = await engineOrSay();
        const { check } = options;
        if (check !== undefined) {
          const checked = await runIn(
            chosen,
            folder,
            check.command,
            check.args,
            options.viewId,
            options.label,
            options.signal,
          );
          const reason = check.accept(checked);
          if (reason !== null) return { kind: 'unavailable', message: reason } as const;
        }
        return runIn(chosen, folder, command, args, options.viewId, options.label, options.signal);
      }),
    cliVersion: () => found?.cli.version ?? '',
    engine: async () => {
      const chosen = await engine();
      return 'message' in chosen ? chosen : { node: chosen.node };
    },
    refresh,
    refuse: (step, act) => {
      const text = step.next === null ? step.message : `${step.message} ${step.next}`;
      log.warn(text);
      refused.push(text);
      void vscode.window
        .showWarningMessage(text, ...step.actions.map((action) => action.title))
        .then((title) => {
          const action = step.actions.find((entry) => entry.title === title);
          if (action !== undefined) act(action.kind);
        });
    },
  };
  const review = registerReview(context, host);
  const planOf = registerOptimize(context, host, review);
  const agents = registerAgents(context, host);
  for (const folder of fileFolders()) {
    if (existsSync(path.join(folder.uri.fsPath, '.upfly', 'manifest.json'))) {
      void review.show(folder, false);
    }
  }

  context.subscriptions.push(
    problems,
    {
      dispose: () => {
        for (const timer of refreshes.values()) clearTimeout(timer);
      },
    },
    log,
    status,
    auditTree,
    refsTree,
    reportChanged,
    vscode.window.registerTreeDataProvider('upfly.audit', auditTree),
    vscode.window.registerTreeDataProvider('upfly.refs', refsTree),
    vscode.workspace.registerTextDocumentContentProvider(REPORT_SCHEME, reports),
    vscode.commands.registerCommand('upfly.auditWorkspace', auditWorkspace),
    vscode.commands.registerCommand('upfly.showReport', showReport),
    vscode.commands.registerCommand('upfly.whereUsed', whereUsed),
    vscode.commands.registerCommand('upfly.openLocation', openLocation),
    vscode.commands.registerCommand('upfly.cancel', () => {
      cancelled = true;
      current?.cancel();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      for (const [key, audit] of audits) {
        if (audit.kind === 'message' && audit.icon === 'shield') {
          audits.set(key, {
            kind: 'message',
            text: 'The workspace is trusted now. Run the audit again.',
            icon: 'info',
          });
        }
      }
      showAudits();
      for (const folder of fileFolders()) {
        if (existsSync(path.join(folder.uri.fsPath, '.upfly', 'manifest.json'))) {
          void review.show(folder, false);
        }
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => showAudits()),
  );

  return {
    engine: async () => {
      const chosen = await engine();
      return 'message' in chosen ? chosen : { node: chosen.node, cli: chosen.cli.version };
    },
    auditRows: () => plainRows(auditTree.current),
    refsRows: () => plainRows(refsTree.current),
    nextRunStarted: () =>
      new Promise<void>((resolve) => {
        started.push(resolve);
      }),
    plan: planOf,
    review: (folder) => review.current(folder),
    problems: () => [...problems],
    refusals: () => refused,
    idle: async () => {
      while (active > 0 || refreshes.size > 0) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
    mcpServers: () => agents.servers(),
    mcpStarted: () => agents.started(),
  };
}

/** Called by VS Code when the extension stops; everything is disposed through the context. */
export function deactivate(): void {}

/** What a command's run in one folder gives back to the extension's tests. */
function folderOutcome(
  folder: vscode.WorkspaceFolder,
  outcome: RunOutcome | { kind: 'unavailable'; message: string },
): FolderOutcome {
  return {
    folder: folder.uri.fsPath,
    kind: outcome.kind,
    ...(outcome.kind === 'result' ? { result: outcome.result as AuditResult | RefsResult } : {}),
    ...(outcome.kind === 'stopped' ? { error: outcome.error } : {}),
  };
}

/** The workspace folders on disk; a virtual folder has no files the CLI could read. */
function fileFolders(): readonly vscode.WorkspaceFolder[] {
  return (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'file');
}

function reportUri(folder: vscode.WorkspaceFolder): vscode.Uri {
  return vscode.Uri.from({
    scheme: REPORT_SCHEME,
    path: `/${folder.name}/Upfly audit.txt`,
    query: folder.uri.toString(),
  });
}

function auditRowsFor(audit: FolderAudit): TreeNode[] {
  if (audit.kind === 'message')
    return [{ label: audit.text, tooltip: audit.text, icon: audit.icon }];
  const notice: TreeNode[] =
    audit.notice === null ? [] : [{ label: audit.notice, tooltip: audit.notice, icon: 'info' }];
  return [...notice, ...auditNodes(audit.result)];
}

function refsRowsFor(outcome: RunOutcome | { kind: 'unavailable'; message: string }): TreeNode[] {
  switch (outcome.kind) {
    case 'result':
      return refsNodes(outcome.result as RefsResult);
    case 'stopped': {
      const text = codeConfigRefusal(outcome.error) ?? outcome.error.message;
      return [
        { label: text, tooltip: text, icon: text === outcome.error.message ? 'warning' : 'shield' },
      ];
    }
    case 'crashed':
      return [{ label: outcome.message, tooltip: outcome.detail, icon: 'error' }];
    case 'cancelled':
      return [{ label: 'The search was cancelled.', icon: 'circle-slash' }];
    case 'unavailable':
      return [{ label: outcome.message, tooltip: outcome.message, icon: 'shield' }];
  }
}

/** The image a command was run on: from the Explorer, a view's row, the open tab, or a pick. */
async function imageFor(target: unknown): Promise<vscode.Uri | undefined> {
  if (target instanceof vscode.Uri) return target;
  const row = target as ViewNode | undefined;
  if (row?.node?.image !== undefined && row.folder !== null) {
    return vscode.Uri.joinPath(row.folder, ...row.node.image.split('/'));
  }
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  const open =
    input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom
      ? input.uri
      : undefined;
  if (open !== undefined && /\.(avif|gif|jpe?g|png|svg|tiff?|webp)$/i.test(open.path)) return open;
  const images = await vscode.workspace.findFiles(IMAGE_GLOB, '**/node_modules/**', 5_000);
  const picked = await vscode.window.showQuickPick(
    images
      .map((uri) => ({ label: vscode.workspace.asRelativePath(uri), uri }))
      .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)),
    { placeHolder: 'Which image?', matchOnDescription: true },
  );
  return picked?.uri;
}

function plainRows(nodes: readonly ViewNode[]): TreeNode[] {
  return nodes.map((row) => ({ ...row.node, children: plainRows(row.children) }));
}
