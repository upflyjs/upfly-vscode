/**
 * People who had the old Upfly extension. On the first start after the update they get one
 * notice, remembered in the extension's global state. The old settings are removed only when
 * the person asks, from every place they are set, and a project's old `upfly.config.json` is
 * converted into Upfly 3's only when the person asks, in a workspace VS Code trusts, with a
 * copy of the old file kept in `.upfly`. Nothing here acts on its own.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import type { AgentsPart } from './agents-ui.js';
import { convertOldConfig } from './convert-config.js';
import type { Host } from './host.js';
import { keepOldCopy, projectFolders } from './old-config-files.js';
import {
  CONVERTS_NEW_IMAGES,
  OLD_CONFIG_PROBLEM,
  OLD_SETTINGS,
  OLD_STATE_KEY,
  type SetSetting,
  convertedText,
  isUpdate,
  noticeText,
  removedText,
  whatsNew,
} from './old-users.js';
import { JSON_CONFIG_FILE, isOldExtensionConfig, readConfigText } from './project-config.js';

/** Where the extension remembers that the notice was shown. */
const NOTICE_KEY = 'upfly.updateNotice';
const SCHEME = 'upfly-update';
const WHATS_NEW = vscode.Uri.from({ scheme: SCHEME, path: "/What's new.md" });
const PROBLEM_CODE = 'old-extension-config';
const SHOW = "What's new";
const REMOVE = 'Remove the old settings';
/** How long a burst of file events waits before the old configs are looked for again. */
const SETTLE_MS = 300;

/** What the old users' part gives the rest of the extension: read by its tests. */
export interface OldUsersPart {
  /** Each notice shown, as its text. */
  notices(): readonly string[];
  /** Settles once the start's check for the notice is done. */
  noticeChecked(): Promise<void>;
  /**
   * Checks for the notice again, as the next start does. A test run needs it: VS Code keeps
   * no state between the starts of one.
   */
  checkNoticeAgain(): Promise<void>;
  /** The old settings set now, and where. */
  oldSettings(): readonly SetSetting[];
  /** The folders whose `upfly.config.json` is the old extension's, in a trusted workspace. */
  oldConfigs(): readonly string[];
}

/**
 * Registers the notice, the commands that remove the old settings and convert an old config,
 * and the Problems panel entry and quick fix for an old config.
 *
 * @param context the extension's context, whose global state remembers the notice
 * @param host the shared runner and log
 * @param agents the coding agents' part, told when a folder's config becomes Upfly 3's
 */
