/**
 * Codex custom-model catalog injection.
 *
 * The Codex CLI resolves per-model metadata (context window, capabilities,
 * instructions template) from a built-in catalog keyed by model slug. Models
 * routed through Clowder AI that have no built-in entry (e.g. `deepseek-flash`)
 * silently fall back to generic metadata and log a startup warning
 * ("Model metadata for <slug> not found. Defaulting to fallback metadata").
 *
 * `--config model_catalog_json=<path>` points the CLI at a catalog file, but it
 * REPLACES the built-in catalog wholesale (verified against codex-cli 0.147.0:
 * with a 1-entry file, `codex debug models` lists only that model). The flag is
 * therefore injected per-model: only invocations whose effective model is a
 * custom entry get it; builtin models must never receive it.
 *
 * The catalog's `instructions_template` is the CLI's own captured fallback text
 * (see ./codex-model-catalog-instructions.ts), adapted with the same
 * `without_update_plan_instructions` filter the CLI applies to its fallback
 * metadata. This cannot be left to the CLI: `get_prompt_base_instructions`
 * skips that filter whenever `model_catalog` is set, so injecting the raw
 * prompt would tell a model to call an `update_plan` tool that the invocation
 * does not expose.
 *
 * The entries also carry the model's native `context_window` /
 * `max_context_window`. That is not cosmetic: Codex's own fallback metadata
 * pins both to 272_000, and `with_config_overrides` computes
 * `min(--config model_context_window, max_context_window)`, so a configured
 * window silently collapsed to 272_000 (reported usable: 258_400 = 272_000 x
 * 95%). The values are per invocation and come from the invocation's resolved
 * native window (member manual/catalog config). They are omitted when that
 * source is absent, preserving Codex's "unconfigured" semantics instead of
 * promoting one member's manual 1M setting to every same-named route. This is
 * a metadata declaration, not a claim that the backend accepted a 1M-token
 * request: the CLI-reported 950_000 usable value is `1M x 95%`, and actual
 * backend acceptance remains unverified.
 *
 * Scope: only the `exec_json` carrier receives this catalog. It is the carrier
 * where we both inject the per-invocation member window and have independent
 * CLI evidence that the catalog is read. `app_server` starts its catalog at
 * spawn time and does not receive the per-invocation window override, so
 * injecting it there would change that carrier's effective window without a
 * matching config path. Keep it out until that carrier has its own evidence.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { normalizeModelSlug } from '@cat-cafe/shared';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import { CODEX_FALLBACK_MODEL_INSTRUCTIONS } from './codex-model-catalog-instructions.js';

const log = createModuleLogger('codex-model-catalog');

/** Carriers that may receive the custom catalog. See the scope note above. */
export type CodexModelCatalogCarrier = 'exec_json' | 'app_server';

export interface CodexModelCatalogEntry {
  slug: string;
  display_name: string;
  /**
   * Native window owned by THIS invocation. Optional: when the invocation has
   * no config-owned native window, both fields are omitted so Codex keeps
   * reporting `model_context_window: null` instead of inheriting a value from
   * another member or route. When present, Codex reads `context_window`
   * directly, and `max_context_window` must equal it so
   * `--config model_context_window=<native>` is not clamped by the 272k
   * fallback (which silently reduced a configured 1M window to 258k usable).
   */
  context_window?: number;
  max_context_window?: number;
  supported_reasoning_levels: Array<{ effort: string; description: string }>;
  shell_type: string;
  visibility: string;
  supported_in_api: boolean;
  priority: number;
  support_verbosity: boolean;
  truncation_policy: { mode: string; limit: number };
  supports_parallel_tool_calls: boolean;
  experimental_supported_tools: string[];
  model_messages: { instructions_template: string };
}

/**
 * `max` is listed because Clowder AI cats may run this model at `max` effort
 * (`CLI_EFFORT_VALUES`); the entry must not contradict the requested effort.
 */
