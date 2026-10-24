// @ts-check
/**
 * The workspaces the integration tests open: copies of fixtures in a fresh folder under the
 * system's temporary folder, outside the repository, and a `.code-workspace` file naming them.
 * The tests then run on copies, so nothing they do can reach the repository.
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
 * The exit test's workspace: a copy of each of Upfly's six fixtures, from a checkout of Upfly's
 * own repository, in a short folder under the temporary folder, each committed in a git
 * repository of its own, with a config naming its served folder where Upfly cannot work it
 * out. A second, untouched copy of each is made beside them, for the builds' control.
 *
 * @param {string} root the folder to make it in, emptied first
 * @param {string} fixtures the `fixtures` folder of a checkout of Upfly's repository
 * @param {Record<string, { publicDirs?: string[] }>} specs the fixtures, by name
 * @returns {{ root: string, workspaceFile: string }}
 */
export function exitWorkspace(root, fixtures, specs) {
  // The fixtures' installed dependencies stay, so that a second run need not fetch them.
  mkdirSync(root, { recursive: true });
  for (const entry of readdirSync(root)) {
    if (entry !== 'deps') rmSync(path.join(root, entry), { recursive: true, force: true });
  }
  const names = Object.keys(specs);
  for (const name of names) {
    for (const copy of [path.join(root, name), path.join(root, 'untouched', name)]) {
      cpSync(path.join(fixtures, name), copy, {
        recursive: true,
        filter: (source) => !NOT_COPIED.has(path.basename(source)),
      });
    }
    const publicDirs = specs[name]?.publicDirs;
    if (publicDirs !== undefined) {
      const config = { $schema: './node_modules/upfly/schema/config.json', publicDirs };
      writeFileSync(
        path.join(root, name, 'upfly.config.json'),
        `${JSON.stringify(config, null, 2)}\n`,
      );
    }
    commitAll(path.join(root, name));
  }
  const workspaceFile = path.join(root, 'exit.code-workspace');
  writeFileSync(workspaceFile, JSON.stringify({ folders: names.map((name) => ({ path: name })) }));
  return { root, workspaceFile };
}

/** The `$schema` line `upfly init` writes, which marks a JSON config as Upfly 3's. */
const UPFLY_3 = './node_modules/upfly/schema/config.json';

/** A config of the old Upfly extension, as its "Create Config File" wrote one. */
export const OLD_CONFIG = `{
  // Auto-convert images dropped into watched folders
  "enabled": true,

  // Watched folders, each with its own format and quality
  "watchTargets": [
    { "path": "images", "format": "webp", "quality": 80 }
  ],
  "storageMode": "in-place",
  "inPlaceKeepOriginal": true,
  "outputDirectory": "./converted",
  "originalDirectory": "./originals",
  "maxFileSize": 20000000,
  "cloudUpload": {
    "enabled": false,
    "watchTargets": ["images"],
    "provider": "cloudinary",
    "config": { "cloudName": "\${env:CLOUDINARY_CLOUD_NAME}" }
  }
}
`;

/**
 * The workspace of the coding agents' tests: copies of plain-html with an Upfly 3 config, with
 * a watched folder, with no config, with the old extension's config, and with a config and a
 * `.vscode/mcp.json` that already has a server named upfly; and a profile folder of its own,
 * as VS Code has on a fresh install.
 *
 * @returns {{ root: string, workspaceFile: string, userData: string }}
 */
export function agentsWorkspace() {
  const json = (/** @type {object} */ value) => `${JSON.stringify(value, null, 2)}\n`;
  const names = ['configured', 'watched', 'bare', 'old', 'listed'];
  const root = mkdtempSync(path.join(tmpdir(), 'upfly-vscode-agents-'));
  /** @type {Record<string, Record<string, string>>} */
  const extra = {
    configured: { 'upfly.config.json': json({ $schema: UPFLY_3, publicDirs: ['.'] }) },
    watched: { 'upfly.config.json': json({ $schema: UPFLY_3, watch: { folders: ['images'] } }) },
    bare: {},
    old: { 'upfly.config.json': OLD_CONFIG },
    // A server named upfly that serves nothing, so a test's VS Code never fetches one.
    listed: {
      'upfly.config.json': json({ $schema: UPFLY_3, publicDirs: ['.'] }),
      '.vscode/mcp.json': json({
        servers: { upfly: { type: 'stdio', command: 'node', args: ['--version'] } },
      }),
    },
  };
  for (const name of names) {
    const copy = path.join(root, name);
    cpSync(path.join(FIXTURES, 'plain-html'), copy, { recursive: true });
    for (const [file, text] of Object.entries(extra[name] ?? {})) {
      mkdirSync(path.dirname(path.join(copy, file)), { recursive: true });
      writeFileSync(path.join(copy, file), text);
    }
  }
  const workspaceFile = path.join(root, 'agents.code-workspace');
  writeFileSync(workspaceFile, JSON.stringify({ folders: names.map((name) => ({ path: name })) }));
  const userData = path.join(root, 'user-data');
  mkdirSync(path.join(userData, 'User'), { recursive: true });
  return { root, workspaceFile, userData };
}

/**
 * The workspace of the old users' tests: a copy of plain-html (site) with the old extension's
 * config and one of its settings in the folder's own settings, another copy (other), one more
 * old setting in the workspace file, and a profile whose settings hold two more, as the old
 * extension's users have them.
 *
 * @returns {{ root: string, workspaceFile: string, userData: string }}
 */
export function updateWorkspace() {
  const root = mkdtempSync(path.join(tmpdir(), 'upfly-vscode-update-'));
  const workspaceFile = path.join(root, 'update.code-workspace');
  const userData = path.join(root, 'user-data');
  const json = (/** @type {object} */ value) => `${JSON.stringify(value, null, 2)}\n`;
  for (const name of ['site', 'other']) {
    cpSync(path.join(FIXTURES, 'plain-html'), path.join(root, name), { recursive: true });
  }
  writeFileSync(path.join(root, 'site', 'upfly.config.json'), OLD_CONFIG);
  mkdirSync(path.join(root, 'site', '.vscode'));
  writeFileSync(
    path.join(root, 'site', '.vscode', 'settings.json'),
    json({ 'upfly.storageMode': 'separate-output' }),
  );
  writeFileSync(
    workspaceFile,
    json({ folders: [{ path: 'site' }, { path: 'other' }], settings: { 'upfly.quality': 70 } }),
  );
  mkdirSync(path.join(userData, 'User'), { recursive: true });
  writeFileSync(
    path.join(userData, 'User', 'settings.json'),
    json({ 'upfly.enabled': true, 'upfly.watchTargets': ['public'] }),
  );
  return { root, workspaceFile, userData };
}

/** What a fixture copy leaves out: dependencies, build outputs and caches. */
const NOT_COPIED = new Set(['node_modules', 'dist', '_site', '.next', 'out', '.astro', '.cache']);

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
