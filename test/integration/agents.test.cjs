// @ts-check
/**
 * Coding agents in a real VS Code, on the workspace `agentsWorkspace` makes outside the
 * repository: copies of plain-html with an Upfly 3 config (configured), with a watched folder
 * (watched), with no config (bare), with the old extension's config (old), and with a config
 * beside a `.vscode/mcp.json` that already has a server named upfly (listed). VS Code starts
 * with a profile of its own, as on a fresh install. The tests run in order.
 */
const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { listTools } = require('./mcp-client.cjs');

/** The exact version of the MCP server, and of the CLI it runs, that the extension carries. */
const CARRIED = require('../../package.json').dependencies['upfly-mcp'];

/** @param {string} name */
function folder(name) {
  const found = vscode.workspace.workspaceFolders?.find((entry) => entry.name === name);
  assert.ok(found, `the workspace folder ${name}`);
  return found;
}

describe('coding agents and the Upfly extension', function () {
  this.timeout(180_000);
  /** @type {any} */
  let api;

  before(async () => {
    const extension = vscode.extensions.getExtension('ramin.upfly-vscode');
    assert.ok(extension, 'the extension is there');
    api = await extension.activate();
  });

  it("shows a fresh install no notice for the old extension's users, a project's old config included", async () => {
    await api.noticeChecked();
    assert.deepEqual(api.notices(), []);
  });

  it('registers one MCP server for each folder with an Upfly config, and none for the others', async () => {
    const servers = await api.mcpServers();
    assert.deepEqual(
      servers.map((/** @type {any} */ server) => [server.label, server.cwd]),
      [
        ['Upfly: configured', folder('configured').uri.fsPath],
        ['Upfly: watched', folder('watched').uri.fsPath],
      ],
    );
  });

  it('registers none for a folder whose .vscode/mcp.json already has an upfly server', async () => {
    const servers = await api.mcpServers();
    assert.ok(
      !servers.some((/** @type {any} */ server) => server.cwd === folder('listed').uri.fsPath),
    );
  });

  it('runs each server on the Node.js that runs the CLI, the folder as its argument', async () => {
    const [server] = await api.mcpServers();
    const engine = await api.engine();
    assert.equal(server.command, engine.node.execPath);
    assert.match(server.args[0], /upfly-mcp[\\/]dist[\\/]bin\.js$/);
    assert.equal(server.args[1], folder('configured').uri.fsPath);
    assert.equal(server.env.ELECTRON_RUN_AS_NODE, engine.node.kind === 'editor' ? '1' : undefined);
    assert.equal(server.version, CARRIED);
  });

  it("starts the server it registers, which lists Upfly's seven tools", async () => {
    const [server] = await api.mcpServers();
    // VS Code starts a server with the extension host's environment and the server's own on top.
    const { server: info, tools } = await listTools(server.command, server.args, {
      cwd: server.cwd,
      env: { ...process.env, ...server.env },
    });
    assert.deepEqual(
      [info.name, info.version, tools],
      ['upfly', CARRIED, ['audit', 'check', 'refs', 'optimize', 'dedupe', 'move', 'undo']],
    );
  });

  it('is started by VS Code itself, which offers its seven tools where it lists MCP tools', async () => {
    const servers = await api.mcpServers();
    const labels = servers.map((/** @type {any} */ server) => server.label).sort();
    const started = () => [...new Set(api.mcpStarted())].sort();
    const mcpTools = () => vscode.lm.tools.filter((tool) => tool.tags.includes('mcp'));
    const audits = () => mcpTools().filter((tool) => /^mcp_upfly\d*_audit$/.test(tool.name));
    // VS Code's own Start Server takes a server's id, the extension's ID and the label. It
    // finds nothing until VS Code has taken the servers in, so it is asked again until then.
    for (
      let tries = 0;
      tries < 60 &&
      (started().length < labels.length ||
        (mcpTools().length > 0 && audits().length < labels.length));
      tries += 1
    ) {
      for (const label of labels) {
        await vscode.commands.executeCommand(
          'workbench.mcp.startServer',
          `ramin.upfly-vscode/${label}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    // VS Code asks the extension to resolve each server just before it starts it.
    assert.deepEqual(started(), labels);
    // VS Code 1.101 lists no MCP tool among the extension API's tools.
    if (mcpTools().length === 0) return;
    // VS Code names each server's tools after it, numbering servers of the same name.
    /** @type {Map<string, string[]>} */
    const byServer = new Map();
    for (const { name } of mcpTools()) {
      const [, server, tool] = /^(mcp_upfly\d*)_(\w+)$/.exec(name) ?? [];
      if (server !== undefined && tool !== undefined) {
        byServer.set(server, [...(byServer.get(server) ?? []), tool].sort());
      }
    }
    assert.deepEqual(
      [...byServer.values()],
      labels.map(() => ['audit', 'check', 'dedupe', 'move', 'optimize', 'refs', 'undo']),
      `the tools VS Code offers: ${vscode.lm.tools.map((tool) => tool.name).join(', ')}`,
    );
  });

  it('points the coding agents of a folder at Upfly, which then gets a server too', async () => {
    const bare = folder('bare').uri.fsPath;
    const text = await vscode.commands.executeCommand('upfly.pointAgents', folder('bare').uri);
    assert.match(String(text), / {2}AGENTS\.md {2}created, with the Upfly block/);
    for (const file of ['AGENTS.md', '.agents/skills/upfly/SKILL.md', 'upfly.config.json']) {
      assert.ok(existsSync(path.join(bare, file)), `${file} written`);
    }
    assert.equal(vscode.window.activeTextEditor?.document.uri.scheme, 'upfly-agents');
    const servers = await api.mcpServers();
    assert.ok(servers.some((/** @type {any} */ server) => server.label === 'Upfly: bare'));
  });

  it("keeps the old extension's config when it points agents, and says how to convert it", async () => {
    const text = await vscode.commands.executeCommand('upfly.pointAgents', folder('old').uri);
    assert.match(
      String(text),
      /Kept upfly\.config\.json, which holds the old Upfly extension's settings/,
    );
  });

  it("copies the setup for Cursor, the server line as upfly-mcp's README gives it", async () => {
    const configured = folder('configured').uri;
    const text = await vscode.commands.executeCommand('upfly.copyMcpSetup', configured, 'cursor');
    assert.equal(await vscode.env.clipboard.readText(), text);
    const { upfly } = JSON.parse(String(text)).mcpServers;
    const npx = ['npx', '-y', 'upfly-mcp', configured.fsPath];
    assert.deepEqual(
      [upfly.command, ...upfly.args],
      process.platform === 'win32' ? ['cmd', '/c', ...npx] : npx,
    );
  });
});
