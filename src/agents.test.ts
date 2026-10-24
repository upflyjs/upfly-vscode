import { describe, expect, it } from 'vitest';
import { agentsReport, mcpSetup, serverLabels, setupCopied, upflyServerIn } from './agents.js';
import type { InitResult } from './contract.js';

describe('upflyServerIn', () => {
  it('finds a server named upfly, in any letter case', () => {
    expect(upflyServerIn({ Upfly: { command: 'node', args: ['server.js'] } })).toBe('Upfly');
  });

  it('finds a server under another name that runs upfly-mcp', () => {
    expect(
      upflyServerIn({ images: { command: 'npx', args: ['-y', 'upfly-mcp@3.2.0', '.'] } }),
    ).toBe('images');
  });

  it('finds a server that runs an installed copy of upfly-mcp', () => {
    expect(
      upflyServerIn({
        mine: { command: 'node', args: ['C:\\tools\\node_modules\\upfly-mcp\\dist\\bin.js'] },
      }),
    ).toBe('mine');
  });

  it('finds none among other servers, a name that only contains upfly-mcp included', () => {
    expect(
      upflyServerIn({
        github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
        other: { command: 'not-upfly-mcp', args: [] },
      }),
    ).toBeNull();
  });

  it('finds none in a value that is not a list of servers', () => {
    expect(upflyServerIn(undefined)).toBeNull();
    expect(upflyServerIn(['upfly'])).toBeNull();
  });
});

describe('serverLabels', () => {
  it("names each folder's server after the folder", () => {
    expect(serverLabels(['site', 'docs'])).toEqual(['Upfly: site', 'Upfly: docs']);
  });

  it('tells apart two folders of the same name', () => {
    expect(serverLabels(['web', 'web'])).toEqual(['Upfly: web', 'Upfly: web (2)']);
  });
});

describe('mcpSetup', () => {
  it("gives the server line upfly-mcp's README gives, under mcpServers", () => {
    expect(JSON.parse(mcpSetup('/home/me/site', 'linux'))).toEqual({
      mcpServers: { upfly: { command: 'npx', args: ['-y', 'upfly-mcp', '/home/me/site'] } },
    });
  });

  it('starts npx through cmd on Windows, which an editor cannot start npx without', () => {
    expect(JSON.parse(mcpSetup('C:\\work\\site', 'win32'))).toEqual({
      mcpServers: {
        upfly: { command: 'cmd', args: ['/c', 'npx', '-y', 'upfly-mcp', 'C:\\work\\site'] },
      },
    });
  });
});

describe('setupCopied', () => {
  it("says where Cursor's setup goes, for one project or every one", () => {
    expect(setupCopied('cursor')).toBe(
      'Copied the Upfly MCP setup for Cursor. Paste it into .cursor/mcp.json in this project, or into ~/.cursor/mcp.json for every project; in a file that already lists servers, add the upfly entry to its mcpServers.',
    );
  });

  it("says where Windsurf's setup goes, and how to open that file", () => {
    expect(setupCopied('windsurf')).toBe(
      "Copied the Upfly MCP setup for Windsurf. Paste it into Windsurf's mcp_config.json, which Open MCP config file in the Cascade panel's menu opens; in a file that already lists servers, add the upfly entry to its mcpServers.",
    );
  });
});

const RESULT: InitResult = {
  type: 'result',
  command: 'init',
  exitCode: 0,
  file: 'upfly.config.json',
  config: { $schema: './node_modules/upfly/schema/config.json', publicDirs: ['.'], format: 'webp' },
  reasons: [
    { setting: 'publicDirs', value: '.', why: '9 of 9 root-relative image paths resolve' },
    { setting: 'format', value: 'webp', why: 'the default' },
  ],
  agents: {
    instructions: [
      { file: 'AGENTS.md', action: 'created' },
      { file: 'CLAUDE.md', action: 'skipped', why: 'it imports AGENTS.md, which holds the block' },
    ],
    skills: [
      { file: '.agents/skills/upfly/SKILL.md', action: 'created' },
      { file: '.claude/skills/upfly/SKILL.md', action: 'unchanged' },
    ],
  },
};

describe('agentsReport', () => {
  it("says what was done with each file, in the CLI's own words", () => {
    const text = agentsReport(RESULT, { folder: 'site', kept: null });
    expect(text).toContain("Pointed this project's coding agents at Upfly:");
    expect(text).toContain('  AGENTS.md  created, with the Upfly block');
    expect(text).toContain(
      '  CLAUDE.md  left as it is: it imports AGENTS.md, which holds the block',
    );
    expect(text).toContain('  .agents/skills/upfly/SKILL.md  the Upfly skill, created');
    expect(text).toContain('  .claude/skills/upfly/SKILL.md  the Upfly skill, already up to date');
    expect(text).toContain(
      'These files reach the agent of everyone working on the project once they are committed.',
    );
  });

  it('shows the config written and why each setting was chosen', () => {
    const text = agentsReport(RESULT, { folder: 'site', kept: null });
    expect(text).toContain('Wrote upfly.config.json:');
    expect(text).toContain('    "publicDirs": [');
    expect(text).toContain('  .: 9 of 9 root-relative image paths resolve');
    expect(text).toContain('  format: webp, the default');
  });

  it('says a config already there was kept', () => {
    const text = agentsReport(
      { ...RESULT, file: null, config: null, reasons: [] },
      { folder: 'site', kept: 'upfly.config.ts' },
    );
    expect(text).toContain('Kept upfly.config.ts, which was already there.');
  });

  it("says the old extension's config was kept, and how to convert it", () => {
    const text = agentsReport(
      { ...RESULT, file: null, config: null, reasons: [] },
      { folder: 'site', kept: 'old' },
    );
    expect(text).toContain(
      "Kept upfly.config.json, which holds the old Upfly extension's settings, so Upfly stops before reading this folder until it is converted: run Upfly: Convert the old extension's upfly.config.json.",
    );
  });

  it('says so when nothing changed', () => {
    const unchanged = (file: string) => ({ file, action: 'unchanged' as const });
    const text = agentsReport(
      {
        ...RESULT,
        file: null,
        config: null,
        reasons: [],
        agents: { instructions: [unchanged('AGENTS.md')], skills: [unchanged('x/SKILL.md')] },
      },
      { folder: 'site', kept: 'upfly.config.json' },
    );
    expect(text).toContain('Nothing changed: the block and the skill were already up to date.');
  });

  it('names the folders Upfly could not choose between', () => {
    const text = agentsReport(
      { ...RESULT, ties: [{ dir: '', candidates: ['public', 'static'] }] },
      { folder: 'site', kept: null },
    );
    expect(text).toContain(
      '  not written: public and static resolve the root-relative paths under the project equally well, so Upfly could not choose; add the right one to publicDirs',
    );
  });
});
