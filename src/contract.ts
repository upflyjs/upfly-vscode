/**
 * The lines `upfly <command> --json` prints, as far as the extension reads them. The CLI
 * ships a JSON Schema for each in `upfly/schema/`, and the tests check the CLI's real output
 * against those schemas, so these types only name the fields the extension uses.
 */

/** A command the extension runs. */
export type CommandName = 'audit' | 'refs' | 'optimize' | 'undo' | 'init';

/** One stage of a run finished, with what it counted. */
export type ProgressLine = {
  readonly type: 'progress';
  readonly command: string;
} & (
  | { readonly stage: 'discovered'; readonly images: number; readonly files: number }
  | { readonly stage: 'scanned'; readonly references: number }
  | { readonly stage: 'resolved'; readonly linked: number }
  | { readonly stage: 'measuring'; readonly done: number; readonly total: number }
  | { readonly stage: 'measured'; readonly images: number }
  | { readonly stage: 'audited'; readonly findings: number }
  | { readonly stage: 'planned'; readonly conversions: number; readonly rewrites: number }
  | { readonly stage: 'written'; readonly files: number }
);

/** What an image or parsing library said about one file, in its own words. */
export interface DiagnosticLine {
  readonly type: 'diagnostic';
  readonly command: string;
  readonly source: 'image' | 'parser';
  readonly asset?: string;
  readonly relative?: string;
  readonly detail: string;
}

/** Why a command stopped, in place of its result. */
export interface ErrorLine {
  readonly type: 'error';
  readonly command: string | null;
  /** 2: the command line or the config is wrong; 3: refused for safety; 4: unanticipated. */
  readonly exitCode: 2 | 3 | 4;
  /** A stable name to branch on, such as `V2_EXTENSION_CONFIG`; absent for some stops. */
  readonly reason?: string;
  /** What happened and what to do about it, in sentences. */
  readonly message: string;
  /** The one file the stop is about, relative to the project, such as the config it would not run. */
  readonly file?: string;
}

/** A path and line in the project, counted from 1, or null when the line is not known. */
export interface Located {
  readonly file: string;
  readonly line: number | null;
}

/** A finding in the report. */
export type Finding =
  | {
      readonly kind: 'dead';
      readonly asset: string;
      readonly bytes: number;
      readonly inPublicDir: boolean;
    }
  | {
      readonly kind: 'possibly-dead';
      readonly asset: string;
      readonly bytes: number;
      readonly inPublicDir: boolean;
      readonly evidence: readonly Mention[];
    }
  | {
      readonly kind: 'broken';
      readonly file: string;
      readonly line: number | null;
      readonly where: string;
      readonly rawPath: string;
      readonly note?: string;
    }
  | {
      readonly kind: 'serving-root-unknown';
      readonly linked: number;
      readonly checkable: number;
      readonly suppressedBroken: number;
    }
  | {
      readonly kind: 'oversized';
      readonly asset: string;
      readonly bytes: number;
      readonly width: number | null;
      readonly height: number | null;
      readonly exceeded: readonly ('bytes' | 'width' | 'height')[];
    }
  | {
      readonly kind: 'format-opportunity';
      readonly asset: string;
      readonly to: 'webp' | 'avif';
      readonly bytes: number;
      readonly wouldBe: number;
      readonly savedBytes: number;
      readonly savedPercent: number;
    }
  | {
      readonly kind: 'duplicate';
      readonly assets: readonly string[];
      readonly bytes: number;
      readonly wastedBytes: number;
    };

/** Where an image's name appears outside a reference Upfly follows. */
export interface Mention {
  readonly asset: string;
  readonly where: string;
  readonly quote: string;
}

/** A reference Upfly never rewrites, with why. */
export interface UnsafeReference {
  readonly file: string;
  readonly rawPath: string;
  readonly resolution: string;
  readonly reason: string;
}

