import { describe, expect, it } from 'vitest';
import type { ErrorLine } from './contract.js';
import { codeConfigRefusal, trustArgs } from './trust.js';

const refusal = (message: string, reason = 'CODE_CONFIG_NOT_RUN'): ErrorLine => ({
  type: 'error',
  command: 'audit',
  exitCode: 3,
  reason,
  message,
});

describe('trustArgs', () => {
  it('adds nothing in a trusted workspace', () => {
    expect(trustArgs(true)).toEqual([]);
  });

  it('tells the CLI to run no code config in an untrusted one', () => {
    expect(trustArgs(false)).toEqual(['--no-code-config']);
  });
});

describe('codeConfigRefusal', () => {
  it('says in editor terms why the folder was not read, naming the config the CLI named', () => {
    expect(
      codeConfigRefusal(
        refusal(
          'upfly.config.mjs is a config written as code, and --no-code-config says to run no code from the project, so it was not read and nothing was done.',
        ),
      ),
    ).toBe(
      'This workspace is not trusted, and reading upfly.config.mjs would run code from the project. Trust the workspace to let Upfly read this folder.',
    );
  });

  it('still says why when the message names no file it recognises', () => {
    expect(codeConfigRefusal(refusal('A config written as code was not run.'))).toBe(
      'This workspace is not trusted, and reading its config would run code from the project. Trust the workspace to let Upfly read this folder.',
    );
  });

  it('leaves every other stop to its own message', () => {
    expect(codeConfigRefusal(refusal('Another run is in progress.', 'TRANSACTION_LOCKED'))).toBe(
      null,
    );
  });
});
