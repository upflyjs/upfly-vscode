// @ts-check
/**
 * The workspaces the integration tests open: copies of fixtures in a fresh folder under the
 * system's temporary folder, outside the repository, and a `.code-workspace` file naming them.
 * The tests then run on copies, so nothing they do can reach the repository.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));

/**
 * The variables an editor sets for its own child processes. Started from VS Code's terminal, a
 * test's editor would otherwise take the running editor's IPC pipe and caches, or start as
 * plain Node.js, so the launchers drop them.
 */
export const EDITOR_VARIABLE = /^(?:VSCODE_|ELECTRON_RUN_AS_NODE$|CHROME_CRASHPAD_PIPE_NAME$)/;

/**
 * Copies fixtures and writes a workspace file that opens them as one folder each.
 *
 * @param {readonly string[]} fixtures the fixtures' folder names, in the workspace's order
 * @param {Record<string, Record<string, string>>} [extra] files to add to a copy, by fixture
 *   name and then by path inside it
 * @returns {{ root: string, workspaceFile: string }}
 */
export function fixtureWorkspace(fixtures, extra = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'upfly-vscode-'));
  for (const name of fixtures) {
    const copy = path.join(root, name);
    // pnpm fills a fixture's node_modules with links, which Windows lets only some users make.
    cpSync(path.join(FIXTURES, name), copy, {
      recursive: true,
      filter: (source) => path.basename(source) !== 'node_modules',
    });
    for (const [file, text] of Object.entries(extra[name] ?? {})) {
      mkdirSync(path.dirname(path.join(copy, file)), { recursive: true });
      writeFileSync(path.join(copy, file), text);
    }
  }
  const workspaceFile = path.join(root, 'fixtures.code-workspace');
  writeFileSync(
    workspaceFile,
    JSON.stringify({ folders: fixtures.map((name) => ({ path: name })) }),
  );
  return { root, workspaceFile };
}

/**
 * The workspace the tests of changing files open: a copy of plain-html in a git repository of
 * its own, whose config names the folder itself as the one the site is served from, and a
 * small site whose root-relative paths resolve against no folder, each committed.
 *
 * @returns {{ root: string, workspaceFile: string }}
 */
export function changeWorkspace() {
  const config = { $schema: './node_modules/upfly/schema/config.json', publicDirs: ['.'] };
  const { root, workspaceFile } = fixtureWorkspace(['plain-html'], {
    'plain-html': { 'upfly.config.json': `${JSON.stringify(config, null, 2)}\n` },
  });
  const unknown = path.join(root, 'unknown-root');
  mkdirSync(path.join(unknown, 'img'), { recursive: true });
  cpSync(
    path.join(FIXTURES, 'plain-html', 'images', 'logo.png'),
    path.join(unknown, 'img', 'logo.png'),
  );
  const photos = Array.from(
    { length: 12 },
    (_, index) => `<img src="/pics/photo-${index + 1}.png">`,
  );
  writeFileSync(
    path.join(unknown, 'index.html'),
    [...photos, '<img src="img/logo.png">', ''].join('\n'),
  );
  for (const folder of [path.join(root, 'plain-html'), unknown]) commitAll(folder);
  writeFileSync(
    workspaceFile,
    JSON.stringify({ folders: [{ path: 'plain-html' }, { path: 'unknown-root' }] }),
  );
  return { root, workspaceFile };
}

/**
 * Commits every file of a folder, starting a git repository there first, with an identity of
 * its own, when it has none.
 *
 * @param {string} folder
 * @param {string} [message]
 */
export function commitAll(folder, message = 'The fixture') {
  /** @param {string[]} args */
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: folder,
      env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(folder) },
      stdio: 'pipe',
    });
  if (!existsSync(path.join(folder, '.git'))) {
    git('init', '-q');
    git('config', 'user.name', 'Upfly tests');
    git('config', 'user.email', 'tests@example.com');
    git('config', 'commit.gpgsign', 'false');
  }
  git('add', '-A');
  git('commit', '-q', '-m', message);
}