/** The report inside audit's result, as far as the extension reads it. */
export interface Report {
  readonly summary: {
    readonly assets: number;
    readonly assetBytes: number;
    readonly sourceFiles: number;
    readonly references: number;
    readonly linkedReferences: number;
    readonly referencedAssets: number;
    readonly potentialSavingBytes: number;
    readonly probed: boolean;
    readonly unmeasuredAssets: number;
  };
  readonly findings: readonly Finding[];
  readonly unusedVectors: { readonly count: number; readonly bytes: number };
  readonly keptOriginals: {
    readonly count: number;
    readonly bytes: number;
    readonly assets: readonly { readonly asset: string; readonly convertedTo: string }[];
  };
  readonly references: {
    readonly unsafe: readonly UnsafeReference[];
    readonly leftOut: readonly UnsafeReference[];
  };
  readonly coverage: {
    readonly unscannedExtensions: readonly { readonly ext: string; readonly fileCount: number }[];
    readonly excludedRoots: readonly { readonly path: string; readonly reason: string }[];
    readonly servingRoots: { readonly dirs: readonly string[]; readonly declared: boolean };
  };
  readonly skipped: readonly {
    readonly what: string;
    readonly stage: string;
    readonly reason: string;
  }[];
  readonly caveats: readonly { readonly code: string; readonly message: string }[];
}

/** One image `optimize` would convert. */
export interface Conversion {
  readonly asset: string;
  readonly target: string;
  readonly format: 'webp' | 'avif';
  readonly savedBytes: number;
  /** The original is removed once no file Upfly reads still names it. */
  readonly replacesOriginal: boolean;
  /** The original sits in a folder the site is served from, where an outside link can name it. */
  readonly inPublicDir: boolean;
}

/** One path re-spelled in a file. Offsets count the file's text in UTF-16 code units. */
export interface Edit {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
  /** The path as written, which the edit replaces. */
  readonly expected?: string;
  /** The path is inside a comment, which no page loads. */
  readonly inComment?: true;
  /** The image the path names before the run. */
  readonly asset?: string;
}

/** The edits to one file, and the hash of the text they were planned on. */
export interface Rewrite {
  readonly file: string;
  readonly edits: readonly Edit[];
  /** SHA-256 of the file's text as Upfly read it, in hexadecimal. */
  readonly textHash?: string;
}

/** What `optimize` converts and rewrites, and what it decided against. */
export interface Plan {
  readonly conversions: readonly Conversion[];
  readonly rewrites: readonly Rewrite[];
  readonly declined: readonly {
    readonly path: string;
    readonly line: number | null;
    readonly reason: string;
  }[];
  /** Converted images whose original stays anyway, and why. */
  readonly keptOriginals: readonly { readonly asset: string; readonly reason: string }[];
}

/** The last line of `upfly optimize --json`, a dry run or an applied one. */
export interface OptimizeResult {
  readonly type: 'result';
  readonly command: 'optimize';
  readonly exitCode: 0;
  readonly apply: boolean;
  readonly plan: Plan;
  /** What an applied run wrote, or null when it wrote nothing. */
  readonly run: {
    readonly id: string;
    readonly created: readonly string[];
    readonly changed: readonly string[];
    readonly removed: readonly string[];
  } | null;
  readonly commit: string | null;
  readonly only: {
    readonly images: readonly string[];
    readonly unmatched: readonly string[];
  } | null;
  /** Sentences about the run, such as what `--apply` would refuse. */
  readonly notes: readonly string[];
  readonly report: Report;
}

/** One path a run rewrote on a line. */
export interface RunPath {
  readonly before: string;
  /** null only for a run an older Upfly recorded, when the file no longer holds it. */
  readonly after: string | null;
  /** The image `before` names, or null for a run an older Upfly recorded. */
  readonly image: string | null;
  readonly inComment: boolean;
}

/** One line a run changed. */
export interface RunChange {
  /** Counted from 1 in the file as the run left it; null only for an older Upfly's run. */
  readonly line: number | null;
  /** null when the file changed since, so its state cannot be told. */
  readonly undone: boolean | null;
  readonly paths: readonly RunPath[];
}

/** One file a run rewrote. */
export interface RunFile {
  readonly path: string;
  /** Something other than the run changed it since, so none of its changes undo alone. */
  readonly changedSince: boolean;
  readonly changes: readonly RunChange[];
}

/** What the last run changed, as `upfly undo --list --json` lists it. */
export interface RunList {
  readonly id: string;
  readonly startedAt: string;
  readonly state: 'applied' | 'undone' | 'interrupted';
  readonly files: readonly RunFile[];
  readonly originals: readonly {
    readonly path: string;
    readonly movedTo: string | null;
    readonly back: boolean;
    readonly changedSince: boolean;
  }[];
  readonly created: readonly string[];
}

