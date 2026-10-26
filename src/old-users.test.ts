import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { convertOldConfig } from './convert-config.js';
import {
  CONVERTS_NEW_IMAGES,
  OLD_CONFIG_PROBLEM,
  OLD_SETTINGS,
  convertedText,
  isUpdate,
  noticeText,
  removedText,
  whatsNew,
} from './old-users.js';

describe('OLD_SETTINGS', () => {
  it('names the ten settings the old extension contributed', () => {
    expect(OLD_SETTINGS).toEqual([
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
    ]);
  });

  it('holds no setting this extension contributes, so removing them takes nothing of its own', () => {
    const manifest = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')) as {
      contributes: { configuration?: { properties?: Record<string, unknown> } };
    };
    const own = Object.keys(manifest.contributes.configuration?.properties ?? {});
    expect(OLD_SETTINGS.filter((key) => own.includes(key))).toEqual([]);
  });
});

describe('isUpdate', () => {
  it("takes a setting of the old extension in the person's own settings for an update", () => {
    expect(isUpdate({ userSettings: 1, oldState: false })).toBe(true);
  });

  it('takes what the old extension kept in its own state for an update', () => {
    expect(isUpdate({ userSettings: 0, oldState: true })).toBe(true);
  });

  it('takes neither for a fresh install', () => {
    expect(isUpdate({ userSettings: 0, oldState: false })).toBe(false);
  });
});

describe('noticeText', () => {
  it('says the extension is rebuilt and what it does now, each sentence true of this build', () => {
    expect(noticeText({ convertsNewImages: false, oldSettings: false })).toBe(
      'Upfly is rebuilt on Upfly 3. It converts the images you choose and updates the code that uses them, with a plan first and Undo after. This version does not convert new images as they arrive: right-click them and choose Optimize.',
    );
  });

  it('says the old settings do nothing, when some are set', () => {
    expect(noticeText({ convertsNewImages: false, oldSettings: true })).toMatch(
      / The old extension's settings no longer do anything\.$/,
    );
  });

  it('says new images are converted again, and nothing else of them, once this build does', () => {
    const text = noticeText({ convertsNewImages: true, oldSettings: false });
    expect(text).toContain(
      'New images in a watched folder are still converted automatically, now with the code that uses them updated, and images a git pull brings in are left alone.',
    );
    expect(text).not.toContain('does not convert new images');
  });

  it('is on in this build, which converts new images as they arrive', () => {
    expect(CONVERTS_NEW_IMAGES).toBe(true);
  });
});

