import { readFileSync } from 'node:fs';
import type { HealthResult } from './health.js';
import { type HookLoadContract, hookLoadProblem } from './hook-load-contracts.js';
import { decodeHookConfig, isJsonObject, type JsonSource, type JsonValue, parseJsonSource } from './json-source.js';
import { applyManagedHookEdits, type ManagedHookEditPlan } from './managed-hook-edits.js';

/**
 * Clowder-managed lifecycle entries inside hook configs that users and other tools share
 * (~/.claude/settings.json, ~/.codex/hooks.json, ~/.gemini/hooks.json). Sync may only touch
 * entries it can prove are Clowder's; everything else is preserved in place (#1566).
 */

export const MANAGED_EVENT_SCRIPTS = {
  SessionStart: 'session-start-recall.sh',
  Stop: 'session-stop-check.sh',
} as const;

export type ManagedHookEvent = keyof typeof MANAGED_EVENT_SCRIPTS;
export type ManagedHookCommands = Readonly<Record<ManagedHookEvent, string>>;

export interface ManagedHookScope {
  targetRoot: string;
  commands: ManagedHookCommands;
  /** Loading contract of the CLI that reads this file; nothing is merged outside it. */
  contract: HookLoadContract;
}

const MANAGED_EVENTS = Object.keys(MANAGED_EVENT_SCRIPTS) as ManagedHookEvent[];
/** Trailing arguments Clowder renderers have emitted (`--codex-json` since 1413e6d57). */
const KNOWN_ARGS = new Map<string, readonly string[]>([
  [MANAGED_EVENT_SCRIPTS.SessionStart, ['']],
  [MANAGED_EVENT_SCRIPTS.Stop, ['', '--codex-json']],
]);

interface ParsedManagedCommand {
  script: string;
  usesBash: boolean;
  arg: string;
  /** False when the spelling cannot run as written (single-quoted $HOME, quoted ~). */
  runnable: boolean;
}

function splitCommand(command: string): { usesBash: boolean; path: string; quote: string; tail: string } | null {
  const trimmed = command.trim();
  const bash = /^bash\s+/.exec(trimmed);
  const rest = bash ? trimmed.slice(bash[0].length) : trimmed;
  const quote = rest[0] === '"' || rest[0] === "'" ? rest[0] : '';
  if (quote) {
    const end = rest.indexOf(quote, 1);
    return end < 0 ? null : { usesBash: Boolean(bash), path: rest.slice(1, end), quote, tail: rest.slice(end + 1) };
  }
  const match = /^(\S+)([\s\S]*)$/.exec(rest);
  return match ? { usesBash: Boolean(bash), path: match[1], quote, tail: match[2] } : null;
}

/**
 * Recognises only spellings Clowder renderers or documented templates have produced:
 * `[bash ]<path>[ <known-arg>]`, where <path> (optionally quoted) is exactly
 * `<home>/.claude/hooks/<managed script>` and <home> is the target root, `$HOME` or `${HOME}` or `~`.
 * Paths are compared textually, never resolved, so traversal, subdirectories, unknown
 * arguments and compound commands stay third-party.
 */
function parseManagedCommand(command: unknown, targetRoot: string): ParsedManagedCommand | null {
  if (typeof command !== 'string') return null;
  const split = splitCommand(command);
  if (!split || (split.tail !== '' && !/^\s/.test(split.tail))) return null;
  const path = split.path.replace(/\\/g, '/');
  const script = path.slice(path.lastIndexOf('/') + 1);
  const arg = split.tail.trim();
  if (!KNOWN_ARGS.get(script)?.includes(arg)) return null;
  const root = targetRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell variable spelling, not a JS template
  const home = [root, '$HOME', '${HOME}', '~'].find((prefix) => path === `${prefix}/.claude/hooks/${script}`);
  if (home === undefined) return null;
  const runnable = home === root || (home === '~' ? split.quote === '' : split.quote !== "'");
  return { script, usesBash: split.usesBash, arg, runnable };
}

interface ManagedHandlerRef {
  groupIndex: number;
  handlerIndex: number;
  usesBash: boolean;
  /** Semantically equal to the rendered command; equivalent spellings are left as-is. */
  current: boolean;
}

