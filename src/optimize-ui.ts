/**
 * Converting images: "Optimize" on the images a person chooses, and "Optimize workspace" for
 * every image in a folder. Each first runs `upfly optimize` without `--apply` and shows the
 * plan as a read-only document; Apply is a separate step. The CLI plans again when it applies,
 * so before applying, the files the plan names are checked against the plan, and when one
 * changed the folder is planned again and shown rather than applied.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import type { OptimizeResult, Plan } from './contract.js';
import type { Host, HostOutcome } from './host.js';
import {
  type PlanScope,
  onlyPattern,
  renderPlan,
  servedOriginals,
  textHash,
} from './plan-model.js';
import { type StepAction, nextStep } from './refusals.js';
import { UNTRUSTED_WRITE } from './trust.js';

/** The plan documents' URI scheme. */
export const PLAN_SCHEME = 'upfly-plan';
const IMAGE = /\.(avif|gif|jpe?g|png|svg|tiff?|webp)$/i;

/** Where a folder's plan stands. */
export type PlanPhase = 'planning' | 'ready' | 'applying' | 'applied' | 'stopped';

/** One folder's plan. */
interface PlanState {
  readonly folder: vscode.WorkspaceFolder;
  readonly scope: PlanScope;
  readonly keepOriginals: boolean;
  /** A folder the site is served from, chosen for this plan alone and given as `--public`. */
  readonly publicDir: string | null;
  when: Date;
  phase: PlanPhase;
  result: OptimizeResult | null;
  /** Each rewritten file's text when the plan arrived. */
  texts: Map<string, string | null>;
  /** Each image to convert, as its size and modification time when the plan arrived. */
  stamps: Map<string, string>;
  banner: string[];
  /** Buttons for the last refusal. */
  actions: readonly StepAction[];
  runId: string | null;
  /** Stops this plan's own run, whether it is running or still waiting in the queue. */
  abort: AbortController | null;
}

/** What a plan command gives back: read by the extension's tests, not a public API. */
export interface PlanOutcome {
  readonly phase: PlanPhase;
  readonly text: string;
  readonly runId: string | null;
  readonly reason?: string;
}

/** What the plan part needs from the review part. */
export interface ReviewHook {
  /** Reads the folder's last run again and shows its review. */
  show(folder: vscode.WorkspaceFolder, reveal: boolean): Promise<void>;
}

/**
 * Registers the optimize commands, the plan documents and their buttons.
 *
 * @param context the extension's context
 * @param host the shared runner and log
 * @param review the review, opened after a run applies
 * @returns the plans by folder, for the extension's tests
 */
