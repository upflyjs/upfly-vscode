// @ts-check
/**
 * The old extension's users in a real VS Code, on the workspace `updateWorkspace` makes: VS Code
 * starts as after the update, its profile holding two of the old extension's settings, the
 * workspace file a third, and the folder site a fourth beside the old extension's
 * upfly.config.json. The tests run in order. VS Code keeps no state between the starts of a
 * test run, so the next start's check is run again in the same one.
 */
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

/** @param {string} name */
function folder(name) {
  const found = vscode.workspace.workspaceFolders?.find((entry) => entry.name === name);
  assert.ok(found, `the workspace folder ${name}`);
  return found;
}

/** The profile's settings file, in the profile folder beside the workspace file. */
function userSettings() {
  const workspace = vscode.workspace.workspaceFile?.fsPath;
  assert.ok(workspace, 'a workspace file');
  return path.join(path.dirname(workspace), 'user-data', 'User', 'settings.json');
}

/** @param {vscode.Uri} uri */
async function lensTitles(uri) {
  // VS Code asks the providers only for a document it has loaded.
  await vscode.workspace.openTextDocument(uri);
  /** @type {vscode.CodeLens[]} */
  const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', uri, 100);
  return lenses.map((lens) => lens.command?.title ?? '');
}

/**
 * The titles of the code actions VS Code offers on a range, asked again until one of them is
 * `wanted` or ten seconds pass: for a document just opened, the first answer can come before
 * the providers have seen it.
 *
 * @param {vscode.Uri} uri
 * @param {vscode.Range} range
 * @param {string} wanted
 */
