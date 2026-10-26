/**
 * What people who had the old Upfly extension read once they have this one: one notice on the
 * first start after the update, a document of what changed, and what removing the old
 * settings and converting an old `upfly.config.json` did. Every sentence is true of the build
 * it ships in: the ones about new images arriving depend on `CONVERTS_NEW_IMAGES`, and the one
 * about removing the originals kept beside them on whether the CLI carried can.
 */

import type { ConvertedConfig } from './convert-config.js';

/** Every setting the old extension contributed. None of them does anything any more. */
export const OLD_SETTINGS = [
  'upfly.enabled',
  'upfly.useGlobalSettings',
  'upfly.watchTargets',
  'upfly.storageMode',
  'upfly.outputDirectory',
  'upfly.originalDirectory',
  'upfly.format',
  'upfly.quality',
  'upfly.maxFileSize',
  'upfly.inPlaceKeepOriginal',
] as const;

/** What the old extension kept in its global state, which this one inherits by its ID. */
export const OLD_STATE_KEY = 'upfly.dismissedProjects';

/** Whether this build converts new images as they arrive in a watched folder. It does. */
export const CONVERTS_NEW_IMAGES = true;

/** What the Problems panel says of an `upfly.config.json` that is the old extension's. */
export const OLD_CONFIG_PROBLEM =
  "This upfly.config.json holds the old Upfly extension's settings, which Upfly 3 does not read, so Upfly stops before reading this folder. The quick fix converts it to Upfly 3's config and keeps a copy of this file in .upfly.";

/** Where a setting is set: the person's own settings, the workspace's, or one folder's. */
export type Scope = 'user' | 'workspace' | 'folder';

/** A setting found set, and where. */
export interface SetSetting {
  readonly key: string;
  readonly scope: Scope;
  /** The folder's name, for a folder's settings. */
  readonly folder?: string;
}

/**
 * Whether this start is the first after an update from the old extension, as far as can be
 * told: one of its settings is in the person's own settings, or its state is still kept. A
 * project's settings or files say nothing of this computer, so they do not count.
 *
 * @param found how many old settings the person's own settings hold, and whether the old state is there
 */
export function isUpdate(found: { userSettings: number; oldState: boolean }): boolean {
  return found.userSettings > 0 || found.oldState;
}

/**
 * The notice shown once, on the first start after the update.
 *
 * @param options whether this build converts new images, and whether old settings are set
 */
export function noticeText(options: { convertsNewImages: boolean; oldSettings: boolean }): string {
  return [
    'Upfly is rebuilt on Upfly 3.',
    'It converts the images you choose and updates the code that uses them, with a plan first and Undo after.',
    options.convertsNewImages
      ? 'New images in a watched folder are still converted automatically, now with the code that uses them updated, and images a git pull brings in are left alone.'
      : 'This version does not convert new images as they arrive: right-click them and choose Optimize.',
    ...(options.oldSettings ? ["The old extension's settings no longer do anything."] : []),
  ].join(' ');
}

/** What the What's new document says, besides what this build does. */
export interface WhatsNewFound {
  readonly convertsNewImages: boolean;
  /** Whether the CLI this build carries can remove the originals kept beside new images. */
  readonly removesOriginals: boolean;
  /** The old settings found set. */
  readonly settings: readonly SetSetting[];
  /** The folders whose `upfly.config.json` is the old extension's. */
  readonly oldConfigs: readonly string[];
}

/**
 * The What's new document, in Markdown.
 *
 * @param found whether this build converts new images, and what of the old extension is left
 */