export function registerOptimize(
  context: vscode.ExtensionContext,
  host: Host,
  review: ReviewHook,
): (folder: vscode.Uri) => PlanOutcome | undefined {
  const plans = new Map<string, PlanState>();
  const changed = new vscode.EventEmitter<vscode.Uri>();
  const lensesChanged = new vscode.EventEmitter<void>();

  const uriOf = (folder: vscode.WorkspaceFolder): vscode.Uri =>
    vscode.Uri.from({
      scheme: PLAN_SCHEME,
      path: `/${folder.name}/Upfly plan.md`,
      query: folder.uri.toString(),
    });
  const stateOf = (target: unknown): PlanState | undefined => {
    const uri =
      target instanceof vscode.Uri ? target : vscode.window.activeTextEditor?.document.uri;
    if (uri?.scheme === PLAN_SCHEME) return plans.get(uri.query);
    return plans.size === 1 ? [...plans.values()][0] : undefined;
  };
  const textOf = (state: PlanState): string => {
    if (state.result !== null) {
      return renderPlan({
        folder: state.folder.name,
        path: state.folder.uri.fsPath,
        when: state.when.toLocaleTimeString(),
        cliVersion: host.cliVersion(),
        scope: state.scope,
        keepOriginals: state.keepOriginals,
        result: shownResult(state),
        texts: state.texts,
        banner: state.banner,
      });
    }
    return `# Upfly plan: ${state.folder.name}\n\n${state.banner.join('\n\n')}\n`;
  };
  const show = async (state: PlanState, open: boolean): Promise<PlanOutcome> => {
    const uri = uriOf(state.folder);
    changed.fire(uri);
    lensesChanged.fire();
    if (open) {
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: false });
    }
    return outcomeOf(state);
  };
  const outcomeOf = (state: PlanState): PlanOutcome => ({
    phase: state.phase,
    text: textOf(state),
    runId: state.runId,
  });

  async function plan(state: PlanState, open: boolean): Promise<PlanOutcome> {
    const key = state.folder.uri.toString();
    const earlier = plans.get(key);
    // An apply in progress writes its result into its plan, which a new plan would replace.
    if (earlier?.phase === 'applying') {
      void vscode.window.showInformationMessage(
        'Upfly is applying a plan in this folder. Plan again once it has finished.',
      );
      return outcomeOf(earlier);
    }
    earlier?.abort?.abort();
    plans.set(key, state);
    state.abort = new AbortController();
    state.phase = 'planning';
    state.banner = ['Planning: Upfly is reading the folder. Nothing is changed.'];
    await show(state, open);
    const outcome = await host.run(state.folder, 'optimize', planArgs(state), {
      label: 'planning',
      signal: state.abort.signal,
    });
    state.when = new Date();
    if (outcome.kind === 'result') {
      const result = outcome.result as OptimizeResult;
      state.result = result;
      state.texts = readTexts(state.folder, result.plan);
      state.stamps = readStamps(state.folder, result.plan);
      state.phase = 'ready';
      state.banner = [];
      state.actions = [];
      return show(state, false);
    }
    state.result = null;
    stopped(state, outcome, 'plan', 'Upfly made no plan');
    return { ...(await show(state, false)), ...reasonOf(outcome) };
  }

  /** Puts a stop into the document: the CLI's message, the next step and its buttons. */
  function stopped(state: PlanState, outcome: HostOutcome, doing: 'plan' | 'apply', what: string) {
    state.phase = 'stopped';
    if (outcome.kind === 'stopped') {
      const step = nextStep(outcome.error, doing);
      state.banner = [`${what}: ${step.message}`, ...(step.next === null ? [] : [step.next])];
      state.actions = step.actions;
    } else if (outcome.kind === 'cancelled') {
      state.banner = [
        doing === 'apply'
          ? `${what}: the run was cancelled part way. Upfly's record of the run lets Undo put back what it wrote: the review shows it.`
          : `${what}: the run was cancelled.`,
      ];
      state.actions = [];
    } else if (outcome.kind === 'crashed' || outcome.kind === 'unavailable') {
      state.banner = [`${what}: ${outcome.message}`];
      state.actions = outcome.kind === 'crashed' ? [{ kind: 'output', title: 'Show output' }] : [];
    }
  }

  async function apply(target?: unknown): Promise<PlanOutcome | undefined> {
    const state = stateOf(target);
    if (state === undefined || state.result === null || state.phase !== 'ready') return undefined;
    if (!vscode.workspace.isTrusted) {
      untrusted();
      return outcomeOf(state);
    }
    const dirty = unsavedIn(state);
    if (dirty.length > 0) {
      state.banner = [
        `Not applied: ${dirty.join(', ')} ${dirty.length === 1 ? 'has' : 'have'} changes not saved in the editor, which Upfly would write past. Save or revert them, then plan again.`,
      ];
      state.actions = [{ kind: 'plan-again', title: 'Plan again' }];
      state.phase = 'stopped';
      return show(state, false);
    }
    const since = changedSince(state);
    if (since.length > 0) {
      const outcome = await plan({ ...state, banner: [] }, false);
      const current = plans.get(state.folder.uri.toString());
      if (current !== undefined && current.phase === 'ready') {
        current.banner = [
          `Not applied: ${since.join(', ')} changed since the plan you read. This is the plan for the files as they are now; read it, then apply it.`,
        ];
        return show(current, false);
      }
      return outcome;
    }
    const shown = state.result.plan;
    state.phase = 'applying';
    state.banner = ['Applying: Upfly is converting the images and rewriting the references.'];
    await show(state, false);
    state.abort = new AbortController();
    const outcome = await host.run(state.folder, 'optimize', applyArgs(state), {
      label: 'applying the plan',
      signal: state.abort.signal,
    });
    if (outcome.kind === 'result') {
      const result = outcome.result as OptimizeResult;
      state.phase = 'applied';
      state.runId = result.run?.id ?? null;
      state.result = { ...result, apply: false };
      state.banner = appliedBanner(result, samePlan(shown, result.plan));
      state.actions = [];
    } else {
      stopped(state, outcome, 'apply', 'Not applied');
    }
    await show(state, false);
    // A stop can still leave a run to review: one applied whose commit failed, or one cut
    // short, which only its undo puts back.
    await review.show(state.folder, outcome.kind === 'result');
    host.refresh(state.folder);
    return { ...outcomeOf(state), ...reasonOf(outcome) };
  }

  async function optimizeImages(
    clicked?: unknown,
    selected?: unknown,
  ): Promise<PlanOutcome | undefined> {
    const images = chosenImages(clicked, selected);
    if (images.length === 0) {
      void vscode.window.showInformationMessage('Choose one or more images to optimize.');
      return undefined;
    }
    const folders = new Map<string, vscode.WorkspaceFolder>();
    for (const image of images) {
      const folder = vscode.workspace.getWorkspaceFolder(image);
      if (folder !== undefined) folders.set(folder.uri.toString(), folder);
    }
    const [folder, ...others] = [...folders.values()];
    if (folder === undefined) {
      void vscode.window.showInformationMessage(
        'Upfly optimizes images inside an open workspace folder only.',
      );
      return undefined;
    }
    if (others.length > 0) {
      void vscode.window.showInformationMessage(
        'Choose images from one workspace folder at a time: each folder is its own project.',
      );
      return undefined;
    }
    if (!vscode.workspace.isTrusted) return untrusted();
    const relative = images
      .map((image) => path.relative(folder.uri.fsPath, image.fsPath).split(path.sep).join('/'))
      .sort();
    return plan(fresh(folder, { kind: 'images', images: relative }), true);
  }

  async function optimizeWorkspace(named?: unknown): Promise<PlanOutcome | undefined> {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter(
      (folder) =>
        folder.uri.scheme === 'file' &&
        (!(named instanceof vscode.Uri) || folder.uri.toString() === named.toString()),
    );
    if (folders.length === 0) {
      void vscode.window.showInformationMessage('Open a folder to optimize its images.');
      return undefined;
    }
    if (!vscode.workspace.isTrusted) return untrusted();
    const folder =
      folders.length === 1
        ? folders[0]
        : (
            await vscode.window.showQuickPick(
              folders.map((entry) => ({ label: entry.name, description: entry.uri.fsPath, entry })),
              {
                placeHolder:
                  'Optimize which folder? Each one is planned, applied and committed on its own.',
              },
            )
          )?.entry;
    if (folder === undefined) return undefined;
    return plan(fresh(folder, { kind: 'workspace' }), true);
  }

  async function again(
    target: unknown,
    change: Partial<PlanState> = {},
  ): Promise<PlanOutcome | undefined> {
    const state = stateOf(target);
    if (state === undefined || state.phase === 'planning' || state.phase === 'applying')
      return undefined;
    return plan(
      {
        ...fresh(state.folder, state.scope),
        keepOriginals: state.keepOriginals,
        publicDir: state.publicDir,
        ...change,
      },
      false,
    );
  }

  /** Takes a refusal's next step; `dir` names the served folder instead of asking for one. */
  async function act(target: unknown, kind: StepAction['kind'], dir?: unknown): Promise<unknown> {
    const state = stateOf(target);
    if (state === undefined) return undefined;
    switch (kind) {
      case 'plan-again':
      case 'retry':
        return again(target);
      case 'choose-public':
        return typeof dir === 'string'
          ? again(target, { publicDir: dir })
          : choosePublic(state, target);
      case 'init':
        return writeConfig(state);
      case 'open-config': {
        const [config] = await vscode.workspace.findFiles(
          new vscode.RelativePattern(state.folder, 'upfly.config.*'),
          null,
          1,
        );
        if (config === undefined) {
          void vscode.window.showInformationMessage('No Upfly config is in this folder now.');
          return undefined;
        }
        return vscode.window.showTextDocument(config);
      }
      case 'scm':
        return vscode.commands.executeCommand('workbench.view.scm');
      case 'trust':
        return vscode.commands.executeCommand('workbench.trust.manage');
      case 'undo-run':
        return vscode.commands.executeCommand('upfly.review.undoRun', state.folder.uri);
      case 'output':
        host.log.show();
        return undefined;
    }
  }

  async function choosePublic(state: PlanState, target: unknown): Promise<unknown> {
    const dirs = readdirSync(state.folder.uri.fsPath, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules',
      )
      .map((entry) => entry.name)
      .sort();
    const picked = await vscode.window.showQuickPick(
      [
        { label: '.', description: 'the folder itself: the site is served from its top', dir: '.' },
        ...dirs.map((dir) => ({ label: dir, description: '', dir })),
      ],
      { placeHolder: 'Which folder is the site served from? Upfly uses it for this plan.' },
    );
    if (picked === undefined) return undefined;
    return again(target, { publicDir: picked.dir });
  }

  async function writeConfig(state: PlanState): Promise<void> {
    const outcome = await host.run(state.folder, 'init', [], {
      label: 'writing upfly.config.json',
    });
    const config = vscode.Uri.joinPath(state.folder.uri, 'upfly.config.json');
    if (outcome.kind === 'result') {
      state.banner = [
        'upfly init wrote upfly.config.json, with the folders it worked out and why. Check them, correct what is wrong, then plan again.',
      ];
      state.actions = [];
      state.phase = 'stopped';
      await show(state, false);
      await vscode.window.showTextDocument(config);
      return;
    }
    if (outcome.kind === 'stopped') {
      const step = nextStep(outcome.error, 'init');
      host.refuse(step, (kind) => void act(uriOf(state.folder), kind));
    }
  }

  function untrusted(): undefined {
    host.refuse(
      {
        message: UNTRUSTED_WRITE,
        next: null,
        actions: [{ kind: 'trust', title: 'Manage Workspace Trust' }],
      },
      () => {
        void vscode.commands.executeCommand('workbench.trust.manage');
      },
    );
    return undefined;
  }

  const lenses: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: lensesChanged.event,
    provideCodeLenses(document) {
      const state = plans.get(document.uri.query);
      if (state === undefined) return [];
      const top = new vscode.Range(0, 0, 0, 0);
      const found = topButtons(state).map(
        ([title, command, ...args]) =>
          new vscode.CodeLens(top, { title, command, arguments: [document.uri, ...args] }),
      );
      const result = state.result;
      const served = state.keepOriginals || result === null ? [] : servedOriginals(result.plan);
      if (state.phase === 'ready' && served.length > 0) {
        // From the text the document is about to hold: VS Code may not have read it yet.
        const heading = textOf(state)
          .split('\n')
          .findIndex(
            (line) => line.startsWith('## ') && line.endsWith('in a folder the site serves'),
          );
        if (heading !== -1) {
          found.push(
            new vscode.CodeLens(new vscode.Range(heading, 0, heading, 0), {
              title: 'Keep these originals',
              command: 'upfly.keepOriginals',
              arguments: [document.uri],
            }),
          );
        }
      }
      return found;
    },
  };

  context.subscriptions.push(
    changed,
    lensesChanged,
    vscode.workspace.registerTextDocumentContentProvider(PLAN_SCHEME, {
      onDidChange: changed.event,
      provideTextDocumentContent: (uri) => {
        const state = plans.get(uri.query);
        return state === undefined
          ? '# Upfly plan\n\nNo plan yet. Choose Optimize on an image, or run Upfly: Optimize workspace.\n'
          : textOf(state);
      },
    }),
    vscode.languages.registerCodeLensProvider({ scheme: PLAN_SCHEME }, lenses),
    vscode.commands.registerCommand('upfly.optimize', optimizeImages),
    vscode.commands.registerCommand('upfly.optimizeWorkspace', optimizeWorkspace),
    vscode.commands.registerCommand('upfly.applyPlan', apply),
    vscode.commands.registerCommand('upfly.planAgain', (target?: unknown) => again(target)),
    vscode.commands.registerCommand('upfly.keepOriginals', (target?: unknown) => {
      const state = stateOf(target);
      return state === undefined
        ? undefined
        : again(target, { keepOriginals: !state.keepOriginals });
    }),
    vscode.commands.registerCommand('upfly.planAction', act),
    vscode.commands.registerCommand('upfly.planCancel', (target?: unknown) => {
      stateOf(target)?.abort?.abort();
    }),
  );

  return (folder) => {
    const state = plans.get(folder.toString());
    return state === undefined ? undefined : outcomeOf(state);
  };
}

