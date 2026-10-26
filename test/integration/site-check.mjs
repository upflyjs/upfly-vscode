// @ts-check
/**
 * The exit test's instruments, which share no code with the engine they check: each
 * fixture's own build, and a check that every local path an emitted HTML, CSS or JavaScript
 * file names resolves on disk. The link check is the one Upfly's own fixture build uses, so
 * the two agree on what intact means.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Upfly's six fixtures: each one's build command, where the build emits the site, and the
 * folder its config names as served when Upfly cannot work it out by itself.
 *
 * @type {Record<string, { build: string | null, output: string, publicDirs?: string[] }>}
 */
export const FIXTURES = {
  astro: { build: 'astro build', output: 'dist' },
  eleventy: { build: 'eleventy', output: '_site', publicDirs: ['src'] },
  'next-app': { build: 'next build', output: 'out' },
  'partial-pattern': { build: null, output: '.' },
  'plain-html': { build: null, output: '.', publicDirs: ['.'] },
  'vite-react': { build: 'vite build', output: 'dist' },
};

/**
 * The fixtures of the watcher's exit test: two whose folders named public are watched by
 * default, and plain-html watching the whole project. For each, the page that names its new
 * images, the watched folder they arrive in, and how the page writes that folder's paths.
 *
 * @type {Record<string, { page: string, folder: string, served: string, watch?: string[] }>}
 */
export const WATCH_EXIT = {
  'vite-react': { page: 'index.html', folder: 'public/photos', served: '/photos/' },
  astro: { page: 'src/pages/index.astro', folder: 'public/covers', served: '/covers/' },
  'plain-html': { page: 'index.html', folder: 'images', served: 'images/', watch: ['.'] },
};

/** Build outputs, dependencies and caches, never copied and never walked. */
export const NEVER_COPY = new Set([
  'node_modules',
  'dist',
  '_site',
  '.next',
  'out',
  'build',
  '.astro',
  '.cache',
  '.git',
  '.upfly',
]);

/** A reference a fixture leaves dangling on purpose names itself so. */
const DELIBERATE = /missing-on-purpose|does-not-exist/;

/**
 * Every local path an HTML, CSS or JavaScript file under a folder names that does not
 * resolve, as `file -> path`.
 *
 * @param {string} root the emitted site
 * @returns {string[]}
 */
export function danglingPaths(root) {
  const found = [];
  for (const file of walk(root)) {
    const extension = path.extname(file).toLowerCase();
    const markup = extension === '.html' || extension === '.css';
    if (!markup && extension !== '.js' && extension !== '.mjs') continue;
    const active = withoutComments(readFileSync(path.join(root, file), 'utf8'), extension);
    for (const raw of markup ? candidatePaths(active) : bundledPaths(active)) {
      if (DELIBERATE.test(raw)) continue;
      const target = raw.startsWith('/')
        ? path.join(root, raw.slice(1))
        : path.join(root, path.dirname(file), raw);
      if (!existsSync(target)) found.push(`${file} -> ${raw}`);
    }
  }
  return found.sort();
}

/**
 * The files under a folder, as paths relative to it with `/`.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function walk(root) {
  /** @type {string[]} */
  const files = [];
  /** @param {string} dir */
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.upfly')
      )
        continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else files.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  visit(root);
  return files;
}

/**
 * A file's text with its comments blanked to spaces, so what they name is not checked.
 *
 * @param {string} text
 * @param {string} extension
 */
function withoutComments(text, extension) {
  const comment = extension === '.html' ? /<!--[\s\S]*?-->/g : /\/\*[\s\S]*?\*\//g;
  return text.replace(comment, (match) => ' '.repeat(match.length));
}

/** @param {string} text */
function candidatePaths(text) {
  /** @type {string[]} */
  const found = [];
  for (const match of text.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi))
    add(found, match[1]);
  // A srcset or image-set holds a list of candidates, each a path and a descriptor.
  for (const match of text.matchAll(/\b(?:srcset|image-set)\s*[=(]\s*["']?([^"'>)]+)/gi)) {
    for (const candidate of (match[1] ?? '').split(',')) {
      const value = candidate
        .trim()
        .split(/\s+/)[0]
        ?.replace(/^["']|["']$/g, '');
      // The url() scanner below reads that spelling in full.
      if (value?.includes('url(')) continue;
      add(found, value);
    }
  }
  for (const match of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) add(found, match[1]);
  return found;
}

/**
 * Image paths in an emitted bundle, where a compiled component holds them as strings.
 *
 * @param {string} text
 */
function bundledPaths(text) {
  /** @type {string[]} */
  const found = [];
  for (const match of text.matchAll(
    /[./][A-Za-z0-9_@./+-]*\.(?:png|jpe?g|gif|svg|webp|avif|ico)\b/gi,
  )) {
    add(found, match[0]);
  }
  return found;
}

/**
 * @param {string[]} found
 * @param {string | undefined} candidate
 */
function add(found, candidate) {
  const value = candidate?.trim();
  if (value === undefined || value === '') return;
  // A scheme, a protocol-relative address, a fragment or a template names nothing on disk.
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//') || value.startsWith('#')) return;
  if (value.startsWith('?') || value.includes('{{') || value.includes('${')) return;
  found.push(value.split('#')[0]?.split('?')[0] ?? value);
}
