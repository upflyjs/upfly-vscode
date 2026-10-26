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
  readFileSync,
  readdirSync,
  realpathSync,
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

/**
 * The workspace of the watcher's tests, in a short folder of its own, emptied first: a copy of
 * Upfly's plain-html that watches its images folder, serves itself, and holds a line naming an
 * image not there yet (site), with a branch whose commit adds two images; a copy of vite-react
 * with no config, so every folder named public is watched (vite); each committed in a git
 * repository of its own; and images made for the tests beside them (stock), each of its own
 * bytes, which no repository has.
 *
 * @param {string} root the folder to make it in
 * @param {string} fixtures the `fixtures` folder of a checkout of Upfly's repository
 * @returns {Promise<{ root: string, workspaceFile: string }>}
 */
export async function watchWorkspace(root, fixtures) {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(path.join(root, 'stock'), { recursive: true });
  const make = await imageMaker();
  for (const name of ['pasted.png', 'outside.png', 'skipped.png', 'named.png', 'late.png']) {
    await make(path.join(root, 'stock', name));
  }
  for (let index = 1; index <= 51; index += 1) {
    await make(path.join(root, 'stock', `burst-${String(index).padStart(2, '0')}.png`));
  }
  const site = path.join(root, 'site');
  const vite = path.join(root, 'vite');
  cpSync(path.join(fixtures, 'plain-html'), site, { recursive: true });
  cpSync(path.join(fixtures, 'vite-react'), vite, {
    recursive: true,
    filter: (source) => !NOT_COPIED.has(path.basename(source)),
  });
  writeFileSync(
    path.join(site, 'upfly.config.json'),
    [
      '{',
      `  "$schema": "${UPFLY_3}",`,
      '  // The site is served from the folder itself.',
      '  "publicDirs": ["."],',
      '  "watch": {',
      '    "folders": ["images"]',
      '  }',
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(
    path.join(site, 'index.html'),
    `${readFileSync(path.join(site, 'index.html'), 'utf8')}<img src="images/pasted.png" alt="A pasted image">\n`,
  );
  commitAll(site);
  commitAll(vite);
  /** @param {string[]} args */
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: site,
      env: { ...process.env, GIT_CEILING_DIRECTORIES: root },
      stdio: 'pipe',
    });
  git('checkout', '-q', '-b', 'more-images');
  await make(path.join(site, 'images', 'branch-a.png'));
  await make(path.join(site, 'images', 'branch-b.jpg'));
  commitAll(site, 'Two images on a branch');
  git('checkout', '-q', '-');
  const workspaceFile = path.join(root, 'watch.code-workspace');
  writeFileSync(workspaceFile, JSON.stringify({ folders: [{ path: 'site' }, { path: 'vite' }] }));
  return { root, workspaceFile };
}

/**
 * The workspace of the watcher's exit test, in a short folder emptied first but for the
 * fixtures' installed dependencies: a copy of each fixture `specs` names, from a checkout of
 * Upfly's own repository, its page naming an image not there yet, with a config where the
 * spec watches named folders or the fixture's served folder must be named, each committed in a
 * git repository of its own with a branch whose commit adds two images to the watched folder;
 * an untouched copy of each beside them for the builds' control; images made for the tests
 * (stock); and the specs, as `watch-exit.json`, for the tests to read.
 *
 * @param {string} root the folder to make it in
 * @param {string} fixtures the `fixtures` folder of a checkout of Upfly's repository
 * @param {Record<string, { page: string, folder: string, served: string, watch?: string[] }>} specs
 * @param {Record<string, { publicDirs?: string[] }>} builds each fixture's build, for its served folder
 * @returns {Promise<{ root: string, workspaceFile: string }>}
 */
export async function watchExitWorkspace(root, fixtures, specs, builds) {
  mkdirSync(root, { recursive: true });
  for (const entry of readdirSync(root)) {
    if (entry !== 'deps') rmSync(path.join(root, entry), { recursive: true, force: true });
  }
  mkdirSync(path.join(root, 'stock'));
  const make = await imageMaker();
  const names = Object.keys(specs);
  for (const name of names) {
    for (const kind of ['pasted', 'outside']) {
      await make(path.join(root, 'stock', `${kind}-${name}.png`));
    }
  }
  for (let index = 1; index <= 51; index += 1) {
    await make(path.join(root, 'stock', `burst-${String(index).padStart(2, '0')}.png`));
  }
  for (const name of names) {
    const spec = specs[name];
    if (spec === undefined) continue;
    const copy = path.join(root, name);
    cpSync(path.join(fixtures, name), copy, {
      recursive: true,
      filter: (source) => !NOT_COPIED.has(path.basename(source)),
    });
    const publicDirs = builds[name]?.publicDirs;
    if (publicDirs !== undefined || spec.watch !== undefined) {
      const config = {
        $schema: UPFLY_3,
        ...(publicDirs === undefined ? {} : { publicDirs }),
        ...(spec.watch === undefined ? {} : { watch: { folders: spec.watch } }),
      };
      writeFileSync(path.join(copy, 'upfly.config.json'), `${JSON.stringify(config, null, 2)}\n`);
    }
    const page = path.join(copy, ...spec.page.split('/'));
    writeFileSync(
      page,
      readFileSync(page, 'utf8').replace(
        '</body>',
        `  <img src="${spec.served}pasted.png" alt="Pasted" />\n  </body>`,
      ),
    );
    commitAll(copy);
    cpSync(copy, path.join(root, 'untouched', name), {
      recursive: true,
      filter: (source) => path.basename(source) !== '.git',
    });
    /** @param {string[]} args */
    const git = (...args) =>
      execFileSync('git', args, {
        cwd: copy,
        env: { ...process.env, GIT_CEILING_DIRECTORIES: root },
        stdio: 'pipe',
      });
    git('checkout', '-q', '-b', 'more-images');
    await make(path.join(copy, ...spec.folder.split('/'), 'branch-a.png'));
    await make(path.join(copy, ...spec.folder.split('/'), 'branch-b.jpg'));
    commitAll(copy, 'Two images on a branch');
    git('checkout', '-q', '-');
  }
  writeFileSync(path.join(root, 'watch-exit.json'), `${JSON.stringify(specs, null, 2)}\n`);
  const workspaceFile = path.join(root, 'watch-exit.code-workspace');
  writeFileSync(workspaceFile, JSON.stringify({ folders: names.map((name) => ({ path: name })) }));
  return { root, workspaceFile };
}

/**
 * Where the watcher's exit test makes its workspace: UPFLY_WATCH_EXIT_ROOT, or a short folder
 * in the temporary folder, by its real path, since file events name the real path.
 */
export function watchExitRoot() {
  return (
    process.env.UPFLY_WATCH_EXIT_ROOT ??
    path.join(realpathSync.native(tmpdir()), 'upfly-watch-exit')
  );
}

/**
 * What makes the tests' images: each a photo-like picture of random noise, which no two calls
 * make alike, so no repository has its bytes.
 *
 * @returns {Promise<(file: string) => Promise<void>>}
 */
async function imageMaker() {
  const { default: sharp } = await import('sharp');
  return async (file) => {
    const noise = sharp({
      create: {
        width: 160,
        height: 120,
        channels: 3,
        background: '#808080',
        noise: { type: 'gaussian', mean: 128, sigma: 40 },
      },
    });
    const image = file.endsWith('.jpg') ? noise.jpeg({ quality: 95 }) : noise.png();
    writeFileSync(file, await image.toBuffer());
  };
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
