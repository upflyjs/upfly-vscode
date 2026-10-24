/**
 * Coding agents in the editor. The MCP server the extension carries is registered for each
 * workspace folder with an Upfly config, in a workspace VS Code trusts, unless a server
 * serving Upfly is already configured there, which would show every tool twice. It runs on the
 * Node.js that runs the CLI. "Point coding agents at Upfly" runs `upfly init --agents` in a
 * folder the person picks, and the setup Cursor and Windsurf take is copied for the person to
 * paste, never written.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import {
  type OtherEditor,
  agentsReport,
  mcpSetup,
  serverLabels,
  setupCopied,
  upflyServerIn,
} from './agents.js';
import { findBundledMcp } from './bundled-cli.js';
import type { InitResult } from './contract.js';
import type { Host } from './host.js';
import {
  CODE_CONFIG_FILES,
  type FolderFiles,
  JSON_CONFIG_FILE,
  holdsUpflyConfig,
  isOldExtensionConfig,
  readConfigText,
} from './project-config.js';
import { type StepAction, nextStep } from './refusals.js';

/** The provider's id, as the manifest's `mcpServerDefinitionProviders` names it. */
const PROVIDER = 'upfly';
const REPORT_SCHEME = 'upfly-agents';
/** How long a burst of file events waits before the servers are worked out again. */
const SETTLE_MS = 300;

/** A server given to the editor, as plain data: read by the extension's tests. */
export interface McpServer {
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string | number | null>>;
  readonly cwd: string | undefined;
  readonly version: string | undefined;
}

/** What the agents part gives the rest of the extension. */
export interface AgentsPart {
  /** The servers the editor is given now. */
  servers(): Promise<readonly McpServer[]>;
  /** The labels of the servers the editor has started, in order, each time it started one. */
  started(): readonly string[];
  /** Asks the editor for the servers again, as after a config is written or converted. */
  changed(): void;
}

/**
 * Registers the MCP server provider and the coding agents' commands.
 *
 * @param context the extension's context
 * @param host the shared runner and log
 */