const DEEPSEEK_FLASH_REASONING_LEVELS = [
  { effort: 'low', description: 'Fast responses with lighter reasoning' },
  { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
  { effort: 'high', description: 'Greater reasoning depth for complex problems' },
  { effort: 'xhigh', description: 'Extra high reasoning depth for complex problems' },
  { effort: 'max', description: 'Maximum reasoning depth for the hardest problems' },
];

/**
 * NEVER add a model that Codex ships in its own built-in catalog here: the flag
 * REPLACES that catalog wholesale, so registering a builtin slug would
 * silently drop every built-in entry for that invocation. Membership in this
 * map *is* the gate.
 */
export const CODEX_CUSTOM_MODEL_CATALOG_ENTRIES: Readonly<Record<string, CodexModelCatalogEntry>> = {
  'deepseek-flash': {
    slug: 'deepseek-flash',
    display_name: 'DeepSeek Flash',
    supported_reasoning_levels: DEEPSEEK_FLASH_REASONING_LEVELS,
    shell_type: 'shell_command',
    visibility: 'hide',
    supported_in_api: true,
    priority: 23,
    support_verbosity: true,
    truncation_policy: { mode: 'tokens', limit: 10_000 },
    // Parity with the fallback metadata Codex used before this entry existed
    // (captured request body: parallel_tool_calls=false).
    supports_parallel_tool_calls: false,
    experimental_supported_tools: [],
    model_messages: { instructions_template: CODEX_FALLBACK_MODEL_INSTRUCTIONS },
  },
};

export interface CodexModelCatalogBuildOptions {
  /**
   * Raw/native window owned by THIS invocation (member manual/catalog config).
   * `null`/`undefined` means no config-owned window: omit the window fields so
   * Codex keeps reporting `model_context_window: null` instead of inheriting a
   * value from another member or route.
   */
  nativeContextWindowTokens?: number | null;
  /** Codex's `tools.update_plan.enabled` setting for this invocation. */
  updatePlanEnabled?: boolean;
  /** Carrier gate; only `exec_json` receives the catalog. */
  carrier?: CodexModelCatalogCarrier;
}

const UPDATE_PLAN_SECTION_HEADINGS = new Set([
  '## Planning',
  '## `update_plan`',
  '## Plan tool',
  '## Plan Mode vs update_plan tool',
]);

function findSectionEnd(lines: readonly string[], headerIndex: number): number {
  for (let next = headerIndex + 1; next < lines.length; next++) {
    if (lines[next].startsWith('# ') || lines[next].startsWith('## ')) return next;
  }
  return lines.length;
}

function isChecklistSection(
  lines: readonly string[],
  headerIndex: number,
  sectionEnd: number,
  heading: string,
): boolean {
  if (heading !== '## Planning') return true;
  return lines
    .slice(headerIndex, sectionEnd)
    .some(
      (candidate) =>
        candidate.startsWith('You have access to an `update_plan` tool') ||
        candidate.startsWith('When `update_plan` is available, follow this section'),
    );
}

function skipIndentedContinuation(lines: readonly string[], index: number): number {
  let next = index;
  while (next < lines.length && (lines[next].startsWith(' ') || lines[next].startsWith('\t'))) {
    next += 1;
  }
  return next;
}

/**
 * Port of `codex-rs/prompts/src/update_plan_instructions.rs`. Codex applies
 * this filter to fallback instructions when `tools.update_plan` is disabled,
 * but deliberately skips it when a model catalog is present. We must apply the
 * same semantics ourselves before embedding the template in the catalog.
 */
export function withoutUpdatePlanInstructions(instructions: string): string {
  const lines = instructions.split(/(?<=\n)/);
  const rendered: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index].trimEnd();
    if (UPDATE_PLAN_SECTION_HEADINGS.has(line)) {
      const end = findSectionEnd(lines, index);
      if (isChecklistSection(lines, index, end, line)) {
        index = end;
        continue;
      }
    }

    if (line === 'Progress visibility:' && lines[index + 1]?.startsWith('If update_plan is available')) {
      index += 2;
      if (lines[index]?.trim() === '') index += 1;
      continue;
    }

    if (line.startsWith('- Use the plan tool ') || line.startsWith('- If you create a checklist or task list,')) {
      index = skipIndentedContinuation(lines, index + 1);
      continue;
    }

    rendered.push(lines[index]);
    index += 1;
  }
  return rendered.join('');
}