/** The buttons over a plan document, each as its title, its command and what follows the document. */
function topButtons(state: PlanState): [string, string, ...unknown[]][] {
  const result = state.result;
  switch (state.phase) {
    case 'planning':
    case 'applying':
      return [['Cancel', 'upfly.planCancel']];
    case 'applied':
      return [['Show the review', 'upfly.review.show']];
    case 'stopped':
      return [
        ...state.actions.map((action): [string, string, ...unknown[]] => [
          action.title,
          'upfly.planAction',
          action.kind,
        ]),
        ['Plan again', 'upfly.planAgain'],
      ];
    case 'ready': {
      const buttons: [string, string, ...unknown[]][] = [];
      const work =
        result !== null && (result.plan.conversions.length > 0 || result.plan.rewrites.length > 0);
      if (work) buttons.push(['Apply this plan', 'upfly.applyPlan']);
      if (work && state.keepOriginals) {
        buttons.push(['Remove originals as planned', 'upfly.keepOriginals']);
      } else if (result?.plan.conversions.some((conversion) => conversion.replacesOriginal)) {
        buttons.push(['Keep the originals', 'upfly.keepOriginals']);
      }
      buttons.push(['Plan again', 'upfly.planAgain']);
      return buttons;
    }
  }
}

function fresh(folder: vscode.WorkspaceFolder, scope: PlanScope): PlanState {
  return {
    folder,
    scope,
    keepOriginals: false,
    publicDir: null,
    when: new Date(),
    phase: 'planning',
    result: null,
    texts: new Map(),
    stamps: new Map(),
    banner: [],
    actions: [],
    runId: null,
    abort: null,
  };
}

