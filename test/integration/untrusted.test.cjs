// @ts-check
/**
 * The extension in a workspace VS Code does not trust: a copy of plain-html holding an
 * `upfly.config.mjs` that leaves a mark at UPFLY_MARK when it runs, and a copy of eleventy
 * with no config. `scripts/untrusted-check.mjs` opens it.
 */
const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
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

  it('never ran the config', () => {
    assert.equal(existsSync(String(process.env.UPFLY_MARK)), false);
  });
});
