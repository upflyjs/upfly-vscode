// @ts-check
/**
 * The exit test, on the workspace `exitWorkspace` makes: each of Upfly's six fixtures
 * converted through Optimize workspace, a copy of the result kept for its build and the link
 * check (`scripts/exit-builds.mjs` runs them once VS Code has closed), then the review's
 * Accept and Undo on a line, a file and the whole run, and every byte back after the undo.
 */
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { cpSync, readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

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
      else {
        const name = path.relative(root, full).split(path.sep).join('/');
        all[name] = createHash('sha256').update(readFileSync(full)).digest('hex');
      }
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

describe("the exit test: Upfly's fixtures through the extension", function () {
  this.timeout(300_000);
  /** @type {any} */
  let api;

  before(async () => {
    const extension = vscode.extensions.getExtension('ramin.upfly-vscode');
    assert.ok(extension, 'the extension is there');
    api = await extension.activate();
  });

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    describe(folder.name, () => {
      const root = folder.uri.fsPath;
      const planUri = vscode.Uri.from({
        scheme: 'upfly-plan',
        path: `/${folder.name}/Upfly plan.md`,
        query: folder.uri.toString(),
      });
      /** @type {Record<string, string>} */
      let before = {};
      /** @type {any} */
      let review;
      /** @param {any} line */
      const stateOf = (line) =>
        api
          .review(folder.uri)
          .review.files.flatMap((/** @type {any} */ file) => file.lines)
          .find((/** @type {any} */ entry) => entry.key === line.key).state;

      it('converts its images through Optimize workspace, as one commit', async () => {
        before = hashes(root);
        const planned = await vscode.commands.executeCommand('upfly.optimizeWorkspace', folder.uri);
        assert.equal(planned.phase, 'ready', planned.text);
        const applied = await vscode.commands.executeCommand('upfly.applyPlan', planUri);
        assert.equal(applied.phase, 'applied', applied.text);
        assert.equal(git(root, 'status', '--porcelain'), '');
        cpSync(root, path.join(path.dirname(root), 'built', folder.name), {
          recursive: true,
          filter: (source) => !['.git', '.upfly'].includes(path.basename(source)),
        });
        review = api.review(folder.uri).review;
        assert.equal(review.open, true);
      });

      it('accepts a line, and undoes another with the original it names', async () => {
        const lines = review.files.flatMap((/** @type {any} */ file) => file.lines);
        const first = lines[0];
        const last = lines.at(-1);
        await vscode.commands.executeCommand(
          'upfly.review.acceptLine',
          folder.uri,
          first.file,
          first.line,
        );
        assert.equal(stateOf(first), 'accepted');
        assert.notEqual(last.key, first.key, 'the run changed more than one line');
        const outcome = await vscode.commands.executeCommand(
          'upfly.review.undoLine',
          folder.uri,
          last.file,
          last.line,
        );
        assert.equal(outcome.kind, 'result');
        assert.equal(stateOf(last), 'undone');
      });

      it('accepts a file and undoes another, or undoes the only one', async () => {
        const files = review.files;
        const undone = files.at(-1);
        if (files.length > 1) {
          await vscode.commands.executeCommand(
            'upfly.review.acceptFile',
            folder.uri,
            files[0].path,
          );
          for (const line of files[0].lines) assert.notEqual(stateOf(line), 'pending');
        }
        const outcome = await vscode.commands.executeCommand(
          'upfly.review.undoFile',
          folder.uri,
          undone.path,
        );
        assert.equal(outcome.kind, 'result');
        for (const line of undone.lines) assert.equal(stateOf(line), 'undone');
        console.log(
          `      ${review.files.flatMap((/** @type {any} */ file) => file.lines).length} lines in ${files.length} files; ${files.length > 1 ? `accepted ${files[0].path}, ` : ''}undid ${undone.path}`,
        );
      });

      it('undoes the whole run, putting every byte back', async () => {
        const outcome = await vscode.commands.executeCommand('upfly.review.undoRun', folder.uri);
        assert.equal(outcome.kind, 'result');
        assert.deepEqual(hashes(root), before);
        assert.equal(api.review(folder.uri).review.open, false);
      });
    });
  }
});