/** The result as the document shows it: for a selection, without the CLI's note about uncommitted changes, which right-click Optimize writes over by design. */
function shownResult(state: PlanState): OptimizeResult {
  const result = state.result as OptimizeResult;
  if (state.scope.kind === 'workspace') return result;
  return {
    ...result,
    notes: result.notes.filter((note) => !note.startsWith('Uncommitted changes')),
  };
}

/** The arguments of the dry run; the apply adds to them, so it plans the same way. */
function planArgs(state: PlanState): string[] {
  return [
    ...(state.scope.kind === 'images'
      ? state.scope.images.flatMap((image) => ['--only', onlyPattern(image)])
      : []),
    ...(state.keepOriginals ? ['--keep-originals'] : []),
    ...(state.publicDir === null ? [] : ['--public', state.publicDir]),
  ];
}

function applyArgs(state: PlanState): string[] {
  return [
    ...planArgs(state),
    '--apply',
    ...(state.scope.kind === 'images' ? ['--allow-dirty'] : ['--commit']),
  ];
}

function readTexts(folder: vscode.WorkspaceFolder, plan: Plan): Map<string, string | null> {
  const texts = new Map<string, string | null>();
  for (const rewrite of plan.rewrites) {
    try {
      texts.set(rewrite.file, readFileSync(path.join(folder.uri.fsPath, rewrite.file), 'utf8'));
    } catch {
      texts.set(rewrite.file, null);
    }
  }
  return texts;
}

