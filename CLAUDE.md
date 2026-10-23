# Upfly for VS Code

Instructions for an AI coding assistant working in this repository.

This is the Upfly extension for VS Code. It runs the `upfly` command line it carries, the published package at the
exact version `package.json` names, in a child process, and reads its JSON contract (`upfly <command> --json`:
progress lines, then one result or one error line, each described by the schemas in `node_modules/upfly/schema/`). It
never reads a project itself: no second copy of the CLI's config loading, git checks, transactions or undo. What the
extension needs from the CLI goes to Upfly's own repository, `upflyjs/upfly`.

## The rules

**Quality**
- TypeScript `strict`, no `any`. Exported types are documented.
- Every module has tests, written first, one property per test. **Every bug fix adds the test that would have
  failed.**
- Biome for lint and format. Conventional commits whose body carries the reasoning. One concern per pull request.
- `npm run check` runs lint, the comment check, typecheck and the unit tests, and is run before every commit; a red
  check is never committed. The integration tests run VS Code itself: `npm run test:integration` and
  `npm run test:untrusted` (CI runs both on Windows, macOS and Linux).

**Safety**
- Nothing writes without the person's explicit action, and every refusal of the CLI reaches the person with its own
  message. Exit codes keep the CLI's meaning: 2 a usage or config error, 3 a refusal for safety, 4 a failure nobody
  anticipated.
- In a workspace VS Code does not trust, nothing runs the project's code: a folder holding `upfly.config.ts` or
  `.js` (any of the forms the CLI loads by running them) is not read.
- No network calls and no telemetry.
- Tests run on copies of the fixtures in the system's temporary folder, never on the fixtures themselves. Never create
  a folder named `public` in this repository: the old extension, still installed on some machines, converts every new
  image in such a folder.

**Tests and comments**
- Comments are written for a stranger. Comment the why, only where the code cannot say it, and document every export
  in one plain sentence, with `@param`, `@returns` and `@throws` where they help. Nothing a stranger cannot look up: no
  issue numbers or internal names; where a fact came from belongs in the commit message. Plain text: no bold, italics,
  emoji or em dashes. A comment over about ten lines is a design note for a document of its own.
- Text a person reads (command titles, view rows, notices, messages, the report) is held higher still: plain
  sentences, no internal references, no jargon the CLI does not print itself.
- Test names state the behaviour in words.
- `npm run comments:check` fails on any finding in `src`, `test` and `scripts` (the fixtures excepted) and the source
  files at the root; `README.md` and `CHANGELOG.md`, which the package ships, are held to the rules for printed text.

## Traps

- **VS Code's own terminal sets `ELECTRON_RUN_AS_NODE` and the running editor's `VSCODE_*` variables**, which would
  start a test's VS Code as plain Node.js, or point it at the running editor's pipe and caches. The launchers in
  `.vscode-test.mjs` and `scripts/untrusted-check.mjs` drop them; a new launcher must too.
- `@vscode/test-electron` always starts VS Code with `--disable-workspace-trust`, which is why the untrusted run has
  a launcher of its own.
- `vsce package --no-dependencies` leaves out a `node_modules` folder at the package's root, so the package carries
  the CLI in `engine/node_modules`, assembled by `scripts/package.mjs`.
