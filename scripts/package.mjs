#!/usr/bin/env node
// @ts-check
/**
 * Builds the extension's package for one platform: the bundled extension, and in `engine/`
 * the published `upfly`, at the exact version this repository depends on, installed from npm
 * for the target platform, so the package carries that platform's sharp and no other. The
 * package is assembled in a folder of its own, which `vsce package --no-dependencies` takes
 * whole, so the development dependencies and this computer's own sharp never reach it.
 *
 * Usage: `node scripts/package.mjs <target> [--out <folder>]`, a target being one of
 * TARGETS. It prints the package's path, its size, and how much it holds once unpacked.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WINDOWS = process.platform === 'win32';

/**
 * Each target vsce knows, with the platform npm installs for and the name sharp gives that
 * platform's binary package, `@img/sharp-<name>`.
 *
 * @type {Record<string, { os: string, cpu: string, libc?: string, img: string }>}
 */
export const TARGETS = {
  'win32-x64': { os: 'win32', cpu: 'x64', img: 'win32-x64' },
  'win32-arm64': { os: 'win32', cpu: 'arm64', img: 'win32-arm64' },
  'darwin-x64': { os: 'darwin', cpu: 'x64', img: 'darwin-x64' },
  'darwin-arm64': { os: 'darwin', cpu: 'arm64', img: 'darwin-arm64' },
  'linux-x64': { os: 'linux', cpu: 'x64', libc: 'glibc', img: 'linux-x64' },
  'linux-arm64': { os: 'linux', cpu: 'arm64', libc: 'glibc', img: 'linux-arm64' },
  'alpine-x64': { os: 'linux', cpu: 'x64', libc: 'musl', img: 'linuxmusl-x64' },
  'alpine-arm64': { os: 'linux', cpu: 'arm64', libc: 'musl', img: 'linuxmusl-arm64' },
};

/**
 * Runs a command and returns its output; a non-zero exit stops the script.
 *
 * @param {string} command
 * @param {readonly string[]} args
 * @param {string} cwd
 */
function run(command, args, cwd) {
  // npm is a command script on Windows, which only a shell can start.
  const shell = WINDOWS && command !== process.execPath;
  const quoted = shell ? args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)) : args;
  const result = spawnSync(command, quoted, {
    cwd,
    encoding: 'utf8',
    shell,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    process.stderr.write(`${result.stdout}${result.stderr}`);
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}`);
  }
  return result.stdout;
}

/**
 * The paths of the files in a zip archive, read from its central directory, with each one's
 * size once unpacked.
 *
 * @param {Buffer} zip
 * @returns {{ name: string, size: number }[]}
 */
export function zipEntries(zip) {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end === -1) throw new Error('not a zip archive');
  const count = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    entries.push({
      name: zip.toString('utf8', offset + 46, offset + 46 + nameLength),
      size: zip.readUInt32LE(offset + 24),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * One file's bytes from a zip archive.
 *
 * @param {Buffer} zip
 * @param {string} name
 */
export function zipFile(zip, name) {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let offset = zip.readUInt32LE(end + 16);
  for (let index = 0; index < zip.readUInt16LE(end + 10); index += 1) {
    const nameLength = zip.readUInt16LE(offset + 28);
    if (zip.toString('utf8', offset + 46, offset + 46 + nameLength) === name) {
      const local = zip.readUInt32LE(offset + 42);
      const method = zip.readUInt16LE(offset + 10);
      const size = zip.readUInt32LE(offset + 20);
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + size);
      return method === 0 ? data : inflateRawSync(data);
    }
    offset += 46 + nameLength + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
  }
  throw new Error(`${name} is not in the archive`);
}

/**
 * What a target's package must hold, and must not: the bundle, the carried CLI and engine,
 * sharp, and exactly the target's own sharp binaries.
 *
 * @param {readonly string[]} names the archive's paths
 * @param {string} img the target's sharp binary name
 * @returns {string[]} what is wrong, empty when nothing is
 */
export function contentProblems(names, img) {
  const problems = [];
  for (const required of [
    'extension/package.json',
    'extension/dist/extension.cjs',
    // vsce stores the licence under this name.
    'extension/LICENSE.txt',
    'extension/engine/node_modules/upfly/bin/upfly.cjs',
    'extension/engine/node_modules/upfly/dist/bin.js',
    'extension/engine/node_modules/upfly/schema/audit.json',
    'extension/engine/node_modules/upfly-core/dist/index.js',
    'extension/engine/node_modules/sharp/package.json',
    `extension/engine/node_modules/@img/sharp-${img}/package.json`,
  ]) {
    if (!names.includes(required)) problems.push(`it lacks ${required}`);
  }
  const binaries = new Set(
    names
      .map((name) => /^extension\/engine\/node_modules\/@img\/(sharp-[^/]+)\//.exec(name)?.[1])
      .filter((name) => name !== undefined),
  );
  for (const binary of binaries) {
    if (binary !== `sharp-${img}` && binary !== `sharp-libvips-${img}`) {
      problems.push(`it holds another platform's ${binary}`);
    }
  }
  return problems;
}