export function registerOldUsers(
  context: vscode.ExtensionContext,
  host: Host,
  agents: AgentsPart,
): OldUsersPart {
  const shown: string[] = [];
  const converted = new Map<string, string>();
  const documentChanged = new vscode.EventEmitter<vscode.Uri>();
  const lensesChanged = new vscode.EventEmitter<void>();
  const problems = vscode.languages.createDiagnosticCollection('upfly-old-config');
  let settle: NodeJS.Timeout | undefined;

  /** Looks again for old settings and configs, and updates every place that shows them. */
  function update(): void {
    problems.clear();
    const folders = oldConfigFolders();
    for (const folder of folders) {
      const uri = vscode.Uri.joinPath(folder.uri, JSON_CONFIG_FILE);
      const first = (readText(uri.fsPath) ?? '').split(/\r?\n/, 1)[0] ?? '';
      const problem = new vscode.Diagnostic(
        new vscode.Range(0, 0, 0, first.length),
        OLD_CONFIG_PROBLEM,
        vscode.DiagnosticSeverity.Warning,
      );
      problem.source = 'Upfly';
      problem.code = PROBLEM_CODE;
      problems.set(uri, [problem]);
    }
    void vscode.commands.executeCommand('setContext', 'upfly.oldConfig', folders.length > 0);
    void vscode.commands.executeCommand(
      'setContext',
      'upfly.oldSettings',
      oldSettings().length > 0,
    );
    documentChanged.fire(WHATS_NEW);
    lensesChanged.fire();
  }

  const later = (): void => {
    clearTimeout(settle);
    settle = setTimeout(update, SETTLE_MS);
  };

  async function checkNotice(): Promise<void> {
    if (context.globalState.get(NOTICE_KEY) !== undefined) return;
    const settings = oldSettings();
    const userSettings = settings.filter((setting) => setting.scope === 'user').length;
    const oldState = context.globalState.get(OLD_STATE_KEY) !== undefined;
    // A fresh install has nothing of the old extension, and sees nothing.
    if (!isUpdate({ userSettings, oldState })) return;
    await context.globalState.update(NOTICE_KEY, 1);
    const text = noticeText({
      convertsNewImages: CONVERTS_NEW_IMAGES,
      oldSettings: settings.length > 0,
    });
    shown.push(text);
    host.log.info(text);
    const buttons = [SHOW, ...(settings.length > 0 ? [REMOVE] : []), 'OK'];
    void vscode.window.showInformationMessage(text, ...buttons).then((choice) => {
      if (choice === SHOW) void showWhatsNew();
      else if (choice === REMOVE) void removeOldSettings();
    });
  }

  async function showWhatsNew(): Promise<void> {
    const document = await vscode.workspace.openTextDocument(WHATS_NEW);
    await vscode.window.showTextDocument(document, { preview: false });
  }

  async function removeOldSettings(): Promise<string> {
    const removed: SetSetting[] = [];
    const left: SetSetting[] = [];
    for (const setting of oldSettings()) {
      // A workspace's settings are files in the project, which nothing changes untrusted.
      if (setting.scope !== 'user' && !vscode.workspace.isTrusted) {
        left.push(setting);
        continue;
      }
      try {
        await configurationOf(setting).update(setting.key, undefined, targetOf(setting.scope));
        removed.push(setting);
      } catch (error) {
        left.push(setting);
        host.log.warn(
          `Could not remove ${setting.key}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const text = removedText(removed, left);
    host.log.info(text);
    void vscode.window.showInformationMessage(text);
    update();
    return text;
  }

  async function convert(target?: unknown): Promise<string | undefined> {
    if (!vscode.workspace.isTrusted) {
      host.refuse(
        {
          message:
            'This workspace is not trusted, so Upfly changes no file in it. Trust the workspace to convert its upfly.config.json.',
          next: null,
          actions: [{ kind: 'trust', title: 'Manage Workspace Trust' }],
        },
        () => void vscode.commands.executeCommand('workbench.trust.manage'),
      );
      return undefined;
    }
    const folder = await folderToConvert(target);
    if (folder === undefined) return undefined;
    const file = path.join(folder.uri.fsPath, JSON_CONFIG_FILE);
    let bytes: Buffer;
    try {
      bytes = readFileSync(file);
    } catch {
      void vscode.window.showInformationMessage(`${folder.name} has no upfly.config.json.`);
      return undefined;
    }
    const text = bytes.toString('utf8');
    const old = readConfigText(text);
    if (!isOldExtensionConfig(text) || typeof old !== 'object' || old === null) {
      void vscode.window.showInformationMessage(
        `The upfly.config.json in ${folder.name} is not the old extension's: Upfly 3 reads it as it is.`,
      );
      return undefined;
    }
    if (vscode.workspace.textDocuments.some((doc) => doc.isDirty && doc.uri.fsPath === file)) {
      host.refuse(
        {
          message: `upfly.config.json in ${folder.name} has changes not saved in the editor. Save or revert them first: Upfly converts the file on disk.`,
          next: null,
          actions: [],
        },
        () => undefined,
      );
      return undefined;
    }
    const conversion = convertOldConfig(
      old as Record<string, unknown>,
      projectFolders(folder.uri.fsPath),
    );
    // The copy first, so the old file is never lost.
    const copy = keepOldCopy(folder.uri.fsPath, bytes);
    writeFileSync(file, conversion.text);
    const report = convertedText(folder.name, copy, conversion);
    const uri = vscode.Uri.from({
      scheme: SCHEME,
      path: `/${folder.name}/upfly.config.json converted.md`,
      query: folder.uri.toString(),
    });
    converted.set(uri.toString(), report);
    documentChanged.fire(uri);
    host.log.info(`Converted ${file}; the old file is kept as ${copy}.`);
    update();
    agents.changed();
    host.refresh(folder);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {
      preview: false,
    });
    return report;
  }

  /** The folder a conversion was asked for, the only one with an old config, or a pick. */
  async function folderToConvert(target: unknown): Promise<vscode.WorkspaceFolder | undefined> {
    if (target instanceof vscode.Uri) return vscode.workspace.getWorkspaceFolder(target);
    const folders = oldConfigFolders();
    if (folders.length === 0) {
      void vscode.window.showInformationMessage(
        "No folder of this workspace holds the old extension's upfly.config.json.",
      );
      return undefined;
    }
    if (folders.length === 1) return folders[0];
    return (
      await vscode.window.showQuickPick(
        folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder })),
        { placeHolder: 'Convert the upfly.config.json of which folder?' },
      )
    )?.folder;
  }

  const lenses: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: lensesChanged.event,
    provideCodeLenses(document) {
      if (document.uri.toString() !== WHATS_NEW.toString()) return [];
      const top = new vscode.Range(0, 0, 0, 0);
      return [
        ...(oldSettings().length > 0
          ? [new vscode.CodeLens(top, { title: REMOVE, command: 'upfly.removeOldSettings' })]
          : []),
        ...oldConfigFolders().map(
          (folder) =>
            new vscode.CodeLens(top, {
              title: `Convert upfly.config.json in ${folder.name}`,
              command: 'upfly.convertOldConfig',
              arguments: [folder.uri],
            }),
        ),
      ];
    },
  };

  const quickFix: vscode.CodeActionProvider = {
    provideCodeActions(document) {
      const ours = (problems.get(document.uri) ?? []).filter(
        (problem) => problem.code === PROBLEM_CODE,
      );
      if (ours.length === 0) return [];
      const action = new vscode.CodeAction(
        "Convert to Upfly 3's config",
        vscode.CodeActionKind.QuickFix,
      );
      action.diagnostics = ours;
      action.isPreferred = true;
      action.command = {
        title: action.title,
        command: 'upfly.convertOldConfig',
        arguments: [document.uri],
      };
      return [action];
    },
  };

  const watcher = vscode.workspace.createFileSystemWatcher(`**/${JSON_CONFIG_FILE}`);
  context.subscriptions.push(
    problems,
    documentChanged,
    lensesChanged,
    watcher,
    watcher.onDidCreate(later),
    watcher.onDidChange(later),
    watcher.onDidDelete(later),
    vscode.workspace.onDidGrantWorkspaceTrust(update),
    vscode.workspace.onDidChangeWorkspaceFolders(update),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('upfly')) later();
    }),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
      onDidChange: documentChanged.event,
      provideTextDocumentContent: (uri) =>
        converted.get(uri.toString()) ??
        whatsNew({
          convertsNewImages: CONVERTS_NEW_IMAGES,
          settings: oldSettings(),
          oldConfigs: oldConfigFolders().map((folder) => folder.name),
        }),
    }),
    vscode.languages.registerCodeLensProvider({ scheme: SCHEME }, lenses),
    vscode.languages.registerCodeActionsProvider(
      { scheme: 'file', pattern: `**/${JSON_CONFIG_FILE}` },
      quickFix,
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
    vscode.commands.registerCommand('upfly.whatsNew', showWhatsNew),
    vscode.commands.registerCommand('upfly.removeOldSettings', removeOldSettings),
    vscode.commands.registerCommand('upfly.convertOldConfig', convert),
    { dispose: () => clearTimeout(settle) },
  );

  update();
  const check = (): Promise<void> =>
    checkNotice().catch((error: unknown) => {
      host.log.warn(
        `The notice for users of the old extension was not shown: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  let checked = check();

  return {
    notices: () => shown,
    noticeChecked: () => checked,
    checkNoticeAgain: () => {
      checked = check();
      return checked;
    },
    oldSettings,
    oldConfigs: () => oldConfigFolders().map((folder) => folder.uri.fsPath),
  };
}

/** Each old setting set now, in the person's settings, the workspace's, and each folder's. */
function oldSettings(): SetSetting[] {
  const found: SetSetting[] = [];
  const root = vscode.workspace.getConfiguration();
  for (const key of OLD_SETTINGS) {
    const values = root.inspect(key);
    if (values?.globalValue !== undefined) found.push({ key, scope: 'user' });
    if (values?.workspaceValue !== undefined) found.push({ key, scope: 'workspace' });
  }
  // A folder has settings of its own only in a workspace saved as a file; otherwise its
  // settings are the workspace's.
  if (vscode.workspace.workspaceFile === undefined) return found;
  for (const folder of fileFolders()) {
    const config = vscode.workspace.getConfiguration(undefined, folder.uri);
    for (const key of OLD_SETTINGS) {
      if (config.inspect(key)?.workspaceFolderValue !== undefined) {
        found.push({ key, scope: 'folder', folder: folder.name });
      }
    }
  }
  return found;
}

/** The folders whose `upfly.config.json` is the old extension's; none is read untrusted. */
function oldConfigFolders(): vscode.WorkspaceFolder[] {
  if (!vscode.workspace.isTrusted) return [];
  return fileFolders().filter((folder) => {
    const text = readText(path.join(folder.uri.fsPath, JSON_CONFIG_FILE));
    return text !== null && isOldExtensionConfig(text);
  });
}

function configurationOf(setting: SetSetting): vscode.WorkspaceConfiguration {
  const folder =
    setting.scope === 'folder'
      ? fileFolders().find((entry) => entry.name === setting.folder)
      : undefined;
  return vscode.workspace.getConfiguration(undefined, folder?.uri);
}

function targetOf(scope: SetSetting['scope']): vscode.ConfigurationTarget {
  switch (scope) {
    case 'user':
      return vscode.ConfigurationTarget.Global;
    case 'workspace':
      return vscode.ConfigurationTarget.Workspace;
    case 'folder':
      return vscode.ConfigurationTarget.WorkspaceFolder;
  }
}

/** The workspace folders on disk; a virtual folder has no files the CLI could read. */
function fileFolders(): readonly vscode.WorkspaceFolder[] {
  return (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'file');
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}
