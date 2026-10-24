#!/usr/bin/env node
// @ts-check
/**
 * Runs the engine a package carries on this computer's Node.js, outside VS Code: unpacks the
 * package's `engine` folder, then audits a copy of the plain HTML fixture, asks where one of
 * its images is used, and starts the MCP server on it and lists its tools, as the extension
 * would. It is the install check for a system VS Code itself does not run on, such as Alpine
 * Linux, where the extension runs inside a remote server. It uses only Node.js's own modules,
 * so it needs no install.
 *
 * Usage: `node scripts/engine-check.mjs <package.vsix>`.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mcpClient from '../test/integration/mcp-client.cjs';
import { zipEntries, zipFile } from './package.mjs';

const FIXTURE = fileURLToPath(new URL('../test/fixtures/plain-html/', import.meta.url));

/**
 * Runs one command of the carried CLI with `--json` and returns its last line.
 *
 * @param {string} bin the CLI's entry point
 * @param {readonly string[]} args
 * @param {string} cwd
 */
function lastLine(bin, args, cwd) {
  const result = spawnSync(process.execPath, [bin, ...args, '--json'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const lines = result.stdout.trimEnd().split('\n');
  try {
    return { status: result.status, line: JSON.parse(lines.at(-1) ?? ''), stderr: result.stderr };
  } catch {
    return { status: result.status, line: null, stderr: `${result.stdout}${result.stderr}` };
  }
}

const vsix = process.argv[2];
if (vsix === undefined) {
  process.stderr.write('Usage: node scripts/engine-check.mjs <package.vsix>\n');
  process.exit(2);
}
const work = mkdtempSync(path.join(tmpdir(), 'upfly-engine-'));
const failures = [];
try {
  const zip = readFileSync(vsix);
  for (const { name } of zipEntries(zip)) {
    if (!name.startsWith('extension/engine/') || name.endsWith('/')) continue;
    const to = path.join(work, ...name.split('/'));
    mkdirSync(path.dirname(to), { recursive: true });
    writeFileSync(to, zipFile(zip, name));
  }
  const bin = path.join(work, 'extension', 'engine', 'node_modules', 'upfly', 'bin', 'upfly.cjs');
  const project = path.join(work, 'project');
  cpSync(FIXTURE, project, { recursive: true });

  const audit = lastLine(bin, ['audit'], project);
  const report = audit.line?.report;
  if (audit.status !== 0 || audit.line?.type !== 'result') {
    failures.push(`audit exited ${audit.status}: ${audit.line?.message ?? audit.stderr}`);
  } else if (!report.summary.probed || report.summary.unmeasuredAssets > 0) {
    failures.push('audit measured no image, so sharp did not load');
  } else {
    process.stdout.write(
      `audit: ${report.summary.assets} images, ${report.summary.references} references, ${report.findings.length} findings, sharp measuring\n`,
    );
  }
  const refs = lastLine(bin, ['refs', 'images/logo.png'], project);
  if (refs.status !== 0 || refs.line?.type !== 'result' || refs.line.references.length === 0) {
    failures.push(`refs exited ${refs.status}: ${refs.line?.message ?? refs.stderr}`);
  } else {
    process.stdout.write(`refs: ${refs.line.references.length} references to images/logo.png\n`);
  }
  const server = path.join(
    work,
    'extension',
    'engine',
    'node_modules',
    'upfly-mcp',
    'dist',
    'bin.js',
  );
  try {
    const { tools } = await mcpClient.listTools(process.execPath, [server, project]);
    if (!tools.includes('audit') || !tools.includes('optimize')) {
      failures.push(`the MCP server lists ${tools.join(', ')}, without audit and optimize`);
    } else {
      process.stdout.write(`MCP server: ${tools.length} tools, ${tools.join(', ')}\n`);
    }
  } catch (error) {
    failures.push(
      `the MCP server did not start: ${error instanceof Error ? error.message : error}`,
    );
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
if (failures.length > 0) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `The engine in ${path.basename(vsix)} runs on Node.js ${process.versions.node}, ${process.platform}-${process.arch}.\n`,
  );
}
