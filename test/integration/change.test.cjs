// @ts-check
/**
 * Changing files through the extension in a real VS Code, on the workspace `changeWorkspace`
 * makes outside the repository: a copy of plain-html in a git repository of its own, and a
 * site whose served folder cannot be worked out. The tests run in order, each on what the
 * one before left.
 */
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

/** @param {number} index */
function folder(index) {
  const found = vscode.workspace.workspaceFolders?.[index];
  assert.ok(found, `workspace folder ${index}`);
  return found;
}

/**
 * Every file of a project and the hash of its bytes, but for git's folder and Upfly's.
 *
 * @param {string} root
 * @returns {Record<string, string>}
 */
function hashes(root) {
  /** @type {Record<string, string>} */
  const all = {};
  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === '.upfly') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else
        all[path.relative(root, full).split(path.sep).join('/')] = createHash('sha256')
          .update(readFileSync(full))
          .digest('hex');
    }
  };
  walk(root);
  return all;
}

/** @param {string} cwd @param {string[]} args */
function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(cwd) },
  });
}

/** @param {vscode.Uri} uri */
async function lensTitles(uri) {
  // VS Code asks the providers only for a document it has loaded.
  await vscode.workspace.openTextDocument(uri);
  /** @type {vscode.CodeLens[]} */
  const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', uri, 100);
  return lenses.map((lens) => lens.command?.title ?? '');
}

