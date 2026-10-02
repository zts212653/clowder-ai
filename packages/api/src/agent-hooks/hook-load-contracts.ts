/**
 * Whether a CLI will load a hook config at all. Codex and Claude Code drop every hook (Codex:
 * the whole hooks.json) when a single entry violates their schema, so Clowder may merge into a
 * shared file, or report its hooks as configured, only when every entry is within the contract
 * verified for that CLI version. Fields and event names a CLI ignores are accepted (#1566).
 */

import { isJsonObject, JsonNumber, type JsonObject, type ReaderFacts } from './json-source.js';

interface Check {
  ok: (value: unknown) => boolean;
  expect: string;
}

interface HandlerSpec {
  required: Readonly<Record<string, Check>>;
  optional: Readonly<Record<string, Check>>;
  /** Field aliases the CLI maps to one field; more than one present is a duplicate field. */
  aliases?: readonly (readonly string[])[];
}

/** What the CLI's JSON reader itself accepts, before any hook schema applies. */
interface ReaderLimits {
  bom: boolean;
  unpairedSurrogates: boolean;
  /** Deepest container nesting the reader parses; the root container is level 1. */
  maxDepth?: number;
}

export interface HookLoadContract {
  /** CLI and version the contract was verified against; shown in refusal reasons. */
  name: string;
  reader: ReaderLimits;
  /** When set, any other top-level key makes the CLI reject the file. */
  rootKeys?: readonly string[];
  rootFields?: Readonly<Record<string, Check>>;
  /** When set, only these events are parsed; the CLI ignores other event names. */
  events?: readonly string[];
  matcher: Check;
  groupHooksRequired: boolean;
  common: Readonly<Record<string, Check>>;
  handlers: Readonly<Record<string, HandlerSpec>>;
  /** Spec for handler types not listed in `handlers`; absent means unknown types are rejected. */
  otherHandlers?: HandlerSpec;
  /** Health reason when managed entries are in place but CLI loading is not verified. */
  configuredNote?: string;
}

const check = (ok: (value: unknown) => boolean, expect: string): Check => ({ ok, expect });
const isNumber = (v: unknown): v is JsonNumber => v instanceof JsonNumber && Number.isFinite(v.value);
const isIntegerLexeme = (v: JsonNumber) => /^-?(?:0|[1-9]\d*)$/.test(v.raw);
/** Codex hashes each handler as TOML, whose integers stop at i64::MAX; larger values panic hooks discovery. */
const I64_MAX = 2n ** 63n - 1n;
const str = check((v) => typeof v === 'string', 'a string');
const bool = check((v) => typeof v === 'boolean', 'a boolean');
const num = check(isNumber, 'a number');
const positive = check((v) => isNumber(v) && v.value > 0, 'a positive number');
/**
 * Codex u64/usize hook fields: an integer literal (`5.0` and `5e0` are rejected as floats) no larger
 * than i64::MAX (verified against Codex 0.159.3: one more crashes app-server hook discovery).
 */
const unsignedInt = check((v) => {
  if (!isNumber(v) || !isIntegerLexeme(v)) return false;
  const value = BigInt(v.raw);
  return value >= 0n && value <= I64_MAX;
}, 'an integer literal from 0 to 9223372036854775807');
const object = check(isJsonObject, 'an object');
const strArray = check((v) => Array.isArray(v) && v.every((item) => typeof item === 'string'), 'an array of strings');
const strRecord = check(
  (v) => isJsonObject(v) && Object.values(v).every((item) => typeof item === 'string'),
  'an object of strings',
);
const nullable = (inner: Check) => check((v) => v === null || inner.ok(v), `${inner.expect} or null`);
const oneOf = (...values: string[]) =>
  check((v) => typeof v === 'string' && values.includes(v), `one of ${values.join(', ')}`);
/** Codex converts mcp_tool input to TOML, which has no null; every JSON number is accepted (verified). */
const tomlRepresentable = (v: unknown): boolean => {
  if (v === null) return false;
  if (typeof v !== 'object' || v instanceof JsonNumber) return true;
  return Object.values(v as JsonObject).every((item) => tomlRepresentable(item));
};
const tomlObject = check((v) => isJsonObject(v) && tomlRepresentable(v), 'an object representable as TOML');
const handler = (
  required: HandlerSpec['required'],
  optional: HandlerSpec['optional'] = {},
  aliases: HandlerSpec['aliases'] = [],
): HandlerSpec => ({ required, optional, aliases });

/** codex-rs/config/src/hook_config.rs at rust-v0.159.3 (HooksFile, MatcherGroup, HookHandlerConfig). */
const CODEX: HookLoadContract = {
  name: 'Codex CLI 0.159.3',
  // serde_json: no BOM, no unpaired surrogate escape anywhere, recursion limit 128 (127 levels load).
  reader: { bom: false, unpairedSurrogates: false, maxDepth: 127 },
  rootKeys: ['description', 'hooks'],
  rootFields: { description: nullable(str) },
  events: [
    'PreToolUse',
    'PermissionRequest',
    'PostToolUse',
    'PreCompact',
    'PostCompact',
    'SessionStart',
    'SessionEnd',
    'UserPromptSubmit',
    'SubagentStart',
    'SubagentStop',
    'Stop',
    'Interrupt',
  ],
  matcher: nullable(str),
  groupHooksRequired: false,
  common: {},
  handlers: {
    command: handler(
      { command: str },
      {
        commandWindows: nullable(str),
        command_windows: nullable(str),
        timeout: nullable(unsignedInt),
        async: bool,
        statusMessage: nullable(str),
        additionalContextLimit: nullable(unsignedInt),
      },
      [['commandWindows', 'command_windows']],
    ),
    mcp_tool: handler(
      { server: str, tool: str },
      { input: tomlObject, timeout: nullable(unsignedInt), statusMessage: nullable(str) },
    ),
    prompt: handler({}),
    agent: handler({}),
  },
};

