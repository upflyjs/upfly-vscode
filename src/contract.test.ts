/**
 * The runner against the real CLI, started as the extension starts it, on a copy of a fixture
 * outside the workspace: every line it hands on is checked against the schema the CLI
 * publishes for it, and the results build the views without a gap.
 */

import {
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
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MARKING_CONFIG } from '../test/integration/config-mark.mjs';
import { OLD_CONFIG } from '../test/integration/workspace.mjs';
import { agentsReport } from './agents.js';
import { auditNodes } from './audit-model.js';
import { removesOriginals } from './bundled-cli.js';
import type {
  AuditResult,
  InitResult,
  OptimizeResult,
  RefsResult,
  UndoResult,
} from './contract.js';
import { convertOldConfig } from './convert-config.js';
import { projectFolders } from './old-config-files.js';
import { onlyPattern } from './plan-model.js';
import { readConfigText } from './project-config.js';
import { refsNodes } from './refs-model.js';
import { removableOnOpen, removalArgs, removalOutcome } from './removal.js';
import { type Engine, type RunOutcome, type RunRequest, startRun } from './runner.js';
import type { WaitingOriginal } from './waiting.js';

const CLI = fileURLToPath(new URL('../node_modules/upfly/', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../test/fixtures/plain-html/', import.meta.url));

const ajv = new Ajv({ strict: true, allErrors: true, allowUnionTypes: true });
ajv.addVocabulary(['patternErrorMessage']);
for (const file of readdirSync(path.join(CLI, 'schema'))) {
  ajv.addSchema(JSON.parse(readFileSync(path.join(CLI, 'schema', file), 'utf8')), file);
}

/** The test's own Node.js, standing in for the editor's, running the published CLI this repository depends on. */
const ENGINE: Engine = {
  node: {
    kind: 'system',
    execPath: process.execPath,
    version: process.versions.node,
    // The copies sit in the temporary folder, which may be inside a git repository of its own.
    env: { GIT_CEILING_DIRECTORIES: tmpdir() },
  },
  cliBin: path.join(CLI, 'bin', 'upfly.cjs'),
};

let project = '';

beforeAll(() => {
  project = mkdtempSync(path.join(tmpdir(), 'upfly-vscode-contract-'));
  cpSync(FIXTURE, project, {
    recursive: true,
    filter: (source) => path.basename(source) !== 'node_modules',
  });
});

afterAll(() => {
  rmSync(project, { recursive: true, force: true });
});

/** Runs a command and checks every line the runner hands on against its schema. */
async function run(request: Omit<RunRequest, 'onProgress' | 'onDiagnostic'>): Promise<RunOutcome> {
  const lines: unknown[] = [];
  const outcome = await startRun(ENGINE, {
    ...request,
    onProgress: (line) => lines.push(line),
    onDiagnostic: (line) => lines.push(line),
  }).outcome;
  if (outcome.kind === 'result') lines.push(outcome.result);
  if (outcome.kind === 'stopped') lines.push(outcome.error);
  for (const line of lines) {
    const { type, command } = line as { type: string; command: string };
    const name = type === 'result' ? `${command}.json` : 'events.json';
    const validate = ajv.getSchema(name);
    if (validate === undefined || !validate(line)) {
      throw new Error(
        `${name}: ${ajv.errorsText(validate?.errors)}\n${JSON.stringify(line).slice(0, 1000)}`,
      );
    }
  }
  return outcome;
}

describe('the runner on the real CLI', () => {
  it("reads an audit's progress and result, each as its schema describes it", async () => {
    const outcome = await run({
      command: 'audit',
      args: ['--include-images', '--include-text'],
      cwd: project,
    });
    expect(outcome.kind).toBe('result');
    if (outcome.kind !== 'result') return;
    const result = outcome.result as AuditResult;
    const images = auditNodes(result).find((node) => node.icon === 'file-media');
    expect([images?.label, images?.children?.length]).toEqual([
      `${result.report.summary.assets} images`,
      result.report.summary.assets,
    ]);
    expect(result.text?.startsWith('Upfly audit')).toBe(true);
  });

  it('writes nothing into the project for the report in its own words', async () => {
    await run({ command: 'audit', args: ['--include-text'], cwd: project });
    expect(existsSync(path.join(project, '.upfly'))).toBe(false);
  });

  it("reads one image's references, each as the schema describes them", async () => {
    const outcome = await run({ command: 'refs', args: ['images/logo.png'], cwd: project });
    expect(outcome.kind).toBe('result');
    if (outcome.kind !== 'result') return;
    const result = outcome.result as RefsResult;
    expect(result.references.length).toBeGreaterThan(0);
    expect(refsNodes(result)[1]?.children?.length).toBe(result.references.length);
  });

  it("reads optimize's plan, the applied run and undo's list, each as its schema describes it", async () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'upfly-vscode-optimize-'));
    try {
      cpSync(FIXTURE, folder, { recursive: true });
      const plan = await run({ command: 'optimize', args: ['--public', '.'], cwd: folder });
      const applied = await run({
        command: 'optimize',
        args: ['--public', '.', '--apply', '--allow-dirty'],
        cwd: folder,
      });
      const listed = await run({ command: 'undo', args: ['--list'], cwd: folder });
      const undone = await run({ command: 'undo', args: [], cwd: folder });
      expect([plan.kind, applied.kind, listed.kind, undone.kind]).toEqual([
        'result',
        'result',
        'result',
        'result',
      ]);
      const listedRun = listed.kind === 'result' ? (listed.result as UndoResult).run : null;
      expect(listedRun?.id).toBe(
        applied.kind === 'result' ? (applied.result as OptimizeResult).run?.id : undefined,
      );
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  // The CLI the extension carries today cannot remove originals; a build that can runs this.
  it.skipIf(!removesOriginals({ version: '', bin: ENGINE.cliBin }))(
    'removes a kept original a line no longer needs, and keeps the one a page names, with its reason',
    async () => {
      const folder = mkdtempSync(path.join(tmpdir(), 'upfly-vscode-remove-'));
      try {
        cpSync(FIXTURE, folder, { recursive: true });
        const images = path.join(folder, 'images');
        for (const name of ['arrived.png', 'named.png']) {
          cpSync(path.join(images, 'logo.png'), path.join(images, name));
        }
        const kept = await run({
          command: 'optimize',
          args: [
            '--public',
            '.',
            ...['--apply', '--allow-dirty', '--no-undo', '--keep-originals'],
            ...['--image', 'images/arrived.png', '--image', 'images/named.png'],
          ],
          cwd: folder,
        });
        expect(kept.kind).toBe('result');
        const page = path.join(folder, 'index.html');
        const lines = '<img src="images/arrived.webp"><img src="images/named.png">\n';
        writeFileSync(page, `${readFileSync(page, 'utf8')}${lines}`);
        const stamp = (relative: string) => {
          try {
            const stats = statSync(path.join(folder, relative));
            return { size: stats.size, mtimeMs: stats.mtimeMs };
          } catch {
            return null;
          }
        };
        const waiting: WaitingOriginal[] = ['arrived', 'named', 'gone'].map((name) => ({
          folder: 'file:///project',
          original: `images/${name}.png`,
          converted: `images/${name}.webp`,
          since: '2026-10-26T10:00:00.000Z',
        }));
        const originals = waiting.map((entry) => entry.original);

        const planned = await run({
          command: 'optimize',
          args: ['--public', '.', ...removalArgs(originals, false)],
          cwd: folder,
        });
        expect(planned.kind).toBe('result');
        const plan = (planned as Extract<RunOutcome, { kind: 'result' }>).result as OptimizeResult;
        const before = removalOutcome(waiting, plan, stamp);
        expect(before.removable).toEqual(['images/arrived.png']);
        expect(before.staying.map((entry) => entry.original)).toEqual(['images/named.png']);
        expect(before.staying[0]?.reason).toMatch(/`index\.html` names it/);
        expect(before.dropped.map((entry) => entry.original)).toEqual(['images/gone.png']);
        expect(removableOnOpen(plan)).toEqual(['images/arrived.png']);

        const applied = await run({
          command: 'optimize',
          args: ['--public', '.', ...removalArgs(['images/arrived.png'], true)],
          cwd: folder,
        });
        expect(applied.kind).toBe('result');
        const result = (applied as Extract<RunOutcome, { kind: 'result' }>)
          .result as OptimizeResult;
        expect(removalOutcome(waiting.slice(0, 1), result, stamp).removed).toEqual([
          'images/arrived.png',
        ]);
        expect(existsSync(path.join(images, 'arrived.png'))).toBe(false);
        expect(existsSync(path.join(images, 'arrived.webp'))).toBe(true);
        expect(existsSync(path.join(folder, '.upfly', 'manifest.json'))).toBe(false);
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    },
  );

  it("reads init --agents's result as its schema describes it, each file it lists written", async () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'upfly-vscode-init-'));
    try {
      cpSync(FIXTURE, folder, { recursive: true });
      const outcome = await run({ command: 'init', args: ['--agents'], cwd: folder });
      expect(outcome.kind).toBe('result');
      if (outcome.kind !== 'result') return;
      const result = outcome.result as InitResult;
      const files = [...(result.agents?.instructions ?? []), ...(result.agents?.skills ?? [])];
      expect([result.file, files.map((file) => [file.file, file.action])]).toEqual([
        'upfly.config.json',
        [
          ['AGENTS.md', 'created'],
          ['.agents/skills/upfly/SKILL.md', 'created'],
          ['.claude/skills/upfly/SKILL.md', 'created'],
        ],
      ]);
      for (const file of files) expect(existsSync(path.join(folder, file.file))).toBe(true);
      expect(agentsReport(result, { folder: 'site', kept: null })).toContain(
        '  AGENTS.md  created, with the Upfly block',
      );
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("names exactly the image chosen in --only, past gitignore's depth rule and brackets", async () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'upfly-vscode-only-'));
    try {
      const logo = readFileSync(path.join(FIXTURE, 'images', 'logo.png'));
      for (const image of ['logo.png', 'src/assets/logo.png', 'app/blog/[slug]/og.png']) {
        mkdirSync(path.dirname(path.join(folder, image)), { recursive: true });
        writeFileSync(path.join(folder, image), logo);
      }
      writeFileSync(
        path.join(folder, 'index.html'),
        '<img src="logo.png">\n<img src="src/assets/logo.png">\n<img src="app/blog/[slug]/og.png">\n',
      );
      const named = async (image: string) => {
        const outcome = await run({
          command: 'optimize',
          args: ['--only', onlyPattern(image)],
          cwd: folder,
        });
        return outcome.kind === 'result' ? (outcome.result as OptimizeResult).only : null;
      };
      expect(await named('logo.png')).toEqual({ images: ['logo.png'], unmatched: [] });
      expect(await named('app/blog/[slug]/og.png')).toEqual({
        images: ['app/blog/[slug]/og.png'],
        unmatched: [],
      });
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('ends as stopped, with exit code 2, for an image the project does not have', async () => {
    const outcome = await run({ command: 'refs', args: ['no/such.png'], cwd: project });
    expect(outcome.kind === 'stopped' && outcome.error.exitCode).toBe(2);
  });

  it("ends as stopped, with exit code 3 and the CLI's reason, for the old extension's config", async () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'upfly-vscode-v2-'));
    try {
      writeFileSync(path.join(folder, 'upfly.config.json'), '{ "watchTargets": ["public"] }');
      const outcome = await run({ command: 'audit', args: [], cwd: folder });
      expect(outcome.kind === 'stopped' && [outcome.error.exitCode, outcome.error.reason]).toEqual([
        3,
        'V2_EXTENSION_CONFIG',
      ]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("audits a folder once the old extension's config there is converted, reading its watch part", async () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'upfly-vscode-converted-'));
    const config = path.join(folder, 'upfly.config.json');
    try {
      cpSync(FIXTURE, folder, { recursive: true });
      writeFileSync(config, OLD_CONFIG);
      const before = await run({ command: 'audit', args: ['--no-probe'], cwd: folder });
      const old = readConfigText(OLD_CONFIG) as Record<string, unknown>;
      const converted = convertOldConfig(old, projectFolders(folder));
      expect(converted.config.watch).toEqual({ folders: ['images'], keepOriginals: true });
      writeFileSync(config, converted.text);
      const after = await run({ command: 'audit', args: ['--no-probe'], cwd: folder });
      // The same file with a watched folder outside the project, which the CLI turns away.
      const outside = { ...converted.config, watch: { folders: ['../elsewhere'] } };
      writeFileSync(config, JSON.stringify(outside));
      const refused = await run({ command: 'audit', args: ['--no-probe'], cwd: folder });
      expect([
        before.kind === 'stopped' && before.error.reason,
        after.kind,
        refused.kind === 'stopped' && refused.error.exitCode,
        refused.kind === 'stopped' && /watch\.folders/.test(refused.error.message),
      ]).toEqual(['V2_EXTENSION_CONFIG', 'result', 2, true]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('refuses a folder holding a code config under --no-code-config, exit 3, without running it', async () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'upfly-vscode-no-code-'));
    const mark = path.join(folder, 'config-ran.txt');
    try {
      writeFileSync(path.join(folder, 'upfly.config.mjs'), MARKING_CONFIG);
      const marking: Engine = { ...ENGINE, node: { ...ENGINE.node, env: { UPFLY_MARK: mark } } };
      const outcome = await startRun(marking, {
        command: 'audit',
        args: ['--no-code-config'],
        cwd: folder,
      }).outcome;
      expect(outcome.kind === 'stopped' && [outcome.error.exitCode, outcome.error.reason]).toEqual([
        3,
        'CODE_CONFIG_NOT_RUN',
      ]);
      expect(existsSync(mark)).toBe(false);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('still reads upfly.config.json under --no-code-config, since it is data', async () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'upfly-vscode-json-config-'));
    try {
      cpSync(FIXTURE, folder, { recursive: true });
      writeFileSync(
        path.join(folder, 'upfly.config.json'),
        JSON.stringify({
          $schema: './node_modules/upfly/schema/config.json',
          publicDirs: ['images'],
        }),
      );
      const outcome = await run({ command: 'audit', args: ['--no-code-config'], cwd: folder });
      expect(
        outcome.kind === 'result' && (outcome.result as AuditResult).report.coverage.servingRoots,
      ).toEqual({ dirs: ['images'], declared: true });
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('runs a code config when it reads the folder, which is why an untrusted folder holding one is not read', async () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'upfly-vscode-code-config-'));
    const mark = path.join(folder, 'config-ran.txt');
    try {
      writeFileSync(path.join(folder, 'upfly.config.mjs'), MARKING_CONFIG);
      const marking: Engine = { ...ENGINE, node: { ...ENGINE.node, env: { UPFLY_MARK: mark } } };
      await startRun(marking, { command: 'audit', args: [], cwd: folder }).outcome;
      expect(existsSync(mark)).toBe(true);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
