import { describe, expect, it } from 'vitest';
import { contentProblems } from './package.mjs';

const ENGINE = 'extension/engine/node_modules';

/** The paths a correct win32-x64 package holds, as far as the check reads them. */
const COMPLETE = [
  'extension/package.json',
  'extension/dist/extension.cjs',
  'extension/LICENSE.txt',
  `${ENGINE}/upfly/bin/upfly.cjs`,
  `${ENGINE}/upfly/dist/bin.js`,
  `${ENGINE}/upfly/schema/audit.json`,
  `${ENGINE}/upfly-core/dist/index.js`,
  `${ENGINE}/upfly-mcp/package.json`,
  `${ENGINE}/upfly-mcp/dist/bin.js`,
  `${ENGINE}/@modelcontextprotocol/server/package.json`,
  `${ENGINE}/sharp/package.json`,
  `${ENGINE}/@img/sharp-win32-x64/package.json`,
];

describe('contentProblems', () => {
  it("passes a package holding the bundle, the CLI, the MCP server and the target's sharp", () => {
    expect(contentProblems(COMPLETE, 'win32-x64')).toEqual([]);
  });

  it('says a package lacks the MCP server', () => {
    const names = COMPLETE.filter((name) => !name.includes('/upfly-mcp/'));
    expect(contentProblems(names, 'win32-x64')).toEqual([
      `it lacks ${ENGINE}/upfly-mcp/package.json`,
      `it lacks ${ENGINE}/upfly-mcp/dist/bin.js`,
    ]);
  });

  it('says a package holds a second CLI inside the MCP server, which the server would run', () => {
    expect(
      contentProblems(
        [...COMPLETE, `${ENGINE}/upfly-mcp/node_modules/upfly/package.json`],
        'win32-x64',
      ),
    ).toEqual(['it holds a second upfly inside upfly-mcp, which the MCP server would run']);
  });

  it("says a package holds another platform's sharp", () => {
    expect(
      contentProblems([...COMPLETE, `${ENGINE}/@img/sharp-linux-x64/package.json`], 'win32-x64'),
    ).toEqual(["it holds another platform's sharp-linux-x64"]);
  });
});
