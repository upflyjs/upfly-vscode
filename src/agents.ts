/**
 * Coding agents and Upfly: which MCP server already serves Upfly, so the editor does not get a
 * second one with every tool twice; the server line other editors take; and what
 * `upfly init --agents` did, in the CLI's own words.
 */

import type { AgentFile, InitResult } from './contract.js';

/** A command or argument that runs the `upfly-mcp` package, by name or from an install of it. */
const RUNS_UPFLY_MCP = /(?:^|[\\/])upfly-mcp(?:@[^\\/\s]*)?(?:\.cmd|\.exe)?(?:$|[\\/])/i;

/**
 * The name of a server that already serves Upfly: one named `upfly` in any letter case, or
 * one whose command line runs `upfly-mcp`.
 *
 * @param servers the servers of an MCP config, by name, as `servers` or `mcpServers` holds them
 * @returns that server's name, or null when there is none
 */
export function upflyServerIn(servers: unknown): string | null {
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) return null;
  for (const [name, server] of Object.entries(servers)) {
    if (name.toLowerCase() === 'upfly') return name;
    const { command, args } = (server ?? {}) as { command?: unknown; args?: unknown };
    const words = [command, ...(Array.isArray(args) ? args : [])];
    if (words.some((word) => typeof word === 'string' && RUNS_UPFLY_MCP.test(word))) return name;
  }
  return null;
}

/**
 * The name each folder's server shows in the editor, after the folder.
 *
 * @param folders the folders' names, in the workspace's order
 */
export function serverLabels(folders: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return folders.map((name) => {
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    return count === 1 ? `Upfly: ${name}` : `Upfly: ${name} (${count})`;
  });
}

/**
 * The MCP setup another editor's config takes for a folder, as `upfly-mcp`'s README gives it:
 * `npx -y upfly-mcp <folder>`, started through `cmd /c` on Windows.
 *
 * @param folder the project folder, as this computer spells it
 * @param platform the system the folder is on
 * @returns the JSON, ending in a newline
 */
export function mcpSetup(folder: string, platform: NodeJS.Platform): string {
  const args = ['-y', 'upfly-mcp', folder];
  const upfly =
    platform === 'win32'
      ? { command: 'cmd', args: ['/c', 'npx', ...args] }
      : { command: 'npx', args };
  return `${JSON.stringify({ mcpServers: { upfly } }, null, 2)}\n`;
}

/** An editor that reads MCP servers only from its own config file. */
export type OtherEditor = 'cursor' | 'windsurf';

/**
 * What to tell the person once an editor's setup is on the clipboard: where it goes.
 *
 * @param editor the editor it was copied for
 */
export function setupCopied(editor: OtherEditor): string {
  const merge = 'in a file that already lists servers, add the upfly entry to its mcpServers.';
  return editor === 'cursor'
    ? `Copied the Upfly MCP setup for Cursor. Paste it into .cursor/mcp.json in this project, or into ~/.cursor/mcp.json for every project; ${merge}`
    : `Copied the Upfly MCP setup for Windsurf. Paste it into Windsurf's mcp_config.json, which Open MCP config file in the Cascade panel's menu opens; ${merge}`;
}

/** What `agentsReport` needs besides the result. */
export interface AgentsContext {
  readonly folder: string;
  /**
   * The config that was already there and kept: its file name, `old` for the old extension's
   * `upfly.config.json`, or null when init wrote one.
   */
  readonly kept: string | null;
}

/**
 * What `upfly init --agents` did, as the terminal shows it: the config written or kept, then
 * each file it points the coding agents at.
 *
 * @param result the result line
 * @param context the folder, and the config that was already there
 * @returns the document's text
 */
export function agentsReport(result: InitResult, context: AgentsContext): string {
  const lines = [`Upfly: coding agents in ${context.folder}`, ''];
  const agents = result.agents ?? { instructions: [], skills: [] };
  lines.push("Pointed this project's coding agents at Upfly:");
  for (const file of agents.instructions) lines.push(`  ${file.file}  ${instructionDone(file)}`);
  for (const file of agents.skills) lines.push(`  ${file.file}  ${skillDone(file)}`);
  const changed = [...agents.instructions, ...agents.skills].some(
    (file) => file.action !== 'unchanged' && file.action !== 'skipped',
  );
  lines.push(
    '',
    changed
      ? 'These files reach the agent of everyone working on the project once they are committed.'
      : 'Nothing changed: the block and the skill were already up to date.',
    '',
    ...configLines(result, context),
  );
  return `${lines.join('\n')}\n`;
}

function configLines(result: InitResult, context: AgentsContext): string[] {
  if (result.file === null || result.config === null) {
    return context.kept === 'old'
      ? [
          "Kept upfly.config.json, which holds the old Upfly extension's settings, so Upfly stops before reading this folder until it is converted: run Upfly: Convert the old extension's upfly.config.json.",
        ]
      : [`Kept ${context.kept ?? 'the config'}, which was already there.`];
  }
  const why = result.reasons.map((reason) =>
    reason.setting === 'publicDirs' && reason.value !== null
      ? `  ${reason.value}: ${reason.why}`
      : `  ${reason.setting}: ${reason.value === null ? '' : `${reason.value}, `}${reason.why}`,
  );
  const ties = (result.ties ?? []).map(
    ({ dir, candidates }) =>
      `  not written: ${candidates.join(' and ')} resolve the root-relative paths under ${dir === '' ? 'the project' : dir} equally well, so Upfly could not choose; add the right one to publicDirs`,
  );
  return [
    `Wrote ${result.file}:`,
    '',
    ...JSON.stringify(result.config, null, 2)
      .split('\n')
      .map((line) => `  ${line}`),
    '',
    'Why:',
    ...why,
    ...ties,
    '',
    'Every Upfly command in this folder now reads it. Edit it to change what Upfly treats as the site.',
  ];
}

function instructionDone(file: AgentFile): string {
  switch (file.action) {
    case 'created':
      return 'created, with the Upfly block';
    case 'added':
      return 'the Upfly block added at the end';
    case 'updated':
      return 'the Upfly block brought up to date';
    case 'unchanged':
      return 'the Upfly block already up to date';
    case 'skipped':
      return `left as it is: ${file.why ?? 'it needs no block'}`;
  }
}

function skillDone(file: AgentFile): string {
  switch (file.action) {
    case 'created':
      return 'the Upfly skill, created';
    case 'updated':
      return 'the Upfly skill, brought up to date';
    default:
      return 'the Upfly skill, already up to date';
  }
}