export function whatsNew(found: WhatsNewFound): string {
  const lines = [
    '# Upfly is rebuilt on Upfly 3',
    '',
    'The extension now runs Upfly 3, the command line tool that finds every line of code naming each image.',
    '',
    '## What it does',
    '',
    '- The Upfly view lists every image in the workspace, the code that uses each one, and what could be smaller: run Upfly: Audit workspace.',
    '- Right-click an image and choose Where is this image used? to see every line that names it.',
    '- Right-click images and choose Optimize, or run Upfly: Optimize workspace: Upfly converts them and updates every line that names them. You read the plan first, Apply is a step of its own, and Undo puts back each change, each file, or the whole run.',
    '- Broken image references show in the Problems panel.',
    '- Coding agents in VS Code get Upfly tools in each folder with an Upfly config, and Upfly: Point coding agents at Upfly writes the instructions they read.',
    ...(found.convertsNewImages ? newImages(found.removesOriginals) : []),
    '',
    '## What changed from the old extension',
    '',
    found.convertsNewImages
      ? "- Watched folders and keeping originals are set for each project, in the watch part of its upfly.config.json. The old extension's settings for them no longer do anything."
      : '- This version does not convert new images as they arrive. Right-click them and choose Optimize.',
    '- Upload to S3, Google Cloud Storage and Cloudinary is not in this version. It comes back later as its own feature, which you turn on. Until then, the old extension is there: in the Extensions view, right-click Upfly, choose Install Specific Version, and pick a version before 1.0.0.',
    '- Saving converted images in a folder of their own, the old storageMode setting, has no equivalent: Upfly 3 writes each converted image beside its original.',
    '- Converting to JPEG or PNG and choosing a quality are gone: Upfly converts to WebP, or to AVIF when the project\'s upfly.config.json says "format": "avif".',
  ];
  if (found.settings.length > 0) {
    lines.push(
      '',
      '## Your old settings',
      '',
      "The old extension's settings no longer do anything. These are set:",
      '',
      ...found.settings.map((setting) => `- ${setting.key}, in ${place(setting)}`),
      '',
      'Remove the old settings, at the top of this page, takes them out.',
    );
  }
  if (found.oldConfigs.length > 0) {
    lines.push(
      '',
      '## The old upfly.config.json',
      '',
      `Upfly 3 does not read an upfly.config.json written for the old extension, so Upfly stops before reading these folders: ${found.oldConfigs.join(', ')}.`,
      '',
      "Convert upfly.config.json, at the top of this page, writes it as Upfly 3's config with the watched folders and the keep originals choice carried over, and keeps a copy of the old file in .upfly.",
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * What removing the old settings did.
 *
 * @param removed the settings removed
 * @param left the settings left in an untrusted workspace's own settings
 */
export function removedText(removed: readonly SetSetting[], left: readonly SetSetting[]): string {
  if (removed.length === 0 && left.length === 0) return 'No setting of the old extension is set.';
  const sentences: string[] = [];
  if (removed.length > 0) sentences.push(`Removed ${byPlace(removed, 'from')}.`);
  if (left.length > 0) {
    sentences.push(
      `Left ${byPlace(left, 'in')}, which Upfly changes only in a workspace you trust.`,
    );
  }
  return sentences.join(' ');
}

/**
 * What converting an old `upfly.config.json` did, in Markdown.
 *
 * @param folder the folder's name
 * @param copy where the old file was kept, relative to the folder
 * @param converted the conversion
 */
export function convertedText(folder: string, copy: string, converted: ConvertedConfig): string {
  const list = (items: readonly string[]) =>
    items.length === 0 ? ['- Nothing.'] : items.map((item) => `- ${item}`);
  return [
    `# upfly.config.json converted for Upfly 3: ${folder}`,
    '',
    `Upfly wrote upfly.config.json as Upfly 3's config and kept the old file as ${copy}.`,
    '',
    '## Carried over',
    '',
    ...list(converted.carried),
    '',
    '## Not carried over',
    '',
    ...list(converted.dropped),
    '',
    '## The new upfly.config.json',
    '',
    '```json',
    converted.text.trimEnd(),
    '```',
    '',
    'A teammate still on the old extension gets its defaults from now on, since it cannot read this file: it watches folders named public and removes each original it converts.',
    '',
  ].join('\n');
}

/** What's new of new images arriving, in a build that converts them. */
function newImages(removesOriginals: boolean): string[] {
  return [
    '- New images in a watched folder are still converted automatically, now with the code that uses them updated, and images a git pull brings in are left alone.',
    '- Without a watch part in the project\'s upfly.config.json, every folder named public is watched, as the old extension\'s default was. "watch": { "folders": ["static"] } names the folders to watch instead, and an empty list watches none. To leave one folder out, right-click it and choose Stop watching this folder.',
    `- An image you paste or drop in the Explorer keeps only its WebP. One that arrives from outside the editor, such as an image an agent or a download wrote, keeps its original beside the WebP, since a line written later may still name it. ${
      removesOriginals
        ? 'Upfly removes that original once a line names the WebP and none names the original, and the count of originals kept, in the status bar, removes them all on a click.'
        : 'The status bar counts these originals; removing them from the editor comes with a later version of Upfly.'
    }`,
  ];
}

/** Where a setting is set, in words. */
function place(setting: SetSetting): string {
  switch (setting.scope) {
    case 'user':
      return 'your user settings';
    case 'workspace':
      return "this workspace's settings";
    case 'folder':
      return `the settings of ${setting.folder ?? 'a folder'}`;
  }
}

/** The settings grouped by where they are set: "a and b from your user settings, and c from ...". */
function byPlace(settings: readonly SetSetting[], word: 'from' | 'in'): string {
  const groups = new Map<string, string[]>();
  for (const setting of settings) {
    const where = place(setting);
    groups.set(where, [...(groups.get(where) ?? []), setting.key]);
  }
  return and(
    [...groups].map(([where, keys]) => `${and(keys)} ${word} ${where}`),
    ', and ',
  );
}

function and(items: readonly string[], last = ' and '): string {
  return items.length <= 1
    ? items.join('')
    : `${items.slice(0, -1).join(', ')}${last}${items.at(-1)}`;
}