/**
 * Clowder only ever writes `{hooks:[…]}` groups holding `{type:"command", command}` handlers. Any other
 * key changes how or when a handler runs (exec-form `args` — even empty — selects direct invocation,
 * `shell`, `if`, `async`/`asyncRewake`, `once`, `timeout`, `statusMessage`, Codex `commandWindows` /
 * `command_windows` / `additionalContextLimit`, group `matcher`, unknown fields), so such an entry is
 * someone else's: it is preserved in place, never rewritten or removed as a duplicate (#1570 review).
 */
const CLOWDER_GROUP_KEYS = new Set(['hooks']);
const CLOWDER_HANDLER_KEYS = new Set(['type', 'command']);

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

type LocatedHandlers =
  | { ok: true; byEvent: Record<ManagedHookEvent, ManagedHandlerRef[]> }
  | { ok: false; reason: string };

function locateManagedHandlers(source: JsonSource, scope: ManagedHookScope): LocatedHandlers {
  const document = source.value;
  if (!isJsonObject(document)) return { ok: false, reason: 'hook config root must be a JSON object' };
  const hooks = document.hooks;
  if (hooks !== undefined && !isJsonObject(hooks)) return { ok: false, reason: '"hooks" must be a JSON object' };
  const problem = hookLoadProblem(document, scope.contract, source.facts);
  if (problem) return { ok: false, reason: `outside the verified ${scope.contract.name} loading contract: ${problem}` };
  const byEvent = {} as Record<ManagedHookEvent, ManagedHandlerRef[]>;
  for (const event of MANAGED_EVENTS) {
    const entries = hooks?.[event] as JsonValue[] | undefined;
    const desired = parseManagedCommand(scope.commands[event], scope.targetRoot);
    const refs: ManagedHandlerRef[] = [];
    (entries ?? []).forEach((group, groupIndex) => {
      if (!isJsonObject(group) || !Array.isArray(group.hooks) || !hasOnlyKeys(group, CLOWDER_GROUP_KEYS)) return;
      group.hooks.forEach((handler, handlerIndex) => {
        if (!isJsonObject(handler) || handler.type !== 'command') return;
        if (!hasOnlyKeys(handler, CLOWDER_HANDLER_KEYS)) return;
        const parsed = parseManagedCommand(handler.command, scope.targetRoot);
        if (parsed?.script !== MANAGED_EVENT_SCRIPTS[event]) return;
        const current = parsed.usesBash && parsed.runnable && parsed.arg === desired?.arg;
        refs.push({ groupIndex, handlerIndex, usesBash: parsed.usesBash, current });
      });
    });
    byEvent[event] = refs;
  }
  return { ok: true, byEvent };
}

export type ManagedHookMergeResult =
  | { kind: 'unchanged' }
  | { kind: 'updated'; text: string }
  | { kind: 'refused'; reason: string };

function duplicateReason(events: ManagedHookEvent[]): string {
  return `duplicate Clowder-managed ${events.join('/')} hook entries; remove the extras manually`;
}

function managedGroup(command: string) {
  return { hooks: [{ type: 'command', command }] };
}

/** A file holding only Clowder's managed entries, for targets that do not exist yet. */
export function renderManagedHooksDocument(commands: ManagedHookCommands): string {
  const hooks = Object.fromEntries(MANAGED_EVENTS.map((event) => [event, [managedGroup(commands[event])]]));
  return `${JSON.stringify({ hooks }, null, 2)}\n`;
}

/**
 * Plans in-place updates of recognised entries and appends of missing ones after existing
 * groups, then splices them into the original text: no third-party byte changes and no
 * third-party handler changes position (Codex keys hook trust/enabled state by position and
 * hashes values as parsed). Duplicates are removed only when `removeDuplicates` is set (Claude
 * has no positional state). The result is re-parsed and verified before it may be written.
 */
