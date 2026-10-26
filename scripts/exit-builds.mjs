#!/usr/bin/env node
// @ts-check
/**
 * The second half of the exit test, run once its VS Code has closed: each fixture's own
 * build on the copy the extension converted, and the link check on what it emits. The same
 * runs first on an untouched copy, so a build that cannot run on this computer is told apart
 * from one the conversion broke, and the link check is shown failing on a reference broken
 * on purpose. Each fixture's dependencies are installed once, beside the copies.
 *
 * Usage: `node scripts/exit-builds.mjs [root]`, the root being the exit test's workspace
 * folder (UPFLY_EXIT_ROOT, or `upfly-exit` in the system's temporary folder); or
 * `node scripts/exit-builds.mjs --watch` for the watcher's exit test, on its fixtures and in
 * its own folder.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FIXTURES, WATCH_EXIT, danglingPaths } from '../test/integration/site-check.mjs';
import { watchExitRoot } from '../test/integration/workspace.mjs';

const watching = process.argv.includes('--watch');
const root = path.resolve(
  watching
    ? watchExitRoot()
    : (process.argv[2] ?? process.env.UPFLY_EXIT_ROOT ?? path.join(tmpdir(), 'upfly-exit')),
);
const names = Object.keys(watching ? WATCH_EXIT : FIXTURES);
const WINDOWS = process.platform === 'win32';

/**
 * Runs a command line through the shell, as npm runs a package script.
 *
 * @param {string} line
 * @param {string} cwd
 */
function shell(line, cwd, minutes = 5) {
  const bin = path.join(cwd, 'node_modules', '.bin');
  const result = spawnSync(line, {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout: minutes * 60_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` },
  });
  const ended =
    result.status === null
      ? `stopped after ${minutes} minutes, or by ${result.signal ?? result.error?.message}`
      : `exit ${result.status}`;
  return {
    ok: result.status === 0,
    output: `${ended}\n${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
  };
}

/**
 * The fixture's dependencies, installed once into a folder of their own.
 *
 * @param {string} name
 * @returns {string | null} their node_modules folder, or null when the fixture has none
 */
function dependencies(name) {
  const manifest = path.join(root, 'untouched', name, 'package.json');
  if (!existsSync(manifest)) return null;
  const folder = path.join(root, 'deps', name);
  const modules = path.join(folder, 'node_modules');
  // Written once an install has finished, so one cut short is never taken for complete.
  const done = path.join(folder, 'installed');
  if (existsSync(done)) return modules;
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  copyFileSync(manifest, path.join(folder, 'package.json'));
  const installed = shell(
    'npm install --no-audit --no-fund --no-package-lock --loglevel=error',
    folder,
    20,
  );
  if (!installed.ok) {
    throw new Error(`npm install for ${name} failed: ${installed.output.slice(-3000)}`);
  }
  writeFileSync(done, '');
  return modules;
}

/**
 * Builds one copy and checks the links of what it emits.
 *
 * @param {string} tree
 * @param {string} name
 * @param {string | null} modules
 */
function check(tree, name, modules) {
  const spec = FIXTURES[name];
  if (spec === undefined) throw new Error(`no spec for ${name}`);
  if (modules !== null && !existsSync(path.join(tree, 'node_modules'))) {
    symlinkSync(modules, path.join(tree, 'node_modules'), WINDOWS ? 'junction' : 'dir');
  }
  const built = spec.build === null ? { ok: true, output: '' } : shell(spec.build, tree);
  const dangling = built.ok ? danglingPaths(path.join(tree, spec.output)) : [];
  return { built: built.ok, output: built.output, dangling };
}

let failed = false;
const rows = [];
for (const name of names) {
  if (!existsSync(path.join(root, 'built', name))) {
    rows.push(`${name}: no converted copy, so the exit test did not convert it`);
    failed = true;
    continue;
  }
  let modules;
  try {
    modules = dependencies(name);
  } catch (error) {
    rows.push(`${name}: ${error instanceof Error ? error.message : String(error)} FAILED`);
    failed = true;
    continue;
  }
  const control = check(path.join(root, 'untouched', name), name, modules);
  const converted = check(path.join(root, 'built', name), name, modules);
  const ok = control.built && converted.built && converted.dangling.length === 0;
  if (!ok) failed = true;
  rows.push(
    `${name}: untouched ${control.built ? 'builds' : 'does not build'}, ${control.dangling.length} dangling; converted ${converted.built ? 'builds' : 'does not build'}, ${converted.dangling.length} dangling${ok ? '' : ' FAILED'}`,
  );
  for (const { label, run } of [
    { label: 'untouched', run: control },
    { label: 'converted', run: converted },
  ]) {
    if (!run.built || run.dangling.length > 0) {
      rows.push(`  ${label}: ${run.dangling.join(', ')}\n${run.output.slice(-2000)}`);
    }
  }
}

// The link check must be able to fail: the first image a copy of plain-html names pointed at
// a file that does not exist.
const broken = path.join(root, 'negative', 'plain-html');
cpSync(path.join(root, 'built', 'plain-html'), broken, { recursive: true });
const page = readFileSync(path.join(broken, 'index.html'), 'utf8');
writeFileSync(
  path.join(broken, 'index.html'),
  page.replace(/src="images\/[^"]+"/, 'src="images/logo-broken-on-purpose-by-the-check.webp"'),
);
const negative = danglingPaths(broken).some((entry) =>
  entry.includes('logo-broken-on-purpose-by-the-check'),
);
rows.push(
  `negative control: the link check ${negative ? 'reports' : 'MISSES'} a reference broken on purpose`,
);
if (!negative) failed = true;

console.log(rows.join('\n'));
process.exitCode = failed ? 1 : 0;
