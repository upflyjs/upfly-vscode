// @ts-check
/**
 * New images arriving in watched folders, in a real VS Code, on the workspace `watchWorkspace`
 * makes: a copy of plain-html watching its images folder (site), a copy of vite-react watching
 * every folder named public (vite), each committed in a git repository of its own, and images
 * made for the tests beside them (stock). The tests run in order.
 */
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { parse } = require('jsonc-parser');
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

  it('stops watching a folder from the Explorer, writing it into watch.skip with comments kept', async () => {
    const site = folder('site');
    const burst = vscode.Uri.joinPath(site.uri, 'images', 'burst');
    const told = await vscode.commands.executeCommand('upfly.stopWatching', burst);
    assert.equal(
      told,
      'Upfly no longer watches images/burst for new images: it is in watch.skip in upfly.config.json.',
    );
    const text = readFileSync(path.join(site.uri.fsPath, 'upfly.config.json'), 'utf8');
    assert.match(text, /\/\/ The site is served from the folder itself\./);
    assert.deepEqual(parse(text), {
      $schema: './node_modules/upfly/schema/config.json',
      publicDirs: ['.'],
      watch: { skip: ['images/burst'], folders: ['images'] },
    });
  });

  it('leaves a new image in that folder as it is', async () => {
    const site = folder('site');
    const image = 'images/burst/skipped.png';
    copyFileSync(stock('skipped.png'), path.join(site.uri.fsPath, ...image.split('/')));
    await until(() => decision('site', image) !== undefined, 'the image in the skipped folder');
    await api.watch.idle();
    assert.equal(decision('site', image), 'not in a watched folder');
    assert.equal(existsSync(path.join(site.uri.fsPath, 'images', 'burst', 'skipped.webp')), false);
  });

  it('writes a config holding the $schema line and the watch part only, where there is none', async () => {
    const vite = folder('vite');
    await vscode.commands.executeCommand(
      'upfly.stopWatching',
      vscode.Uri.joinPath(vite.uri, 'public', 'icons'),
    );
    assert.deepEqual(parse(readFileSync(path.join(vite.uri.fsPath, 'upfly.config.json'), 'utf8')), {
      $schema: './node_modules/upfly/schema/config.json',
      watch: { skip: ['public/icons'] },
    });
  });

  it('refuses a folder outside every workspace folder, and says why', async () => {
    const outside = vscode.Uri.file(path.dirname(stock('outside.png')));
    const told = await vscode.commands.executeCommand('upfly.stopWatching', outside);
    assert.match(String(told), /^Upfly watches folders inside an open workspace folder only/);
    assert.equal(api.refusals().at(-1), told);
  });
});