export function mergeManagedHooks(
  source: JsonSource,
  options: ManagedHookScope & { removeDuplicates: boolean },
): ManagedHookMergeResult {
  const located = locateManagedHandlers(source, options);
  if (!located.ok) return { kind: 'refused', reason: located.reason };
  const duplicated = MANAGED_EVENTS.filter((event) => located.byEvent[event].length > 1);
  if (duplicated.length > 0 && !options.removeDuplicates) {
    return { kind: 'refused', reason: duplicateReason(duplicated) };
  }

  const plan: ManagedHookEditPlan = { setCommand: [], remove: [], append: [] };
  for (const event of MANAGED_EVENTS) {
    const [first, ...extras] = located.byEvent[event];
    const command = options.commands[event];
    if (!first) plan.append.push({ event, command });
    else if (!first.current) plan.setCommand.push({ event, ...first, command });
    plan.remove.push(...extras.map((ref) => ({ event, ...ref })));
  }
  if (plan.append.length + plan.setCommand.length + plan.remove.length === 0) return { kind: 'unchanged' };

  const text = applyManagedHookEdits(source, plan);
  const reparsed = parseJsonSource(text);
  const check = reparsed.ok ? inspectManagedHooks(reparsed.source, options) : undefined;
  const clean =
    check && !check.invalid && [check.missing, check.outdated, check.duplicated].every((e) => e.length === 0);
  if (!clean) return { kind: 'refused', reason: 'merged hook config failed verification; left unchanged' };
  return { kind: 'updated', text };
}

export interface ManagedHookInspection {
  invalid?: string;
  missing: ManagedHookEvent[];
  outdated: ManagedHookEvent[];
  duplicated: ManagedHookEvent[];
  missingBash: boolean;
}

export function inspectManagedHooks(source: JsonSource, scope: ManagedHookScope): ManagedHookInspection {
  const located = locateManagedHandlers(source, scope);
  if (!located.ok) return { invalid: located.reason, missing: [], outdated: [], duplicated: [], missingBash: false };
  const refs = (event: ManagedHookEvent) => located.byEvent[event];
  return {
    missing: MANAGED_EVENTS.filter((event) => refs(event).length === 0),
    outdated: MANAGED_EVENTS.filter((event) => refs(event).some((ref) => !ref.current)),
    duplicated: MANAGED_EVENTS.filter((event) => refs(event).length > 1),
    missingBash: MANAGED_EVENTS.some((event) => refs(event).some((ref) => !ref.usesBash)),
  };
}

export function readHookDocument(path: string): { ok: true; source: JsonSource } | { ok: false; reason: string } {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    return { ok: false, reason: `cannot read hook config: ${error instanceof Error ? error.message : String(error)}` };
  }
  const decoded = decodeHookConfig(bytes);
  return decoded.ok ? parseJsonSource(decoded.text) : decoded;
}

/** Health of an existing shared hook JSON file; third-party content never makes it unhealthy. */
export function managedHookFileHealth(name: string, targetPath: string, scope: ManagedHookScope): HealthResult {
  const read = readHookDocument(targetPath);
  const inspection = read.ok ? inspectManagedHooks(read.source, scope) : undefined;
  const invalid = read.ok ? inspection?.invalid : read.reason;
  if (invalid !== undefined || !inspection) {
    return { name, drifted: false, status: 'error', targetPath, reason: invalid ?? 'unreadable hook config' };
  }
  const fields = (events: ManagedHookEvent[]) => events.map((event) => `hooks.${event}`);
  if (inspection.duplicated.length > 0 || inspection.outdated.length > 0) {
    const events = inspection.duplicated.length > 0 ? inspection.duplicated : inspection.outdated;
    const reason =
      inspection.duplicated.length > 0
        ? duplicateReason(events)
        : `Clowder-managed ${events.join('/')} hook command is outdated`;
    return {
      name,
      drifted: true,
      status: 'stale',
      targetPath,
      reason,
      diff: { kind: 'json', message: reason, fields: fields(events) },
    };
  }
  if (inspection.missing.length > 0) {
    const reason = `Clowder-managed ${inspection.missing.join('/')} hook entries are missing`;
    return {
      name,
      drifted: true,
      status: 'missing',
      targetPath,
      reason,
      diff: { kind: 'json', message: reason, fields: fields(inspection.missing) },
    };
  }
  return {
    name,
    drifted: false,
    status: 'configured',
    targetPath,
    reason: scope.contract.configuredNote ?? 'configured',
  };
}
