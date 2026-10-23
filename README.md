# Upfly for VS Code

The Upfly extension, rebuilt on [Upfly 3](https://github.com/upflyjs/upfly). This is a development version and is
not published yet; the extension published as version 0.0.x is on the `v0` branch.

What it does so far, without changing any file:

- Upfly: Audit workspace reads every workspace folder and shows, in the Upfly view, its images and references, what
  could be smaller, and what is broken, unused, possibly unused, copied or oversized. Choosing a row opens the file
  at its line.
- Upfly: Show report opens the audit as a document.
- Upfly: Where is this image used? (in the Explorer's menu on an image, and in the Command Palette) lists every
  reference to the image, the other lines that name it, and what `upfly optimize` would do with it.

It runs the `upfly` command line it carries, on the editor's own Node.js, or on a Node.js 22 or later found on the
computer when the editor's own is older. In a workspace you have not trusted, it runs none of the project's code: a
folder with an `upfly.config.ts` or `upfly.config.js` is not read until you trust the workspace.

## Working on it

```sh
npm install
npm run check              # lint, the comment check, typecheck, unit tests
npm run test:integration   # the extension in a real VS Code, downloaded for the test
npm run test:untrusted     # the same in a workspace VS Code does not trust
npm run package -- linux-x64   # one package; the targets are listed in scripts/package.mjs
```