describe('changing files through the Upfly extension', function () {
  this.timeout(180_000);
  /** @type {any} */
  let api;
  /** @type {vscode.WorkspaceFolder} */
  let plain;
  /** @type {string} */
  let root;
  /** @type {Record<string, string>} */
  let beforeApply = {};
  /** @type {vscode.Uri} */
  let planUri;

  before(async () => {
    const extension = vscode.extensions.getExtension('ramin.upfly-vscode');
    assert.ok(extension, 'the extension is there');
    api = await extension.activate();
    plain = folder(0);
    root = plain.uri.fsPath;
    planUri = vscode.Uri.from({
      scheme: 'upfly-plan',
      path: `/${plain.name}/Upfly plan.md`,
      query: plain.uri.toString(),
    });
  });

  it('plans the images chosen in a read-only document, changing no file', async () => {
    const before = hashes(root);
    const logo = vscode.Uri.joinPath(plain.uri, 'images', 'logo.png');
    const hero = vscode.Uri.joinPath(plain.uri, 'images', 'hero.jpg');
    const texture = vscode.Uri.joinPath(plain.uri, 'images', 'texture.png');
    const outcome = await vscode.commands.executeCommand('upfly.optimize', logo, [
      logo,
      hero,
      texture,
    ]);
    assert.equal(outcome.phase, 'ready');
    assert.equal(vscode.window.activeTextEditor?.document.uri.scheme, 'upfly-plan');
    assert.match(outcome.text, /for the 3 images you chose/);
    assert.match(outcome.text, /- Line 10: `images\/logo\.png` to `images\/logo\.webp`/);
    assert.deepEqual(hashes(root), before);
    assert.equal(existsSync(path.join(root, '.upfly')), false);
  });

  it('counts the originals in a folder the site serves, with a button to keep them', async () => {
    assert.match(
      api.plan(plain.uri).text,
      /## 3 originals to be removed sit in a folder the site serves/,
    );
    assert.ok((await lensTitles(planUri)).includes('Keep these originals'));
  });

  it('plans again keeping every original, and back again', async () => {
    const kept = await vscode.commands.executeCommand('upfly.keepOriginals', planUri);
    assert.match(kept.text, /- Keeps every original beside its converted image\./);
    const removed = await vscode.commands.executeCommand('upfly.keepOriginals', planUri);
    assert.match(removed.text, /- Removes 3 originals once no file names them\./);
  });

  it('plans again rather than applying when a file the plan names changed since', async () => {
    appendFileSync(path.join(root, 'index.html'), '<!-- edited after the plan -->\n');
    const outcome = await vscode.commands.executeCommand('upfly.applyPlan', planUri);
    assert.equal(outcome.phase, 'ready');
    assert.match(outcome.text, /Not applied: index\.html changed since the plan you read\./);
    assert.equal(existsSync(path.join(root, '.upfly', 'manifest.json')), false);
  });

  it('applies over uncommitted changes and makes no commit', async () => {
    beforeApply = hashes(root);
    const commits = git(root, 'rev-list', '--count', 'HEAD');
    const outcome = await vscode.commands.executeCommand('upfly.applyPlan', planUri);
    assert.equal(outcome.phase, 'applied');
    assert.ok(outcome.runId);
    assert.equal(git(root, 'rev-list', '--count', 'HEAD'), commits);
    assert.ok(existsSync(path.join(root, 'images', 'logo.webp')));
    assert.equal(existsSync(path.join(root, 'images', 'logo.png')), false);
  });

  it('opens the review with each changed line waiting for Accept or Undo', () => {
    const { review } = api.review(plain.uri);
    assert.equal(review.open, true);
    const index = review.files.find((/** @type {any} */ file) => file.path === 'index.html');
    assert.deepEqual(
      index.lines.map((/** @type {any} */ line) => [line.line, line.state]),
      [
        [10, 'pending'],
        [12, 'pending'],
        [13, 'pending'],
      ],
    );
  });

  it('puts Accept and Undo on each changed line in the code, and on the file', async () => {
    const titles = await lensTitles(vscode.Uri.joinPath(plain.uri, 'index.html'));
    for (const title of ['Accept file', 'Undo file', 'Compare with before the run']) {
      assert.ok(titles.includes(title), `a lens "${title}" among ${titles.join(', ')}`);
    }
    assert.equal(titles.filter((title) => title === 'Undo').length, 3);
  });

  it('undoes one line, and brings back the original it names', async () => {
    const outcome = await vscode.commands.executeCommand(
      'upfly.review.undoLine',
      plain.uri,
      'index.html',
      10,
    );
    assert.equal(outcome.kind, 'result');
    assert.ok(existsSync(path.join(root, 'images', 'logo.png')));
    assert.match(
      readFileSync(path.join(root, 'index.html'), 'utf8'),
      /<img src="images\/logo\.png"/,
    );
    const state = api.review(plain.uri);
    assert.match(state.last, /images\/logo\.png is back/);
    assert.equal(
      state.review.files.find((/** @type {any} */ file) => file.path === 'index.html').lines[0]
        .state,
      'undone',
    );
  });

  it('accepts one line, changing no file', async () => {
    const before = hashes(root);
    await vscode.commands.executeCommand('upfly.review.acceptLine', plain.uri, 'index.html', 12);
    const index = api
      .review(plain.uri)
      .review.files.find((/** @type {any} */ file) => file.path === 'index.html');
    assert.equal(index.lines[1].state, 'accepted');
    assert.deepEqual(hashes(root), before);
  });

  it("refuses to undo a line of a file edited since the run, with the CLI's reason", async () => {
    const file = path.join(root, 'index.html');
    const left = readFileSync(file);
    appendFileSync(file, '<!-- edited after the run -->\n');
    const line = await vscode.commands.executeCommand(
      'upfly.review.undoLine',
      plain.uri,
      'index.html',
      13,
    );
    const whole = await vscode.commands.executeCommand('upfly.review.undoRun', plain.uri);
    assert.deepEqual(
      [line.reason, whole.reason],
      ['TRANSACTION_FOREIGN_CHANGE', 'TRANSACTION_FOREIGN_CHANGE'],
    );
    const index = api
      .review(plain.uri)
      .review.files.find((/** @type {any} */ entry) => entry.path === 'index.html');
    assert.equal(index.changedSince, true);
    assert.ok(
      (await lensTitles(vscode.Uri.joinPath(plain.uri, 'index.html'))).every(
        (title) => title !== 'Undo',
      ),
    );
    writeFileSync(file, left);
  });

  it('undoes one file, and brings back the original it names', async () => {
    const outcome = await vscode.commands.executeCommand(
      'upfly.review.undoFile',
      plain.uri,
      'css/site.css',
    );
    assert.equal(outcome.kind, 'result');
    assert.ok(existsSync(path.join(root, 'images', 'texture.png')));
  });

  it('accepts a whole file', async () => {
    await vscode.commands.executeCommand('upfly.review.acceptFile', plain.uri, 'index.html');
    const index = api
      .review(plain.uri)
      .review.files.find((/** @type {any} */ file) => file.path === 'index.html');
    assert.deepEqual(
      index.lines.map((/** @type {any} */ line) => line.state),
      ['undone', 'accepted', 'accepted'],
    );
  });

  it('undoes the whole run, putting every byte back, and the review ends', async () => {
    const outcome = await vscode.commands.executeCommand('upfly.review.undoRun', plain.uri);
    assert.equal(outcome.kind, 'result');
    assert.deepEqual(hashes(root), beforeApply);
    assert.equal(api.review(plain.uri).review.open, false);
  });

  it('lists a broken reference in the Problems panel at its line', async () => {
    await api.idle();
    const about = api
      .problems()
      .find(([/** @type {vscode.Uri} */ uri]) => uri.fsPath === path.join(root, 'about.html'));
    assert.ok(about, 'an entry for about.html');
    assert.equal(about[1][0].range.start.line, 9);
    assert.match(about[1][0].message, /^No file is at images\/missing-on-purpose\.png/);
  });

  it('clears the Problems panel for the folder once its audit finds no broken reference', async () => {
    const about = path.join(root, 'about.html');
    writeFileSync(
      about,
      readFileSync(about, 'utf8').replace('images/missing-on-purpose.png', 'images/team.jpg'),
    );
    await vscode.commands.executeCommand('upfly.auditWorkspace');
    assert.equal(
      api.problems().filter(([/** @type {vscode.Uri} */ uri]) => uri.fsPath.startsWith(root))
        .length,
      0,
    );
  });

  it("refuses Optimize workspace over uncommitted changes with the CLI's message, and no apply anyway", async () => {
    const planned = await vscode.commands.executeCommand('upfly.optimizeWorkspace', plain.uri);
    assert.equal(planned.phase, 'ready');
    const outcome = await vscode.commands.executeCommand('upfly.applyPlan', planUri);
    assert.deepEqual([outcome.phase, outcome.reason], ['stopped', 'UNCOMMITTED_CHANGES']);
    assert.match(outcome.text, /Commit or stash your changes, then apply again\./);
    const titles = await lensTitles(planUri);
    assert.ok(titles.includes('Open Source Control'));
    assert.ok(!titles.some((title) => /anyway/i.test(title)));
  });

  it('applies the whole folder as one commit once it is committed', async () => {
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'Work before the run');
    const commits = Number(git(root, 'rev-list', '--count', 'HEAD'));
    await vscode.commands.executeCommand('upfly.optimizeWorkspace', plain.uri);
    const outcome = await vscode.commands.executeCommand('upfly.applyPlan', planUri);
    assert.equal(outcome.phase, 'applied');
    assert.equal(Number(git(root, 'rev-list', '--count', 'HEAD')), commits + 1);
    assert.match(git(root, 'log', '-1', '--format=%B'), new RegExp(outcome.runId));
    assert.equal(git(root, 'status', '--porcelain'), '');
  });

  it('says another run holds the project, and offers to try again', async () => {
    await vscode.commands.executeCommand('upfly.review.undoRun', plain.uri);
    await vscode.commands.executeCommand('upfly.optimizeWorkspace', plain.uri);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'The undo, committed');
    writeFileSync(
      path.join(root, '.upfly', 'lock'),
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        runId: 'held-by-a-test',
      }),
    );
    try {
      await vscode.commands.executeCommand('upfly.planAgain', planUri);
      const outcome = await vscode.commands.executeCommand('upfly.applyPlan', planUri);
      assert.deepEqual([outcome.phase, outcome.reason], ['stopped', 'TRANSACTION_LOCKED']);
      assert.match(outcome.text, /Try again once it has finished\./);
      assert.ok((await lensTitles(planUri)).includes('Try again'));
    } finally {
      rmSync(path.join(root, '.upfly', 'lock'), { force: true });
    }
  });

  it('shows why a folder whose served folder is unknown gets no plan, with the ways out', async () => {
    const unknown = folder(1);
    const outcome = await vscode.commands.executeCommand('upfly.optimizeWorkspace', unknown.uri);
    assert.deepEqual([outcome.phase, outcome.reason], ['stopped', 'SERVING_ROOT_UNKNOWN']);
    assert.match(
      outcome.text,
      /Upfly made no plan: Only 0 of 12 root-relative references resolved/,
    );
    const titles = await lensTitles(
      vscode.Uri.from({
        scheme: 'upfly-plan',
        path: `/${unknown.name}/Upfly plan.md`,
        query: unknown.uri.toString(),
      }),
    );
    assert.ok(titles.includes('Choose the served folder'));
    assert.ok(titles.includes('Write upfly.config.json'));
  });

  it('plans again with the served folder chosen, and shows what the CLI says then', async () => {
    const unknown = folder(1);
    const uri = vscode.Uri.from({
      scheme: 'upfly-plan',
      path: `/${unknown.name}/Upfly plan.md`,
      query: unknown.uri.toString(),
    });
    const outcome = await vscode.commands.executeCommand(
      'upfly.planAction',
      uri,
      'choose-public',
      '.',
    );
    assert.deepEqual([outcome.phase, outcome.reason], ['stopped', 'SERVING_ROOT_UNKNOWN']);
    assert.doesNotMatch(
      outcome.text,
      /Only 0 of 12 root-relative references resolved, so Upfly cannot tell/,
    );
  });
});