function readStamps(folder: vscode.WorkspaceFolder, plan: Plan): Map<string, string> {
  return new Map(
    plan.conversions.map((conversion) => [conversion.asset, stamp(folder, conversion.asset)]),
  );
}

function stamp(folder: vscode.WorkspaceFolder, file: string): string {
  try {
    const stats = statSync(path.join(folder.uri.fsPath, file));
    return `${stats.size}:${stats.mtimeMs}`;
  } catch {
    return 'missing';
  }
}

/** The files the plan names that changed since it arrived: a rewritten file's text, or an image. */
function changedSince(state: PlanState): string[] {
  const plan = state.result?.plan;
  if (plan === undefined) return [];
  const changed: string[] = [];
  for (const rewrite of plan.rewrites) {
    let text: string | null = null;
    try {
      text = readFileSync(path.join(state.folder.uri.fsPath, rewrite.file), 'utf8');
    } catch {}
    if (text === null || textHash(text) !== rewrite.textHash) changed.push(rewrite.file);
  }
  for (const [asset, before] of state.stamps) {
    if (stamp(state.folder, asset) !== before) changed.push(asset);
  }
  return changed;
}

/** The plan's files open in the editor with changes not saved. */
function unsavedIn(state: PlanState): string[] {
  const files = new Set(
    (state.result?.plan.rewrites ?? []).map((rewrite) =>
      path.join(state.folder.uri.fsPath, rewrite.file),
    ),
  );
  return vscode.workspace.textDocuments
    .filter((document) => document.isDirty && files.has(document.uri.fsPath))
    .map((document) => vscode.workspace.asRelativePath(document.uri, false));
}