async function codeActionTitles(uri, range, wanted) {
  const until = Date.now() + 10_000;
  for (;;) {
    /** @type {vscode.CodeAction[] | undefined} */
    const actions = await vscode.commands.executeCommand(
      'vscode.executeCodeActionProvider',
      uri,
      range,
    );
    const titles = (actions ?? []).map((action) => action.title);
    if (titles.includes(wanted) || Date.now() > until) return titles;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe("the old extension's users, on the first start after the update", function () {
  this.timeout(180_000);
  /** @type {any} */
  let api;

  before(async () => {
    const extension = vscode.extensions.getExtension('ramin.upfly-vscode');
    assert.ok(extension, 'the extension is there');
    api = await extension.activate();
    await api.noticeChecked();
  });

  it('shows one notice, every sentence of it true of this build', () => {
    assert.deepEqual(api.notices(), [
      "Upfly is rebuilt on Upfly 3. It converts the images you choose and updates the code that uses them, with a plan first and Undo after. This version does not convert new images as they arrive: right-click them and choose Optimize. The old extension's settings no longer do anything.",
    ]);
  });

  it('finds the old settings in every place they are set', () => {
    assert.deepEqual(
      api
        .oldSettings()
        .map((/** @type {any} */ setting) => [setting.key, setting.scope, setting.folder ?? null]),
      [
        ['upfly.enabled', 'user', null],
        ['upfly.watchTargets', 'user', null],
        ['upfly.quality', 'workspace', null],
        ['upfly.storageMode', 'folder', 'site'],
      ],
    );
  });

  it("opens What's new, listing them and the old config, with a button for each", async () => {
    await vscode.commands.executeCommand('upfly.whatsNew');
    const document = vscode.window.activeTextEditor?.document;
    assert.ok(document);
    const text = document.getText();
    for (const line of [
      '- upfly.watchTargets, in your user settings',
      "- upfly.quality, in this workspace's settings",
      '- upfly.storageMode, in the settings of site',
      '- This version does not convert new images as they arrive. Right-click them and choose Optimize.',
    ]) {
      assert.ok(text.includes(line), line);
    }
    assert.match(text, /so Upfly stops before reading these folders: site\./);
    assert.doesNotMatch(text, /converted automatically/);
    assert.deepEqual(await lensTitles(document.uri), [
      'Remove the old settings',
      'Convert upfly.config.json in site',
    ]);
  });

  it('puts the old config in the Problems panel, with a quick fix that converts it', async () => {
    const config = vscode.Uri.joinPath(folder('site').uri, 'upfly.config.json');
    assert.deepEqual(
      vscode.languages.getDiagnostics(config).map((problem) => [problem.code, problem.source]),
      [['old-extension-config', 'Upfly']],
    );
    await vscode.workspace.openTextDocument(config);
    const fix = "Convert to Upfly 3's config";
    const titles = await codeActionTitles(config, new vscode.Range(3, 0, 3, 0), fix);
    assert.ok(titles.includes(fix), `"${fix}" among the code actions: ${titles.join(', ')}`);
  });

  it('audits nothing in that folder until it is converted, since the CLI refuses it', async () => {
    const outcomes = await vscode.commands.executeCommand('upfly.auditWorkspace');
    assert.deepEqual(
      outcomes.map((/** @type {any} */ outcome) => [
        path.basename(outcome.folder),
        outcome.kind,
        outcome.error?.reason ?? null,
      ]),
      [
        ['site', 'stopped', 'V2_EXTENSION_CONFIG'],
        ['other', 'result', null],
      ],
    );
  });

  it('removes the old settings from every place on a click, and says what it removed', async () => {
    const text = await vscode.commands.executeCommand('upfly.removeOldSettings');
    assert.equal(
      text,
      "Removed upfly.enabled and upfly.watchTargets from your user settings, upfly.quality from this workspace's settings, and upfly.storageMode from the settings of site.",
    );
    assert.deepEqual(api.oldSettings(), []);
    const workspaceFile = vscode.workspace.workspaceFile?.fsPath ?? '';
    const siteSettings = path.join(folder('site').uri.fsPath, '.vscode', 'settings.json');
    for (const file of [userSettings(), workspaceFile, siteSettings]) {
      assert.doesNotMatch(readFileSync(file, 'utf8'), /"upfly\./, file);
    }
  });

  it('converts the old config on a click, keeping the old file in .upfly byte for byte', async () => {
    const site = folder('site');
    const config = path.join(site.uri.fsPath, 'upfly.config.json');
    const before = readFileSync(config);
    const report = await vscode.commands.executeCommand('upfly.convertOldConfig', site.uri);
    assert.deepEqual(JSON.parse(readFileSync(config, 'utf8')), {
      $schema: './node_modules/upfly/schema/config.json',
      watch: { folders: ['images'], keepOriginals: true },
    });
    const kept = path.join(site.uri.fsPath, '.upfly');
    assert.deepEqual(readFileSync(path.join(kept, 'old-extension-upfly.config.json')), before);
    assert.equal(readFileSync(path.join(kept, '.gitignore'), 'utf8'), '*\n');
    assert.match(
      String(report),
      /- cloudUpload: upload to S3, Google Cloud Storage and Cloudinary is not in this version\./,
    );
    assert.deepEqual(vscode.languages.getDiagnostics(vscode.Uri.file(config)), []);
  });

  it('audits the folder once it is converted, as the CLI reads the new config', async () => {
    const outcomes = await vscode.commands.executeCommand('upfly.auditWorkspace');
    assert.deepEqual(
      outcomes.map((/** @type {any} */ outcome) => outcome.kind),
      ['result', 'result'],
    );
  });

  it("gives the folder an MCP server once its config is Upfly 3's", async () => {
    const servers = await api.mcpServers();
    assert.ok(servers.some((/** @type {any} */ server) => server.label === 'Upfly: site'));
  });

  it('remembers the notice: with an old setting set again, the next check shows none', async () => {
    // As Settings Sync could bring one back from another computer.
    writeFileSync(userSettings(), JSON.stringify({ 'upfly.enabled': false }));
    for (let tries = 0; tries < 50 && api.oldSettings().length === 0; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.deepEqual(
      api.oldSettings().map((/** @type {any} */ setting) => [setting.key, setting.scope]),
      [['upfly.enabled', 'user']],
    );
    await api.checkNoticeAgain();
    assert.equal(api.notices().length, 1);
  });
});