/**
 * Builds one target's package.
 *
 * @param {string} target
 * @param {string} out the folder the package is written to
 * @returns {{ file: string, bytes: number, unpacked: number, files: number }}
 */
export function packageFor(target, out) {
  const platform = TARGETS[target];
  if (platform === undefined)
    throw new Error(`no target ${target}: one of ${Object.keys(TARGETS).join(', ')}`);
  const work = mkdtempSync(path.join(tmpdir(), 'upfly-vsix-'));
  try {
    run(process.execPath, [path.join(PACKAGE, 'scripts', 'build.mjs')], PACKAGE);
    const manifest = JSON.parse(readFileSync(path.join(PACKAGE, 'package.json'), 'utf8'));
    const upfly = manifest.dependencies.upfly;
    if (!/^\d+\.\d+\.\d+$/.test(upfly))
      throw new Error(`upfly must be an exact version, not ${upfly}`);

    const stage = path.join(work, 'stage');
    // The engine folder carries the dependencies, so the manifest ships without them.
    const {
      scripts: _scripts,
      dependencies: _dependencies,
      devDependencies: _dev,
      private: _private,
      ...shipped
    } = manifest;
    mkdirSync(path.join(stage, 'dist'), { recursive: true });
    writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify(shipped, null, 2)}\n`);
    copyFileSync(path.join(PACKAGE, 'README.md'), path.join(stage, 'README.md'));
    copyFileSync(path.join(PACKAGE, 'LICENSE'), path.join(stage, 'LICENSE'));
    copyFileSync(
      path.join(PACKAGE, 'dist', 'extension.cjs'),
      path.join(stage, 'dist', 'extension.cjs'),
    );
    cpSync(path.join(PACKAGE, 'media'), path.join(stage, 'media'), { recursive: true });

    const engine = path.join(stage, 'engine');
    mkdirSync(engine);
    writeFileSync(
      path.join(engine, 'package.json'),
      '{ "name": "upfly-vscode-engine", "private": true }\n',
    );
    run(
      'npm',
      [
        'install',
        '--no-save',
        '--no-package-lock',
        '--omit=dev',
        '--no-audit',
        '--no-fund',
        `--os=${platform.os}`,
        `--cpu=${platform.cpu}`,
        ...(platform.libc === undefined ? [] : [`--libc=${platform.libc}`]),
        `upfly@${upfly}`,
      ],
      engine,
    );
    // npm can install the other libc's binaries for Linux too, which this target never loads.
    const img = path.join(engine, 'node_modules', '@img');
    for (const entry of existsSync(img) ? readdirSync(img) : []) {
      if (
        entry.startsWith('sharp-') &&
        entry !== `sharp-${platform.img}` &&
        entry !== `sharp-libvips-${platform.img}`
      ) {
        rmSync(path.join(img, entry), { recursive: true, force: true });
      }
    }
    rmSync(path.join(engine, 'package.json'));

    mkdirSync(out, { recursive: true });
    const file = path.join(out, `upfly-vscode-${manifest.version}-${target}.vsix`);
    const vsce = path.join(
      path.dirname(createRequire(import.meta.url).resolve('@vscode/vsce/package.json')),
      'vsce',
    );
    run(
      process.execPath,
      [vsce, 'package', '--no-dependencies', '--target', target, '--out', file],
      stage,
    );

    const zip = readFileSync(file);
    const entries = zipEntries(zip);
    const problems = contentProblems(
      entries.map((entry) => entry.name),
      platform.img,
    );
    const carried = JSON.parse(
      zipFile(zip, 'extension/engine/node_modules/upfly/package.json').toString('utf8'),
    ).version;
    if (carried !== upfly) problems.push(`it carries upfly ${carried}, not ${upfly}`);
    if (problems.length > 0)
      throw new Error(`The ${target} package is wrong: ${problems.join('; ')}.`);
    return {
      file,
      bytes: statSync(file).size,
      unpacked: entries.reduce((sum, entry) => sum + entry.size, 0),
      files: entries.length,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [target, flag, folder] = process.argv.slice(2);
  if (target === undefined || (flag !== undefined && flag !== '--out')) {
    process.stderr.write(
      `Usage: node scripts/package.mjs <target> [--out <folder>], a target being one of ${Object.keys(TARGETS).join(', ')}\n`,
    );
    process.exitCode = 2;
  } else {
    const made = packageFor(target, path.resolve(folder ?? path.join(PACKAGE, 'dist')));
    const mb = (/** @type {number} */ bytes) => `${(bytes / 1_000_000).toFixed(1)} MB`;
    process.stdout.write(
      `${made.file}\n${target}: ${mb(made.bytes)}, ${mb(made.unpacked)} unpacked in ${made.files} files\n`,
    );
  }
}