/** Whether two plans convert the same images and make the same edits. */
function samePlan(a: Plan, b: Plan): boolean {
  const key = (plan: Plan) =>
    JSON.stringify([
      plan.conversions.map((conversion) => [
        conversion.asset,
        conversion.target,
        conversion.replacesOriginal,
      ]),
      plan.rewrites.map((rewrite) => [
        rewrite.file,
        rewrite.edits.map((edit) => [edit.start, edit.end, edit.replacement]),
      ]),
    ]);
  return key(a) === key(b);
}

function appliedBanner(result: OptimizeResult, same: boolean): string[] {
  const run = result.run;
  if (run === null) return ['Applied: there was nothing to write.'];
  const commit =
    result.commit === null ? 'not committed' : `committed as ${result.commit.slice(0, 7)}`;
  return [
    `Applied at ${new Date().toLocaleTimeString()} as run ${run.id}: ${run.created.length} converted ${run.created.length === 1 ? 'image' : 'images'} created, ${run.changed.length} ${run.changed.length === 1 ? 'file' : 'files'} rewritten, ${run.removed.length} ${run.removed.length === 1 ? 'original' : 'originals'} removed; ${commit}.`,
    ...(same
      ? []
      : [
          'The run Upfly applied differs from the plan shown, because the project changed in between. This document now shows what was applied, and so does the review.',
        ]),
    'Review each change in the Upfly view or in the files themselves: Accept keeps it, Undo puts it back.',
  ];
}

function reasonOf(outcome: HostOutcome): { reason?: string } {
  return outcome.kind === 'stopped' && outcome.error.reason !== undefined
    ? { reason: outcome.error.reason }
    : {};
}

/** The images a command was run on: the Explorer's selection, a tab, a view's row, or the open image. */
function chosenImages(clicked: unknown, selected: unknown): vscode.Uri[] {
  const uris: vscode.Uri[] = [];
  if (Array.isArray(selected) && selected.every((entry) => entry instanceof vscode.Uri)) {
    uris.push(...(selected as vscode.Uri[]));
  } else if (clicked instanceof vscode.Uri) {
    uris.push(clicked);
  } else {
    const row = clicked as { node?: { image?: string }; folder?: vscode.Uri | null } | undefined;
    if (row?.node?.image !== undefined && row.folder instanceof vscode.Uri) {
      uris.push(vscode.Uri.joinPath(row.folder, ...row.node.image.split('/')));
    } else {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom) {
        uris.push(input.uri);
      }
    }
  }
  return uris.filter((uri) => uri.scheme === 'file' && IMAGE.test(uri.path));
}
