// @ts-check
/**
 * The integration tests' configuration for `vscode-test`. `extension` runs the read-only tests
 * on the extension from this repository, and `change` the tests that change files, each on a
 * workspace of its own; `exit` the exit test on copies of Upfly's own fixtures, which
 * UPFLY_FIXTURES names when no checkout of Upfly sits beside this one. `package` and `package-change` run the same tests on a built package,
 * installed into the test's VS Code, when UPFLY_VSIX names one. UPFLY_VSCODE_VERSION picks the
 * VS Code version (the current release by default), and UPFLY_VSCODE_EXECUTABLE an
 * installation already on disk.
 */
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineConfig } from '@vscode/test-cli';
import { FIXTURES } from './test/integration/site-check.mjs';
import {
  EDITOR_VARIABLE,
  changeWorkspace,
  exitWorkspace,
  fixtureWorkspace,
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