export function registerAgents(context: vscode.ExtensionContext, host: Host): AgentsPart {
  const changes = new vscode.EventEmitter<void>();
  const reports = new Map<string, string>();
  const reportChanged = new vscode.EventEmitter<vscode.Uri>();
  let settle: NodeJS.Timeout | undefined;
  let lastSaid = '';
  const started: string[] = [];

  const changed = (): void => {
    clearTimeout(settle);
    settle = setTimeout(() => changes.fire(), SETTLE_MS);
  };

  /** Says once, in the log, which folders get a server and why the others do not. */
  const say = (lines: string[]): void => {
    const text = lines.join('\n');
    if (text === lastSaid) return;
    lastSaid = text;
    for (const line of lines) host.log.info(line);
  };

  async function definitions(): Promise<vscode.McpStdioServerDefinition[]> {
    // Nothing is read in a workspace VS Code does not trust: the server would run the
    // project's code config, and a config file names what runs.
    if (!vscode.workspace.isTrusted) return [];
    const folders = fileFolders().filter((folder) => holdsUpflyConfig(filesOf(folder)));
    if (folders.length === 0) return [];
    const mcp = findBundledMcp(context.extensionPath);
    if (mcp === null) {
      say(['This copy of the Upfly extension carries no MCP server. Reinstall the extension.']);
      return [];
    }
    const chosen = await host.engine();
    if ('message' in chosen) {
      say([`No Upfly MCP server is registered: ${chosen.message}`]);
      return [];
    }
    const shared = sharedServer(context);
    if (shared !== null) {
      say([
        `No Upfly MCP server is registered: ${shared.where} already has the server ${shared.name}, and a second would show every tool twice.`,
      ]);
      return [];
    }
    const labels = serverLabels(folders.map((folder) => folder.name));
    const lines: string[] = [];
    const servers: vscode.McpStdioServerDefinition[] = [];
    folders.forEach((folder, index) => {
      const own = folderServer(folder);
      if (own !== null) {
        lines.push(
          `No Upfly MCP server is registered for ${folder.name}: ${own.where} already has the server ${own.name}, and a second would show every tool twice.`,
        );
        return;
      }
      const server = new vscode.McpStdioServerDefinition(
        labels[index] ?? `Upfly: ${folder.name}`,
        chosen.node.execPath,
        [mcp.bin, folder.uri.fsPath],
        { ...chosen.node.env },
        mcp.version,
      );
      server.cwd = folder.uri;
      servers.push(server);
      lines.push(`The Upfly MCP server ${server.label} serves ${folder.uri.fsPath}.`);
    });
    say(lines);
    return servers;
  }

  const provider: vscode.McpServerDefinitionProvider<vscode.McpStdioServerDefinition> = {
    onDidChangeMcpServerDefinitions: changes.event,
    provideMcpServerDefinitions: () => definitions(),
    // Asked just before the editor starts a server: trust can have changed since.
    resolveMcpServerDefinition: (server) => {
      if (!vscode.workspace.isTrusted) return undefined;
      started.push(server.label);
      host.log.info(`The editor is starting the Upfly MCP server ${server.label}.`);
      return server;
    },
  };

  async function pointAgents(target?: unknown): Promise<string | undefined> {
    if (!vscode.workspace.isTrusted) {
      refuse(
        {
          message:
            'This workspace is not trusted, so Upfly changes no file in it. Trust the workspace to point its coding agents at Upfly.',
          next: null,
          actions: [{ kind: 'trust', title: 'Manage Workspace Trust' }],
        },
        () => undefined,
      );
      return undefined;
    }
    const folder = await folderFor(target, 'Point the coding agents of which folder at Upfly?');
    if (folder === undefined) return undefined;
    const outcome = await host.run(folder, 'init', ['--agents'], {
      label: 'pointing coding agents at Upfly',
    });
    if (outcome.kind === 'stopped') {
      refuse(nextStep(outcome.error, 'init'), () => pointAgents(folder.uri));
      return undefined;
    }
    if (outcome.kind !== 'result') return undefined;
    const result = outcome.result as InitResult;
    const text = agentsReport(result, {
      folder: folder.name,
      kept: result.file === null ? keptConfig(folder) : null,
    });
    const uri = vscode.Uri.from({
      scheme: REPORT_SCHEME,
      path: `/${folder.name}/Upfly coding agents.txt`,
      query: folder.uri.toString(),
    });
    reports.set(uri.query, text);
    reportChanged.fire(uri);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {
      preview: false,
    });
    // A config written there brings the folder a server.
    changed();
    return text;
  }

  async function copySetup(target?: unknown, which?: unknown): Promise<string | undefined> {
    const folder = await folderFor(target, 'Copy the MCP setup for which folder?');
    if (folder === undefined) return undefined;
    const editor: OtherEditor | undefined =
      which === 'cursor' || which === 'windsurf'
        ? which
        : (
            await vscode.window.showQuickPick(
              [
                { label: 'Cursor', description: '.cursor/mcp.json', editor: 'cursor' as const },
                { label: 'Windsurf', description: 'mcp_config.json', editor: 'windsurf' as const },
              ],
              { placeHolder: 'Copy the Upfly MCP setup for which editor?' },
            )
          )?.editor;
    if (editor === undefined) return undefined;
    const text = mcpSetup(folder.uri.fsPath, process.platform);
    await vscode.env.clipboard.writeText(text);
    void vscode.window.showInformationMessage(setupCopied(editor));
    return text;
  }

  /** Shows a refusal; its buttons manage trust, show the output, or try again. */
  function refuse(step: ReturnType<typeof nextStep>, retry: () => unknown): void {
    host.refuse(step, (kind: StepAction['kind']) => {
      if (kind === 'trust') void vscode.commands.executeCommand('workbench.trust.manage');
      else if (kind === 'output') host.log.show();
      else if (kind === 'retry') void retry();
    });
  }

  const lm = vscode.lm as Partial<typeof vscode.lm> | undefined;
  if (typeof lm?.registerMcpServerDefinitionProvider === 'function') {
    try {
      context.subscriptions.push(lm.registerMcpServerDefinitionProvider(PROVIDER, provider));
    } catch (error) {
      host.log.warn(
        `This editor did not take Upfly's MCP server: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else {
    host.log.info(
      'This editor has no MCP server API for extensions, so Upfly registers no MCP server. Upfly: Copy the MCP setup for Cursor or Windsurf copies one to add by hand.',
    );
  }

  const watched = vscode.workspace.createFileSystemWatcher(
    '**/{upfly.config.*,.vscode/mcp.json,.mcp.json}',
  );
  const userConfig = userMcpJson(context);
  context.subscriptions.push(
    changes,
    reportChanged,
    watched,
    watched.onDidCreate(changed),
    watched.onDidChange(changed),
    watched.onDidDelete(changed),
    ...(userConfig === null
      ? []
      : (() => {
          const user = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(vscode.Uri.file(path.dirname(userConfig)), 'mcp.json'),
          );
          return [
            user,
            user.onDidCreate(changed),
            user.onDidChange(changed),
            user.onDidDelete(changed),
          ];
        })()),
    vscode.workspace.onDidGrantWorkspaceTrust(changed),
    vscode.workspace.onDidChangeWorkspaceFolders(changed),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('mcp')) changed();
    }),
    vscode.workspace.registerTextDocumentContentProvider(REPORT_SCHEME, {
      onDidChange: reportChanged.event,
      provideTextDocumentContent: (uri) =>
        reports.get(uri.query) ??
        'Upfly: coding agents\n\nRun Upfly: Point coding agents at Upfly.\n',
    }),
    vscode.commands.registerCommand('upfly.pointAgents', pointAgents),
    vscode.commands.registerCommand('upfly.copyMcpSetup', copySetup),
    { dispose: () => clearTimeout(settle) },
  );

  return {
    servers: async () =>
      (await definitions()).map((server) => ({
        label: server.label,
        command: server.command,
        args: [...server.args],
        env: { ...server.env },
        cwd: server.cwd?.fsPath,
        version: server.version,
      })),
    started: () => started,
    changed,
  };
}

/** The workspace folders on disk; a virtual folder has no files the CLI could read. */
function fileFolders(): readonly vscode.WorkspaceFolder[] {
  return (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'file');
}

/** The folder a command was given, the only one, or the one the person picks. */
async function folderFor(
  target: unknown,
  placeHolder: string,
): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = fileFolders();
  if (target instanceof vscode.Uri) {
    const folder = vscode.workspace.getWorkspaceFolder(target);
    if (folder !== undefined) return folder;
  }
  if (folders.length === 0) {
    void vscode.window.showInformationMessage(
      'Open a folder first: Upfly works on a project folder.',
    );
    return undefined;
  }
  if (folders.length === 1) return folders[0];
  return (
    await vscode.window.showQuickPick(
      folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder })),
      { placeHolder },
    )
  )?.folder;
}

/** A folder's top-level files, read from the disk. */
function filesOf(folder: vscode.WorkspaceFolder): FolderFiles {
  return {
    exists: (file) => existsSync(path.join(folder.uri.fsPath, file)),
    read: (file) => readText(path.join(folder.uri.fsPath, file)),
  };
}

/** The config `init` kept: a code config first, as the CLI reads it, then the JSON one. */
function keptConfig(folder: vscode.WorkspaceFolder): string | null {
  const files = filesOf(folder);
  const code = CODE_CONFIG_FILES.find((file) => files.exists(file));
  if (code !== undefined) return code;
  const text = files.read(JSON_CONFIG_FILE);
  if (text === null) return null;
  return isOldExtensionConfig(text) ? 'old' : JSON_CONFIG_FILE;
}

/** A server already serving Upfly in one place, and that place in words. */
interface Found {
  readonly name: string;
  readonly where: string;
}

/**
 * A server serving Upfly for the whole workspace: in the person's own MCP configuration, the
 * `mcp` setting of the user or the workspace, or the workspace file's `mcp` part.
 */
function sharedServer(context: vscode.ExtensionContext): Found | null {
  const user = userMcpJson(context);
  const inUser = user === null ? null : upflyServerIn(serversIn(readText(user), 'servers'));
  if (inUser !== null) return { name: inUser, where: 'Your MCP configuration' };
  const setting = vscode.workspace.getConfiguration().inspect<{ servers?: unknown }>('mcp');
  const inUserSetting = upflyServerIn(setting?.globalValue?.servers);
  if (inUserSetting !== null) return { name: inUserSetting, where: 'Your mcp setting' };
  const inWorkspaceSetting = upflyServerIn(setting?.workspaceValue?.servers);
  if (inWorkspaceSetting !== null) {
    return { name: inWorkspaceSetting, where: "This workspace's mcp setting" };
  }
  const file = vscode.workspace.workspaceFile;
  if (file?.scheme === 'file') {
    const value = readConfigText(readText(file.fsPath) ?? '') as { mcp?: { servers?: unknown } };
    const inFile = upflyServerIn(value?.mcp?.servers);
    if (inFile !== null) return { name: inFile, where: 'The workspace file' };
  }
  return null;
}

/** A server serving Upfly for one folder: in its `.vscode/mcp.json`, `.mcp.json` or settings. */
function folderServer(folder: vscode.WorkspaceFolder): Found | null {
  const top = folder.uri.fsPath;
  const vscodeJson = upflyServerIn(
    serversIn(readText(path.join(top, '.vscode', 'mcp.json')), 'servers'),
  );
  if (vscodeJson !== null) return { name: vscodeJson, where: `${folder.name}/.vscode/mcp.json` };
  const dotMcp = upflyServerIn(serversIn(readText(path.join(top, '.mcp.json')), 'mcpServers'));
  if (dotMcp !== null) return { name: dotMcp, where: `${folder.name}/.mcp.json` };
  const setting = vscode.workspace
    .getConfiguration(undefined, folder.uri)
    .inspect<{ servers?: unknown }>('mcp');
  const inSetting = upflyServerIn(setting?.workspaceFolderValue?.servers);
  if (inSetting !== null) return { name: inSetting, where: `The mcp setting of ${folder.name}` };
  return null;
}

/**
 * The person's own MCP configuration: `mcp.json` in the profile's folder, which holds the
 * extension's global storage folder two levels down. VS Code documents neither place; in a
 * remote window both are on the remote machine, and the local file cannot be seen.
 */
function userMcpJson(context: vscode.ExtensionContext): string | null {
  if (context.globalStorageUri.scheme !== 'file') return null;
  return path.join(context.globalStorageUri.fsPath, '..', '..', 'mcp.json');
}

/** The servers an MCP config's text lists under a key, or undefined. */
function serversIn(text: string | null, key: 'servers' | 'mcpServers'): unknown {
  if (text === null) return undefined;
  const value = readConfigText(text);
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}
