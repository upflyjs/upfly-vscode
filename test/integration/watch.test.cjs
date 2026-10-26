// @ts-check
/**
 * New images arriving in watched folders, in a real VS Code, on the workspace `watchWorkspace`
 * makes: a copy of plain-html watching its images folder (site), a copy of vite-react watching
 * every folder named public (vite), each committed in a git repository of its own, and images
 * made for the tests beside them (stock). The tests run in order.
 */
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { copyFileSync, existsSync, mkdirSync, readFileSync } = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

/** @param {string} name */
function folder(name) {
  const found = vscode.workspace.workspaceFolders?.find((entry) => entry.name === name);
  assert.ok(found, `the workspace folder ${name}`);
  return found;
}

/** An image made for the tests, which no repository holds. @param {string} name */
function stock(name) {
  const workspace = vscode.workspace.workspaceFile?.fsPath;
  assert.ok(workspace, 'a workspace file');
  return path.join(path.dirname(workspace), 'stock', name);
}

/** @param {string} cwd @param {string[]} args */
function git(cwd, ...args) {
  execFileSync('git', args, {
    cwd,
    env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(cwd) },
    stdio: 'pipe',
  });
}

/**
 * Waits until `done` holds, polling, or fails saying what it waited for.
 *
 * @param {() => boolean} done
 * @param {string} what
 * @param {number} [ms]
 */
async function until(done, what, ms = 90_000) {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) assert.fail(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe('new images arriving in a watched folder', function () {
  this.timeout(180_000);
  /** @type {any} */
  let api;
  /** What the watcher decided for an image, once it has. @param {string} name @param {string} image */
  const decision = (name, image) =>
    api.watch
      .decisions()
      .filter((/** @type {any} */ entry) => entry.folder === name && entry.path === image)
      .at(-1)?.outcome;

  before(async () => {
    const extension = vscode.extensions.getExtension('ramin.upfly-vscode');
    assert.ok(extension, 'the extension is there');
    api = await extension.activate();
  });

  it('watches the workspace, which VS Code trusts', () => {
    assert.equal(api.watch.started(), true);
  });

  it('converts an image pasted where a line names it: the original gone, the line rewritten', async () => {
    const site = folder('site');
    const png = vscode.Uri.joinPath(site.uri, 'images', 'pasted.png');
    const edit = new vscode.WorkspaceEdit();
    edit.createFile(png, { contents: readFileSync(stock('pasted.png')) });
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    await until(() => decision('site', 'images/pasted.png') !== undefined, 'the paste');
    await api.watch.idle();
    assert.equal(decision('site', 'images/pasted.png'), 'converted');
    assert.equal(existsSync(path.join(site.uri.fsPath, 'images', 'pasted.webp')), true);
    assert.equal(existsSync(png.fsPath), false);
    const html = readFileSync(path.join(site.uri.fsPath, 'index.html'), 'utf8');
    assert.match(html, /<img src="images\/pasted\.webp" alt="A pasted image">/);
    assert.doesNotMatch(html, /images\/pasted\.png/);
    assert.deepEqual(api.watch.runs().at(-1), {
      folder: 'site',
      kind: 'paste',
      images: ['images/pasted.png'],
    });
  });

  it('converts an image written from outside the editor, keeping the original as waiting', async () => {
    const vite = folder('vite');
    const image = 'public/photos/outside.png';
    copyFileSync(stock('outside.png'), path.join(vite.uri.fsPath, ...image.split('/')));
    await until(() => decision('vite', image) !== undefined, 'the image from outside');
    await api.watch.idle();
    assert.equal(decision('vite', image), 'converted, original kept');
    assert.equal(existsSync(path.join(vite.uri.fsPath, 'public', 'photos', 'outside.png')), true);
    assert.equal(existsSync(path.join(vite.uri.fsPath, 'public', 'photos', 'outside.webp')), true);
    assert.deepEqual(
      api.watch
        .waiting()
        .map((/** @type {any} */ entry) => [entry.folder, entry.original, entry.converted]),
      [[vite.uri.toString(), image, 'public/photos/outside.webp']],
    );
  });

  it('converts none of the images a git checkout brings in', async () => {
    const site = folder('site');
    const images = ['images/branch-a.png', 'images/branch-b.jpg'];
    git(site.uri.fsPath, 'checkout', '-q', 'more-images');
    try {
      await until(
        () => images.every((image) => decision('site', image) !== undefined),
        'the checked-out images',
      );
      await api.watch.idle();
      assert.deepEqual(
        images.map((image) => decision('site', image)),
        ['not new: git has it', 'not new: git has it'],
      );
      for (const name of ['branch-a.webp', 'branch-b.webp']) {
        assert.equal(existsSync(path.join(site.uri.fsPath, 'images', name)), false, name);
      }
    } finally {
      git(site.uri.fsPath, 'checkout', '-q', '-');
    }
  });

  it('asks once when 51 images arrive at once, and converts them in one run on Convert', async () => {
    api.watch.answerQuestions('Convert');
    const site = folder('site');
    const names = Array.from(
      { length: 51 },
      (_, index) => `burst-${String(index + 1).padStart(2, '0')}.png`,
    );
    mkdirSync(path.join(site.uri.fsPath, 'images', 'burst'));
    for (const name of names) {
      copyFileSync(stock(name), path.join(site.uri.fsPath, 'images', 'burst', name));
    }
    const images = names.map((name) => `images/burst/${name}`);
    await until(
      () => images.every((image) => decision('site', image) !== undefined),
      'the 51 images',
      150_000,
    );
    await api.watch.idle();
    assert.deepEqual(api.watch.questions(), [
      '51 new images arrived in images/burst. Convert them to WebP?',
    ]);
    const burst = api.watch
      .runs()
      .filter((/** @type {any} */ run) => run.images.includes('images/burst/burst-01.png'));
    assert.equal(burst.length, 1);
    assert.equal(burst[0].images.length, 51);
    assert.deepEqual(
      [...new Set(images.map((image) => decision('site', image)))],
      ['converted, original kept'],
    );
  });

  it('leaves the review alone: an automatic conversion writes no record of the last run', () => {
    const site = folder('site');
    assert.equal(existsSync(path.join(site.uri.fsPath, '.upfly', 'manifest.json')), false);
    assert.equal(api.review(site.uri), undefined);
  });
});
