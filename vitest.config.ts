import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The integration tests under test/integration run inside VS Code, through vscode-test.
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    // Some tests start the CLI on a fixture copy, which a busy machine can make several times
    // slower; the limit only has to catch a hung test.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
