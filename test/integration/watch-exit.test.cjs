// @ts-check
/**
 * The watcher's exit test, on the workspace `watchExitWorkspace` makes: in each fixture, a
 * branch's images checked out and left alone, an image pasted where the page names it, and an
 * image from outside kept beside its WebP until the page, saved in the editor, names the WebP;
 * then 51 images at once in plain-html, asked about once. A copy of each folder is kept for
 * its build and the link check, which `scripts/exit-builds.mjs --watch` runs once VS Code has
 * closed.
 */
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

/** The workspace's folder, beside its workspace file. */
function root() {
  const file = vscode.workspace.workspaceFile?.fsPath;
  assert.ok(file, 'a workspace file');
  return path.dirname(file);
}

/** @type {Record<string, { page: string, folder: string, served: string }>} */
const SPECS = JSON.parse(readFileSync(path.join(root(), 'watch-exit.json'), 'utf8'));

/** @param {string} cwd @param {string[]} args */
function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(cwd) },
  });
}

/**
 * Waits until `done` holds, polling, or fails saying what it waited for.
 *
 * @param {() => boolean} done
 * @param {string} what
 * @param {number} [ms]
 */
async function until(done, what, ms = 120_000) {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) assert.fail(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe("the watcher's exit test: new images in Upfly's fixtures", function () {
  this.timeout(300_000);
  /** @type {any} */
  let api;
  /** @param {string} name @param {string} image */
  const decision = (name, image) =>
    api.watch
      .decisions()
      .filter((/** @type {any} */ entry) => entry.folder === name && entry.path === image)
      .at(-1)?.outcome;

  before(async () => {
    const extension = vscode.extensions.getExtension('ramin.upfly-vscode');
    assert.ok(extension, 'the extension is there');
    api = await extension.activate();
    // VS Code starts watching the folders' files a moment after they open, and a file written
    // before then is never reported: wait until a file written in each one is.
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const probe = vscode.Uri.joinPath(folder.uri, 'watch-probe.txt');
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, 'watch-probe.txt'),
      );
      let heard = false;
      watcher.onDidCreate(() => {
        heard = true;
      });
      try {
        const end = Date.now() + 60_000;
        while (!heard && Date.now() < end) {
          writeFileSync(probe.fsPath, 'probe');
          await new Promise((resolve) => setTimeout(resolve, 500));
          rmSync(probe.fsPath, { force: true });
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        assert.ok(heard, `VS Code reports the files written in ${folder.name}`);
      } finally {
        watcher.dispose();
        rmSync(probe.fsPath, { force: true });
      }
    }
  });

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const spec = SPECS[folder.name];
    if (spec === undefined) continue;
    describe(folder.name, () => {
      const project = folder.uri.fsPath;
      /** @param {string} image */
      const onDisk = (image) => existsSync(path.join(project, ...image.split('/')));
      const pageText = () => readFileSync(path.join(project, ...spec.page.split('/')), 'utf8');

      it('converts none of the images a git checkout brings in', async () => {
        const images = [`${spec.folder}/branch-a.png`, `${spec.folder}/branch-b.jpg`];
        git(project, 'checkout', '-q', 'more-images');
        try {
          await until(
            () => images.every((image) => decision(folder.name, image) !== undefined),
            'the checked-out images',
          );
          await api.watch.idle();
          assert.deepEqual(
            images.map((image) => decision(folder.name, image)),
            ['not new: git has it', 'not new: git has it'],
          );
        } finally {
          git(project, 'checkout', '-q', '-');
        }
        await api.watch.idle();
        for (const image of images) {
          assert.equal(onDisk(image.replace(/\.(png|jpg)$/, '.webp')), false, image);
        }
      });

      it('converts an image pasted in the Explorer: the original gone, the line naming it rewritten', async () => {
        const image = `${spec.folder}/pasted.png`;
        const edit = new vscode.WorkspaceEdit();
        edit.createFile(vscode.Uri.joinPath(folder.uri, ...image.split('/')), {
          contents: readFileSync(path.join(root(), 'stock', `pasted-${folder.name}.png`)),
        });
        assert.equal(await vscode.workspace.applyEdit(edit), true);
        await until(() => decision(folder.name, image) !== undefined, 'the paste');
        await api.watch.idle();
        assert.equal(decision(folder.name, image), 'converted');
        assert.equal(onDisk(image), false);
        assert.equal(onDisk(`${spec.folder}/pasted.webp`), true);
        assert.ok(pageText().includes(`src="${spec.served}pasted.webp"`), 'the line rewritten');
        assert.ok(!pageText().includes(`${spec.served}pasted.png`), 'no line names the PNG');
      });

      it('converts an image from outside, its original kept until the page names the WebP', async () => {
        const image = `${spec.folder}/outside.png`;
        copyFileSync(
          path.join(root(), 'stock', `outside-${folder.name}.png`),
          path.join(project, ...image.split('/')),
        );
        await until(() => decision(folder.name, image) !== undefined, 'the image from outside');
        await api.watch.idle();
        assert.equal(decision(folder.name, image), 'converted, original kept');
        assert.equal(onDisk(image), true);
        assert.equal(onDisk(`${spec.folder}/outside.webp`), true);

        const page = vscode.Uri.joinPath(folder.uri, ...spec.page.split('/'));
        const document = await vscode.workspace.openTextDocument(page);
        const end = document.getText().indexOf('</body>');
        assert.notEqual(end, -1, 'the page has a body');
        const edit = new vscode.WorkspaceEdit();
        edit.insert(
          page,
          document.positionAt(end),
          `<img src="${spec.served}outside.webp" alt="From outside" />\n  `,
        );
        assert.equal(await vscode.workspace.applyEdit(edit), true);
        assert.equal(await document.save(), true);
        if (!api.originals.canRemove()) {
          console.log(
            '      The CLI this build carries cannot remove kept originals: the original stays.',
          );
          return;
        }
        await until(() => !onDisk(image), 'the original removed once the page names the WebP');
        await api.originals.idle();
        assert.equal(onDisk(`${spec.folder}/outside.webp`), true);
      });
    });
  }

  // Mocha runs a suite's own tests before the suites inside it, so these are suites too.
  describe('a burst', () => {
    it('asks once when 51 images arrive at once in plain-html, and converts them on Convert', async () => {
      const site = (vscode.workspace.workspaceFolders ?? []).find(
        (entry) => entry.name === 'plain-html',
      );
      assert.ok(site, 'the plain-html folder');
      api.watch.answerQuestions('Convert');
      const burst = path.join(site.uri.fsPath, 'images', 'burst');
      mkdirSync(burst);
      const names = Array.from(
        { length: 51 },
        (_, index) => `burst-${String(index + 1).padStart(2, '0')}.png`,
      );
      for (const name of names) {
        copyFileSync(path.join(root(), 'stock', name), path.join(burst, name));
      }
      const images = names.map((name) => `images/burst/${name}`);
      await until(
        () => images.every((image) => decision('plain-html', image) !== undefined),
        'the 51 images',
        180_000,
      );
      await api.watch.idle();
      assert.deepEqual(api.watch.questions(), [
        '51 new images arrived in images/burst. Convert them to WebP?',
      ]);
      assert.deepEqual(
        [...new Set(images.map((image) => decision('plain-html', image)))],
        ['converted, original kept'],
      );
    });
  });

  describe('the builds', () => {
    it('keeps a copy of each folder as the watcher left it, for its build', async () => {
      await api.watch.idle();
      await api.originals.idle();
      await api.idle();
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        if (SPECS[folder.name] === undefined) continue;
        cpSync(folder.uri.fsPath, path.join(root(), 'built', folder.name), {
          recursive: true,
          filter: (source) => !['.git', '.upfly'].includes(path.basename(source)),
        });
      }
    });
  });
});
