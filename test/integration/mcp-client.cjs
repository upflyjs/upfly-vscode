// @ts-check
/**
 * Just enough of an MCP client to start a server and list its tools, over the server's standard
 * input and output: `initialize`, the `notifications/initialized` notice, then `tools/list`, each
 * a JSON-RPC message on a line of its own, as the MCP specification's stdio transport sends them.
 */
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');

/**
 * Starts an MCP server, lists its tools, and closes it.
 *
 * @param {string} command the program that starts the server
 * @param {readonly string[]} args its arguments
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number }} [options]
 * @returns {Promise<{ server: { name?: string, version?: string }, tools: string[] }>}
 */
async function listTools(command, args, options = {}) {
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-4000);
  });
  /** @type {Map<number, (message: any) => void>} */
  const waiting = new Map();
  createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      const message = JSON.parse(line);
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    } catch {
      // A line that is not JSON-RPC, such as a log line, answers nothing.
    }
  });
  const exited = new Promise((resolve) => child.once('close', resolve));
  const failed = new Promise((_, reject) => {
    child.once('error', reject);
    child.once('close', (code) =>
      reject(new Error(`the server exited with ${code} before it answered: ${stderr}`)),
    );
  });
  // It also settles when the server exits after answering, which is no failure.
  failed.catch(() => undefined);
  let next = 1;
  /** @param {string} method @param {object} params */
  const request = (method, params) => {
    const id = next++;
    const answer = new Promise((resolve) => waiting.set(id, resolve));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return Promise.race([answer, failed]);
  };
  const timeout = setTimeout(() => child.kill(), options.timeoutMs ?? 60_000);
  try {
    const started = await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'upfly-vscode-tests', version: '0.0.0' },
    });
    if (started.error) throw new Error(`initialize: ${started.error.message}`);
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    const listed = await request('tools/list', {});
    if (listed.error) throw new Error(`tools/list: ${listed.error.message}`);
    return {
      server: started.result.serverInfo ?? {},
      tools: listed.result.tools.map((/** @type {{ name: string }} */ tool) => tool.name),
    };
  } finally {
    clearTimeout(timeout);
    // The server serves until its input closes.
    child.stdin.end();
    await exited;
  }
}

module.exports = { listTools };