describe('the originals kept beside their converted image', function () {
  this.timeout(180_000);
  /** @type {any} */
  let api;
  /** @param {string} name @param {string} image */
  const decision = (name, image) =>
    api.watch
      .decisions()
      .filter((/** @type {any} */ entry) => entry.folder === name && entry.path === image)
      .at(-1)?.outcome;
  /** @param {string} image */
  const waitingFor = (image) =>
    api.watch.waiting().find((/** @type {any} */ entry) => entry.original === image);
  /** @param {vscode.WorkspaceFolder} root @param {string} image */
  const onDisk = (root, image) => existsSync(path.join(root.uri.fsPath, ...image.split('/')));
  /** Writes an image from outside the editor, and waits until it is converted, its original kept. @param {string} name */
  const arrive = async (name) => {
    const vite = folder('vite');
    const image = `public/photos/${name}`;
    copyFileSync(stock(name), path.join(vite.uri.fsPath, ...image.split('/')));
    await until(() => decision('vite', image) !== undefined, `${image} from outside`);
    await api.watch.idle();
    assert.equal(decision('vite', image), 'converted, original kept');
    return image;
  };
  /** Adds lines to the vite folder's index.html in the editor, and saves it. @param {string} lines */
  const saveLines = async (lines) => {
    const page = vscode.Uri.joinPath(folder('vite').uri, 'index.html');
    const document = await vscode.workspace.openTextDocument(page);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(page, new vscode.Position(10, 0), lines);
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    assert.equal(await document.save(), true);
    return document;
  };

  before(async () => {
    const extension = vscode.extensions.getExtension('ramin.upfly-vscode');
    assert.ok(extension, 'the extension is there');
    api = await extension.activate();
  });

  it('counts them in the status bar, removable on a click only when the CLI carried can', async () => {
    await until(() => api.originals.statusBar() !== null, 'the count in the status bar');
    const bar = api.originals.statusBar();
    const folders = new Set(
      (vscode.workspace.workspaceFolders ?? []).map((entry) => entry.uri.toString()),
    );
    const count = api.watch
      .waiting()
      .filter((/** @type {any} */ entry) => folders.has(entry.folder)).length;
    assert.equal(bar.text, `$(files) Upfly: ${count} originals kept`);
    assert.equal(bar.clickable, api.originals.canRemove());
    if (!api.originals.canRemove()) {
      assert.match(bar.tooltip, /Removing them comes with a later version of Upfly\./);
    }
  });

  describe('with a CLI that removes them', () => {
    before(function () {
      if (!api.originals.canRemove()) {
        console.log(
          '      Skipped: the CLI this build carries cannot remove kept originals, so these run on one that can.',
        );
        this.skip();
      }
    });

    it('removes the original once a page saved in the editor names its WebP', async () => {
      const vite = folder('vite');
      const image = 'public/photos/outside.png';
      assert.ok(waitingFor(image), 'the original from outside waits');
      await saveLines('    <img src="/photos/outside.webp" alt="From outside">\n');
      await until(() => !onDisk(vite, image), 'the original removed');
      await api.originals.idle();
      assert.equal(onDisk(vite, 'public/photos/outside.webp'), true);
      assert.equal(waitingFor(image), undefined);
      assert.deepEqual(api.originals.runs().at(-1), {
        folder: 'vite',
        trigger: 'save',
        apply: true,
        originals: [image],
      });
    });

    it('keeps the original a page still names, with the hint in the Problems panel and its quick fix', async () => {
      const vite = folder('vite');
      const image = await arrive('named.png');
      const document = await saveLines(
        '    <img src="/photos/named.png" alt="Named">\n    <img src="/photos/named.webp" alt="Named again">\n',
      );
      await until(
        () => api.originals.runs().some((/** @type {any} */ run) => run.originals.includes(image)),
        'the removal the save asked for',
      );
      await api.originals.idle();
      assert.equal(onDisk(vite, image), true);
      assert.match(waitingFor(image)?.reason ?? '', /names it as `\/photos\/named\.png`/);

      const hintOn = () =>
        api
          .problems()
          .find((/** @type {any} */ [uri]) => uri.toString() === document.uri.toString())?.[1]
          .find((/** @type {any} */ entry) => entry.code === 'converted-beside');
      await until(() => hintOn() !== undefined, 'the hint in the Problems panel');
      const hint = hintOn();
      assert.equal(
        hint.message,
        'public/photos/named.png has a WebP beside it: public/photos/named.webp',
      );
      assert.equal(hint.severity, vscode.DiagnosticSeverity.Information);
      assert.equal(document.getText(hint.range), '/photos/named.png');

      /** @type {vscode.CodeAction[]} */
      const actions = await vscode.commands.executeCommand(
        'vscode.executeCodeActionProvider',
        document.uri,
        hint.range,
        vscode.CodeActionKind.QuickFix.value,
      );
      const fix = actions.find((action) => action.title === 'Use /photos/named.webp');
      assert.ok(fix?.edit, `the quick fix, among ${actions.map((action) => action.title)}`);
      assert.equal(onDisk(vite, image), true, 'nothing removed before the person saves');
      assert.equal(await vscode.workspace.applyEdit(fix.edit), true);
      assert.match(document.getText(), /<img src="\/photos\/named\.webp" alt="Named">/);
      assert.equal(await document.save(), true);
      await until(() => !onDisk(vite, image), 'the original removed once no line names it');
      await api.originals.idle();
      assert.equal(waitingFor(image), undefined);
    });

    it('removes, when a folder is added, an original whose WebP a line names and none names it', async () => {
      const vite = folder('vite');
      const image = await arrive('late.png');
      // Written from outside the editor, so no save asks for the removal.
      writeFileSync(path.join(vite.uri.fsPath, 'late.html'), '<img src="/photos/late.webp">\n');
      const changed = () =>
        new Promise((resolve) => {
          const listening = vscode.workspace.onDidChangeWorkspaceFolders(() => {
            listening.dispose();
            resolve(undefined);
          });
        });
      const at = (vscode.workspace.workspaceFolders ?? []).findIndex(
        (entry) => entry.name === 'vite',
      );
      let done = changed();
      assert.equal(vscode.workspace.updateWorkspaceFolders(at, 1), true);
      await done;
      done = changed();
      assert.equal(
        vscode.workspace.updateWorkspaceFolders(at, 0, { uri: vite.uri, name: 'vite' }),
        true,
      );
      await done;
      await until(() => !onDisk(vite, image), 'the original removed as the folder opened');
      await api.originals.idle();
      assert.deepEqual(
        api.originals
          .runs()
          .filter((/** @type {any} */ run) => run.originals.includes(image))
          .map((/** @type {any} */ run) => [run.trigger, run.apply]),
        [
          ['open', false],
          ['open', true],
        ],
      );
    });

    it('removes on a click every original kept in a folder, though no line names them yet', async () => {
      const site = folder('site');
      const kept = api.watch
        .waiting()
        .filter((/** @type {any} */ entry) => entry.folder === site.uri.toString())
        .map((/** @type {any} */ entry) => entry.original)
        .sort();
      assert.equal(kept.length, 51, 'the burst of 51 waits');
      const outcome = await vscode.commands.executeCommand('upfly.removeOriginals', site.uri);
      assert.deepEqual([...outcome.removed].sort(), kept);
      for (const image of kept) {
        assert.equal(onDisk(site, image), false, image);
        assert.equal(onDisk(site, image.replace(/\.png$/, '.webp')), true, image);
      }
      assert.equal(
        api.watch
          .waiting()
          .filter((/** @type {any} */ entry) => entry.folder === site.uri.toString()).length,
        0,
      );
    });
  });
});