/**
 * Serialized catalog file content for one invocation. The instructions
 * template is adapted to the invocation's actual tool set, and the window
 * fields are present only when this invocation owns a native window.
 */
export function buildCodexModelCatalogFileContent(options: CodexModelCatalogBuildOptions = {}): string {
  const windowTokens = options.nativeContextWindowTokens;
  const hasNativeWindow = typeof windowTokens === 'number' && Number.isFinite(windowTokens) && windowTokens > 0;
  const instructions = options.updatePlanEnabled
    ? CODEX_FALLBACK_MODEL_INSTRUCTIONS
    : withoutUpdatePlanInstructions(CODEX_FALLBACK_MODEL_INSTRUCTIONS);
  const models = Object.values(CODEX_CUSTOM_MODEL_CATALOG_ENTRIES).map((entry) => ({
    ...entry,
    ...(hasNativeWindow ? { context_window: windowTokens, max_context_window: windowTokens } : {}),
    model_messages: { instructions_template: instructions },
  }));
  return `${JSON.stringify({ models }, null, 2)}\n`;
}

/** True when the effective model is one this module owns metadata for. */
export function isCodexCustomCatalogModel(model: string | null | undefined): boolean {
  const slug = normalizeModelSlug(model);
  return !!slug && slug in CODEX_CUSTOM_MODEL_CATALOG_ENTRIES;
}

/** Content-addressed path: identical content reuses one file; new content never mutates it. */
export function resolveCodexModelCatalogPath(content: string): string {
  const digest = createHash('sha256').update(content).digest('hex').slice(0, 16);
  return join(tmpdir(), 'cat-cafe-codex-model-catalog', `${digest}.json`);
}

/**
 * Server-owned argv pair for custom models, or `[]` for everything else.
 * Materialization failures degrade to `[]` (the CLI then uses fallback
 * metadata again — a warning, not an outage), never to a failed launch. The
 * failure is logged so the invocation record can distinguish "not applicable"
 * from "requested but fell back"; otherwise the window silently returns to
 * 258_400 with no trace.
 */
export function buildCodexModelCatalogArgs(
  model: string | null | undefined,
  options: CodexModelCatalogBuildOptions = {},
): string[] {
  const carrier = options.carrier ?? 'exec_json';
  if (carrier !== 'exec_json') return [];
  const slug = normalizeModelSlug(model);
  if (!slug || !(slug in CODEX_CUSTOM_MODEL_CATALOG_ENTRIES)) return [];
  try {
    const content = buildCodexModelCatalogFileContent(options);
    const path = resolveCodexModelCatalogPath(content);
    materializeCodexModelCatalog(content, path);
    return ['--config', `model_catalog_json=${path}`];
  } catch (err) {
    log.warn(
      { model: slug, carrier, err },
      'codex model catalog materialization failed; CLI will fall back to built-in metadata',
    );
    return [];
  }
}

/**
 * Reuse the content-addressed file only after proving it is exactly the bytes
 * this invocation requested. A matching filename alone proves nothing: a
 * truncated or hand-edited file made the CLI exit with a JSON parse error and
 * never fall back. `O_NOFOLLOW` keeps the read from following a planted link;
 * a mismatch is rebuilt atomically over the path.
 */
function isIntactCatalogFile(path: string, expectedContent: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP') return false;
    throw err;
  }
  try {
    if (!fstatSync(fd).isFile()) return false;
    return readFileSync(fd, 'utf8') === expectedContent;
  } finally {
    closeSync(fd);
  }
}

function materializeCodexModelCatalog(content: string, path: string): void {
  if (isIntactCatalogFile(path, content)) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmpPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmpPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(tmpPath, path);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup; the original failure is what matters.
    }
    throw err;
  }
}
