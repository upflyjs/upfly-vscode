// @ts-check
/**
 * The integration tests' configuration for `vscode-test`. `extension` runs the read-only tests
 * on the extension from this repository, `change` the tests that change files, `agents` those
 * of coding agents, and `update` those of the old extension's users, each on a workspace of its
 * own; `watch` the watcher's tests, `exit` the exit test and `watch-exit` the watcher's exit
 * test, all on copies of Upfly's own fixtures, which UPFLY_FIXTURES names when no checkout of
 * Upfly sits beside this one.
 * `package` and `package-change` run the same tests on a built package, installed into the
 * test's VS Code, when UPFLY_VSIX names one. UPFLY_VSCODE_VERSION picks the VS Code version
 * (the current release by default), and UPFLY_VSCODE_EXECUTABLE an installation already on
 * disk.
 */
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineConfig } from '@vscode/test-cli';
import { FIXTURES, WATCH_EXIT } from './test/integration/site-check.mjs';
import {
  EDITOR_VARIABLE,
  agentsWorkspace,
  changeWorkspace,
  exitWorkspace,
  fixtureWorkspace,
  updateWorkspace,
  watchExitRoot,
  watchExitWorkspace,
  watchWorkspace,
} from './test/integration/workspace.mjs';

// The test's editor inherits this process's environment.
for (const key of Object.keys(process.env)) {
  if (EDITOR_VARIABLE.test(key)) Reflect.deleteProperty(process.env, key);
}
const label = process.argv[process.argv.indexOf('--label') + 1] ?? '';
const read = fixtureWorkspace(['eleventy', 'plain-html']).workspaceFile;
// Made only for the run that opens it, since it starts a git repository in each copy.
const change = label.endsWith('change') ? changeWorkspace().workspaceFile : read;
const exit =
  label === 'exit' ? exitWorkspace(exitRoot(), upflyFixtures(), FIXTURES).workspaceFile : read;
const agents = label === 'agents' ? agentsWorkspace() : null;
const update = label === 'update' ? updateWorkspace() : null;
const watch = label === 'watch' ? await watchWorkspace(watchRoot(), upflyFixtures()) : null;
const watchExit =
  label === 'watch-exit'
    ? await watchExitWorkspace(watchExitRoot(), upflyFixtures(), WATCH_EXIT, FIXTURES)
    : null;
const executable = process.env.UPFLY_VSCODE_EXECUTABLE;
const vsix = process.env.UPFLY_VSIX;

/** @type {Omit<import('@vscode/test-cli').TestConfiguration, 'label' | 'files' | 'workspaceFolder'>} */
const common = {
  mocha: { ui: 'bdd', timeout: 180_000 },
  ...(executable === undefined
    ? { version: process.env.UPFLY_VSCODE_VERSION ?? 'stable' }
    : { useInstallation: { fromPath: executable } }),
};
const installed = {
  extensionDevelopmentPath: 'test/integration/driver',
  installExtensions: [vsix ?? ''],
  env: { UPFLY_PACKAGE: '1' },
};

/** Where the exit test copies the fixtures: a short folder, as long paths fail on Windows. */
function exitRoot() {
  return process.env.UPFLY_EXIT_ROOT ?? path.join(tmpdir(), 'upfly-exit');
}

/**
 * Where the watcher's tests make their workspace: a short folder, as for the exit test, by its
 * real path. File events name the real path, which on Windows can differ from the temporary
 * folder's short name and on macOS from its link.
 */
function watchRoot() {
  return process.env.UPFLY_WATCH_ROOT ?? path.join(realpathSync.native(tmpdir()), 'upfly-watch');
}

/** The fixtures folder of a checkout of Upfly's own repository, which the exit test copies. */
function upflyFixtures() {
  const found = [process.env.UPFLY_FIXTURES, '../upfly-v3/fixtures', '../upfly/fixtures']
    .filter((folder) => folder !== undefined)
    .map((folder) => path.resolve(folder))
    .find((folder) => existsSync(path.join(folder, 'plain-html')));
  if (found === undefined) {
    throw new Error(
      "The exit test copies the fixtures of Upfly's own repository. Set UPFLY_FIXTURES to the fixtures folder of a checkout of github.com/upflyjs/upfly.",
    );
  }
  return found;
}

export default defineConfig([
  {
    ...common,
    label: 'extension',
    files: 'test/integration/extension.test.cjs',
    workspaceFolder: read,
    launchArgs: ['--disable-extensions'],
  },
  {
    ...common,
    label: 'change',
    files: 'test/integration/change.test.cjs',
    workspaceFolder: change,
    launchArgs: ['--disable-extensions'],
  },
  {
    ...common,
    label: 'agents',
    files: 'test/integration/agents.test.cjs',
    workspaceFolder: agents?.workspaceFile ?? read,
    // A profile of its own, as on a fresh install, so no earlier run's state is there.
    launchArgs: [
      '--disable-extensions',
      ...(agents === null ? [] : [`--user-data-dir=${agents.userData}`]),
    ],
  },
  {
    ...common,
    label: 'update',
    files: 'test/integration/update.test.cjs',
    workspaceFolder: update?.workspaceFile ?? read,
    // A profile whose settings hold the old extension's, as after the update.
    launchArgs: [
      '--disable-extensions',
      ...(update === null ? [] : [`--user-data-dir=${update.userData}`]),
    ],
  },
  {
    ...common,
    label: 'watch',
    files: 'test/integration/watch.test.cjs',
    workspaceFolder: watch?.workspaceFile ?? read,
    launchArgs: ['--disable-extensions'],
    // git stops at the workspace's folder, so a folder without a repository of its own is
    // never read as part of one above it.
    ...(watch === null ? {} : { env: { GIT_CEILING_DIRECTORIES: watch.root } }),
  },
  {
    ...common,
    label: 'watch-exit',
    files: 'test/integration/watch-exit.test.cjs',
    workspaceFolder: watchExit?.workspaceFile ?? read,
    launchArgs: ['--disable-extensions'],
    mocha: { ui: 'bdd', timeout: 300_000 },
    ...(watchExit === null ? {} : { env: { GIT_CEILING_DIRECTORIES: watchExit.root } }),
  },
  {
    ...common,
    label: 'exit',
    files: 'test/integration/exit.test.cjs',
    workspaceFolder: exit,
    launchArgs: ['--disable-extensions'],
    mocha: { ui: 'bdd', timeout: 300_000 },
  },
  ...(vsix === undefined
    ? []
    : [
        {
          ...common,
          ...installed,
          label: 'package',
          files: 'test/integration/extension.test.cjs',
          workspaceFolder: read,
        },
        {
          ...common,
          ...installed,
          label: 'package-change',
          files: 'test/integration/change.test.cjs',
          workspaceFolder: change,
        },
      ]),
]);