describe('whatsNew', () => {
  const none = { removesOriginals: false, settings: [], oldConfigs: [] };
  const today = whatsNew({ ...none, convertsNewImages: false });
  const now = whatsNew({ ...none, convertsNewImages: true });

  it('says upload comes back later, and how to keep the old extension meanwhile', () => {
    expect(today).toContain(
      '- Upload to S3, Google Cloud Storage and Cloudinary is not in this version. It comes back later as its own feature, which you turn on. Until then, the old extension is there: in the Extensions view, right-click Upfly, choose Install Specific Version, and pick a version before 1.0.0.',
    );
  });

  it('says the separate output folder has no equivalent', () => {
    expect(today).toContain(
      '- Saving converted images in a folder of their own, the old storageMode setting, has no equivalent: Upfly 3 writes each converted image beside its original.',
    );
  });

  it('says this version does not convert new images, and promises nothing of the watcher', () => {
    expect(today).toContain('- This version does not convert new images as they arrive.');
    expect(today).not.toContain('converted automatically');
  });

  it('says new images are converted again once this build does', () => {
    expect(now).toContain('converted automatically');
    expect(now).not.toContain('does not convert new images');
  });

  it('says which folders are watched without a watch part, how to name others or none, and how to leave one out', () => {
    expect(now).toContain(
      `- Without a watch part in the project's upfly.config.json, every folder named public is watched, as the old extension's default was. "watch": { "folders": ["static"] } names the folders to watch instead, and an empty list watches none. To leave one folder out, right-click it and choose Stop watching this folder.`,
    );
  });

  it('says a paste keeps only its WebP and an image from outside keeps its original, and what removes it', () => {
    const paste =
      '- An image you paste or drop in the Explorer keeps only its WebP. One that arrives from outside the editor, such as an image an agent or a download wrote, keeps its original beside the WebP, since a line written later may still name it.';
    expect(now).toContain(
      `${paste} The status bar counts these originals; removing them from the editor comes with a later version of Upfly.`,
    );
    expect(whatsNew({ ...none, convertsNewImages: true, removesOriginals: true })).toContain(
      `${paste} Upfly removes that original once a line names the WebP and none names the original, and the count of originals kept, in the status bar, removes them all on a click.`,
    );
  });

  it("says watched folders and keeping originals moved into the project's config", () => {
    expect(now).toContain(
      "- Watched folders and keeping originals are set for each project, in the watch part of its upfly.config.json. The old extension's settings for them no longer do anything.",
    );
    expect(today).not.toContain('Watched folders and keeping originals are set');
  });

  it('lists each old setting where it is set', () => {
    const text = whatsNew({
      ...none,
      convertsNewImages: false,
      settings: [
        { key: 'upfly.watchTargets', scope: 'user' },
        { key: 'upfly.quality', scope: 'workspace' },
        { key: 'upfly.storageMode', scope: 'folder', folder: 'site' },
      ],
      oldConfigs: [],
    });
    expect(text).toContain('- upfly.watchTargets, in your user settings');
    expect(text).toContain("- upfly.quality, in this workspace's settings");
    expect(text).toContain('- upfly.storageMode, in the settings of site');
  });

  it("names the folders whose upfly.config.json is the old extension's", () => {
    const text = whatsNew({ ...none, convertsNewImages: false, oldConfigs: ['site'] });
    expect(text).toContain(
      'Upfly 3 does not read an upfly.config.json written for the old extension, so Upfly stops before reading these folders: site.',
    );
  });

  it('has no section for settings or configs when there are none', () => {
    expect(today).not.toContain('## Your old settings');
    expect(today).not.toContain('## The old upfly.config.json');
  });
});

describe('removedText', () => {
  it('says what was removed from where', () => {
    expect(
      removedText(
        [
          { key: 'upfly.watchTargets', scope: 'user' },
          { key: 'upfly.enabled', scope: 'user' },
          { key: 'upfly.storageMode', scope: 'folder', folder: 'site' },
        ],
        [],
      ),
    ).toBe(
      'Removed upfly.watchTargets and upfly.enabled from your user settings, and upfly.storageMode from the settings of site.',
    );
  });

  it("says what was left in an untrusted workspace's settings, and why", () => {
    expect(
      removedText(
        [{ key: 'upfly.enabled', scope: 'user' }],
        [{ key: 'upfly.quality', scope: 'workspace' }],
      ),
    ).toBe(
      "Removed upfly.enabled from your user settings. Left upfly.quality in this workspace's settings, which Upfly changes only in a workspace you trust.",
    );
  });

  it('says so when no old setting is set', () => {
    expect(removedText([], [])).toBe('No setting of the old extension is set.');
  });
});

describe('OLD_CONFIG_PROBLEM', () => {
  it('says why Upfly stops in the folder, and what the quick fix does', () => {
    expect(OLD_CONFIG_PROBLEM).toBe(
      "This upfly.config.json holds the old Upfly extension's settings, which Upfly 3 does not read, so Upfly stops before reading this folder. The quick fix converts it to Upfly 3's config and keeps a copy of this file in .upfly.",
    );
  });
});

describe('convertedText', () => {
  it('says where the old file is kept, what was carried, what was not, and shows the new file', () => {
    const converted = convertOldConfig(
      { watchTargets: [{ path: 'public', quality: 80 }], inPlaceKeepOriginal: true },
      ['public'],
    );
    const text = convertedText('site', '.upfly/old-extension-upfly.config.json', converted);
    expect(text).toContain(
      "Upfly wrote upfly.config.json as Upfly 3's config and kept the old file as .upfly/old-extension-upfly.config.json.",
    );
    expect(text).toContain('- Watched folders: public.');
    expect(text).toContain('- quality: Upfly 3 has no quality setting.');
    expect(text).toContain(converted.text.trimEnd());
    expect(text).toContain(
      'A teammate still on the old extension gets its defaults from now on, since it cannot read this file: it watches folders named public and removes each original it converts.',
    );
  });
});