/** Claude Code hooks reference plus black-box loading checks against 2.1.286. */
const CLAUDE: HookLoadContract = {
  name: 'Claude Code 2.1.286',
  reader: { bom: true, unpairedSurrogates: true },
  matcher: str,
  groupHooksRequired: true,
  common: { if: str, timeout: positive, statusMessage: str, once: bool },
  handlers: {
    command: handler(
      { command: str },
      { args: strArray, shell: oneOf('bash', 'powershell'), async: bool, asyncRewake: bool },
    ),
    http: handler({ url: str }, { headers: strRecord, allowedEnvVars: strArray }),
    mcp_tool: handler({ server: str, tool: str }, { input: object }),
    prompt: handler({ prompt: str }, { model: str }),
    agent: handler({ prompt: str }, { model: str }),
  },
};

/**
 * No Gemini CLI loading contract is verified (0.42.0 does not read ~/.gemini/hooks.json; #1565),
 * so only the structure every hook CLI shares is required.
 */
const SHARED: HookLoadContract = {
  name: 'shared hook structure (Gemini loading unverified)',
  reader: { bom: true, unpairedSurrogates: true },
  matcher: str,
  groupHooksRequired: true,
  common: { timeout: num },
  handlers: { command: handler({ command: str }) },
  otherHandlers: handler({}),
  configuredNote: 'managed entries present; Gemini CLI loading of this file is not verified (#1565)',
};

export const HOOK_LOAD_CONTRACTS = { codex: CODEX, claude: CLAUDE, gemini: SHARED } as const;

function handlerProblem(value: unknown, at: string, contract: HookLoadContract): string | undefined {
  if (!isJsonObject(value) || typeof value.type !== 'string') return `${at} must be an object with a string "type"`;
  const spec = Object.hasOwn(contract.handlers, value.type) ? contract.handlers[value.type] : contract.otherHandlers;
  if (!spec) return `${at}.type ${JSON.stringify(value.type)} is not a handler type it loads`;
  for (const names of spec.aliases ?? []) {
    const present = names.filter((name) => Object.hasOwn(value, name));
    if (present.length > 1) return `${at} sets ${present.join(' and ')}, which are the same field`;
  }
  for (const [field, rule] of Object.entries(spec.required)) {
    if (!rule.ok(value[field])) return `${at}.${field} is required and must be ${rule.expect}`;
  }
  for (const [field, rule] of Object.entries({ ...contract.common, ...spec.optional })) {
    if (value[field] !== undefined && !rule.ok(value[field])) return `${at}.${field} must be ${rule.expect}`;
  }
  return undefined;
}

function groupProblem(value: unknown, at: string, contract: HookLoadContract): string | undefined {
  if (!isJsonObject(value)) return `${at} must be an object`;
  if (value.matcher !== undefined && !contract.matcher.ok(value.matcher)) {
    return `${at}.matcher must be ${contract.matcher.expect}`;
  }
  if (value.hooks === undefined) return contract.groupHooksRequired ? `${at}.hooks is required` : undefined;
  if (!Array.isArray(value.hooks)) return `${at}.hooks must be an array`;
  for (const [index, entry] of value.hooks.entries()) {
    const problem = handlerProblem(entry, `${at}.hooks[${index}]`, contract);
    if (problem) return problem;
  }
  return undefined;
}

function readerProblem(facts: ReaderFacts, limits: ReaderLimits): string | undefined {
  if (facts.bom && !limits.bom) return 'the file starts with a byte order mark';
  if (facts.unpairedSurrogateAt !== undefined && !limits.unpairedSurrogates) {
    return `the string at offset ${facts.unpairedSurrogateAt} contains an unpaired UTF-16 surrogate escape`;
  }
  if (limits.maxDepth !== undefined && facts.depth > limits.maxDepth) {
    return `the file nests ${facts.depth} levels deep; at most ${limits.maxDepth} are parsed`;
  }
  return undefined;
}

function rootProblem(document: JsonObject, contract: HookLoadContract): string | undefined {
  const unknownRoot = contract.rootKeys && Object.keys(document).find((key) => !contract.rootKeys?.includes(key));
  if (unknownRoot) return `unknown top-level key "${unknownRoot}"`;
  for (const [field, rule] of Object.entries(contract.rootFields ?? {})) {
    if (document[field] !== undefined && !rule.ok(document[field])) return `"${field}" must be ${rule.expect}`;
  }
  return undefined;
}

/** Returns why the CLI would not load `document`, or undefined when every entry is in contract. */
export function hookLoadProblem(
  document: JsonObject,
  contract: HookLoadContract,
  facts?: ReaderFacts,
): string | undefined {
  const problem = (facts && readerProblem(facts, contract.reader)) ?? rootProblem(document, contract);
  if (problem) return problem;
  const hooks = document.hooks;
  if (hooks === undefined) return undefined;
  if (!isJsonObject(hooks)) return '"hooks" must be a JSON object';
  for (const [event, groups] of Object.entries(hooks)) {
    if (contract.events && !contract.events.includes(event)) continue;
    const eventProblem = groupsProblem(groups, `hooks.${event}`, contract);
    if (eventProblem) return eventProblem;
  }
  return undefined;
}

function groupsProblem(groups: unknown, at: string, contract: HookLoadContract): string | undefined {
  if (!Array.isArray(groups)) return `${at} must be an array`;
  for (const [index, group] of groups.entries()) {
    const problem = groupProblem(group, `${at}[${index}]`, contract);
    if (problem) return problem;
  }
  return undefined;
}