/** The last line of `upfly undo --json`. */
export interface UndoResult {
  readonly type: 'result';
  readonly command: 'undo';
  readonly exitCode: 0;
  /** What was put back, or null when nothing was. */
  readonly undone: {
    readonly id: string;
    readonly restored: readonly string[];
    readonly reverted: readonly string[];
    readonly removed: readonly string[];
    readonly moved: readonly { readonly from: string; readonly to: string }[];
  } | null;
  readonly part: { readonly file: string; readonly line: number | null } | null;
  readonly commit: string | null;
  readonly notes: readonly string[];
  /** With `--list` only: the last run, or null when no run has written to the project. */
  readonly run?: RunList | null;
}

/** The last line of `upfly audit --json`. */
export interface AuditResult {
  readonly type: 'result';
  readonly command: 'audit';
  readonly exitCode: 0;
  readonly report: Report;
  /** What `optimize` would convert and save, or null when it was not measured. */
  readonly savings: {
    readonly images: number;
    readonly bytes: number;
    readonly savedBytes: number;
    readonly unmeasured: number;
    readonly conversions: readonly Conversion[];
  } | null;
  /** With `--include-text` only: the report in the CLI's own words. */
  readonly text?: string;
  /** With `--include-images` only: every image with each reference that links it. */
  readonly images?: readonly AuditImage[];
}

/** One image of `audit --include-images`. */
export interface AuditImage {
  readonly path: string;
  readonly bytes: number;
  readonly references: readonly {
    readonly file: string;
    readonly line: number | null;
    readonly text: string;
  }[];
  readonly findings: readonly (
    | 'dead'
    | 'possibly-dead'
    | 'oversized'
    | 'format-opportunity'
    | 'duplicate'
  )[];
}

/** Why Upfly does not follow a line that names an image's path. */
export type UnfollowedReason =
  | 'full-address'
  | 'built-at-runtime'
  | 'data-or-props'
  | 'unread-file-type'
  | 'comment'
  | 'folder'
  | 'other';

/** The last line of `upfly refs <image> --json`. */
export interface RefsResult {
  readonly type: 'result';
  readonly command: 'refs';
  readonly exitCode: 0;
  readonly image: string;
  readonly bytes: number;
  readonly references: readonly (Located & {
    readonly text: string;
    readonly rewritable: boolean;
    readonly why?: string;
  })[];
  readonly unfollowed: readonly {
    readonly file: string;
    readonly line: number;
    readonly text: string;
    readonly reason: UnfollowedReason;
    readonly why: string;
    readonly loads: boolean;
    readonly host?: string;
  }[];
  readonly unsearchable?: readonly { readonly file: string; readonly reason: string }[];
  readonly verdict:
    | {
        readonly kind: 'converts';
        readonly to: string;
        readonly savedBytes: number;
        readonly removesOriginal: boolean;
      }
    | { readonly kind: 'not-converted'; readonly why: string }
    | { readonly kind: 'unused' }
    | {
        readonly kind: 'possibly-unused';
        readonly mentions: readonly { readonly where: string; readonly quote: string }[];
      };
}

/** What `upfly init --agents` did with one file it points the coding agents at. */
export interface AgentFile {
  /** Relative to the project. */
  readonly file: string;
  readonly action: 'created' | 'added' | 'updated' | 'unchanged' | 'skipped';
  /** Why a file was skipped. */
  readonly why?: string;
}

/** The last line of `upfly init --json`. */
export interface InitResult {
  readonly type: 'result';
  readonly command: 'init';
  readonly exitCode: 0;
  /** The config written, or null when one was already there and was kept. */
  readonly file: 'upfly.config.json' | null;
  /** What the config written holds. */
  readonly config: Readonly<Record<string, unknown>> | null;
  /** Why each setting was written, or left out. */
  readonly reasons: readonly {
    readonly setting: string;
    readonly value: string | null;
    readonly why: string;
  }[];
  /** Folders Upfly could not choose between, none of them written. */
  readonly ties?: readonly { readonly dir: string; readonly candidates: readonly string[] }[];
  /** With `--agents`: each instruction file and copy of the Upfly skill, and what was done. */
  readonly agents?: {
    readonly instructions: readonly AgentFile[];
    readonly skills: readonly AgentFile[];
  };
}

/** A command's result line. */
export type ResultLine = AuditResult | RefsResult | OptimizeResult | UndoResult | InitResult;
