// @ts-check
/**
 * The extension in a workspace VS Code does not trust: a copy of plain-html holding an
 * `upfly.config.mjs` that leaves a mark at UPFLY_MARK when it runs, and a copy of eleventy
 * with no config. `scripts/untrusted-check.mjs` opens it.
 */
const assert = require('node:assert/strict');
const { copyFileSync, existsSync, mkdirSync } = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

/** @param {number} index */
function folder(index) {
  const found = vscode.workspace.workspaceFolders?.[index];
  assert.ok(found, `workspace folder ${index}`);
  return found;
}

describe('the Upfly extension in a workspace VS Code does not trust', function () {
  this.timeout(180_000);
  /** @type {any} */
  let api;

  before(async () => {
    const extension = vscode.extensions.getExtension('ramin.upfly-vscode');
    assert.ok(extension, 'the extension is enabled in Restricted Mode');
    api = await extension.activate();
  });

  it('is in a workspace VS Code does not trust', () => {
    assert.equal(vscode.workspace.isTrusted, false);
  });

  it('lets the CLI refuse a folder whose config would run code, says why, and reads the other', async () => {
    const outcomes = await vscode.commands.executeCommand('upfly.auditWorkspace');
    assert.deepEqual(
      outcomes.map((outcome) => [
        path.basename(outcome.folder),
        outcome.kind,
        outcome.error?.reason ?? null,
      ]),
      [
        ['plain-html', 'stopped', 'CODE_CONFIG_NOT_RUN'],
        ['eleventy', 'result', null],
      ],
    );
    const plain = api.auditRows().find((/** @type {any} */ entry) => entry.label === 'plain-html');
    assert.equal(
      plain.children[0].label,
      'This workspace is not trusted, and reading upfly.config.mjs would run code from the project. Trust the workspace to let Upfly read this folder.',
    );
  });

  it('does not search that folder for an image either', async () => {
    const image = vscode.Uri.joinPath(folder(0).uri, 'images', 'logo.png');
    const outcome = await vscode.commands.executeCommand('upfly.whereUsed', image);
    assert.equal(outcome.error?.reason, 'CODE_CONFIG_NOT_RUN');
  });

  it('optimizes no image there, and says why', async () => {
    const image = vscode.Uri.joinPath(folder(1).uri, 'src', 'img', 'logo.png');
    const outcome = await vscode.commands.executeCommand('upfly.optimize', image);
    assert.equal(outcome, undefined);
    assert.equal(api.plan(folder(1).uri), undefined);
    assert.match(
      String(api.refusals().at(-1)),
      /^This workspace is not trusted, so Upfly changes no file in it\./,
    );
  });

  it('optimizes no folder there either', async () => {
    const before = api.refusals().length;
    const outcome = await vscode.commands.executeCommand('upfly.optimizeWorkspace', folder(1).uri);
    assert.equal(outcome, undefined);
    assert.equal(api.refusals().length, before + 1);
  });

  it('undoes no run there', async () => {
    const before = api.refusals().length;
    await vscode.commands.executeCommand('upfly.review.undoRun', folder(1).uri);
    assert.equal(api.refusals().length, before + 1);
  });

  it('does not read the last run there, since listing it starts git in the folder', () => {
    assert.match(String(api.review(folder(1).uri)?.error), /^This workspace is not trusted/);
  });

  it('converts no upfly.config.json of the old extension there, and says why', async () => {
    const outcome = await vscode.commands.executeCommand('upfly.convertOldConfig', folder(1).uri);
    assert.equal(outcome, undefined);
    assert.match(
      String(api.refusals().at(-1)),
      /^This workspace is not trusted, so Upfly changes no file in it\. Trust the workspace to convert its upfly\.config\.json\.$/,
    );
  });

  it('registers no MCP server, though a folder there holds an Upfly config', async () => {
    assert.deepEqual(await api.mcpServers(), []);
  });

  it('does not point coding agents at Upfly there, and says why', async () => {
    const before = api.refusals().length;
    const outcome = await vscode.commands.executeCommand('upfly.pointAgents', folder(1).uri);
    assert.equal(outcome, undefined);
    assert.equal(existsSync(path.join(folder(1).uri.fsPath, 'AGENTS.md')), false);
    assert.match(
      String(api.refusals().at(-1)),
      /^This workspace is not trusted, so Upfly changes no file in it\./,
    );
    assert.equal(api.refusals().length, before + 1);
  });

  it('watches no folder for new images there, and converts none that arrive', async () => {
    assert.equal(api.watch.started(), false);
    const served = path.join(folder(1).uri.fsPath, 'public');
    mkdirSync(served, { recursive: true });
    copyFileSync(
      path.join(folder(1).uri.fsPath, 'src', 'img', 'logo.png'),
      path.join(served, 'arrived.png'),
    );
    // Long enough for a watcher to hear it, let it settle, and convert it.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    await api.watch.idle();
    assert.deepEqual(api.watch.decisions(), []);
    assert.equal(existsSync(path.join(served, 'arrived.webp')), false);
    assert.equal(existsSync(path.join(served, 'arrived.png')), true);
  });

  it('counts and removes no kept original there, and says why when asked to', async () => {
    assert.equal(api.originals.statusBar(), null);
    const before = api.refusals().length;
    await vscode.commands.executeCommand('upfly.removeOriginals');
    if (api.originals.canRemove()) {
      assert.match(
        String(api.refusals().at(-1)),
        /^This workspace is not trusted, so Upfly changes no file in it\./,
      );
      assert.equal(api.refusals().length, before + 1);
    }
    assert.deepEqual(api.originals.runs(), []);
  });

  it('never ran the config', () => {
    assert.equal(existsSync(String(process.env.UPFLY_MARK)), false);
  });
});
