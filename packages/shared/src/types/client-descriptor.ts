/**
 * Client descriptor registry — single source of truth for "which CLI backs a ClientId".
 *
 * Before this registry the same mapping was duplicated in five places that had already
 * drifted apart (the detection specs were missing `agy`, which four members in
 * cat-template.json actually run):
 *   - `packages/api/src/routes/cats.ts` → `defaultCliForClient()`
 *   - `packages/api/src/utils/cli-resolve.ts` → `formatCliNotFoundError()` install hints
 *   - `packages/api/src/domains/cats/services/first-run-quest/client-detection.ts` → `CLI_SPECS`
 *   - `packages/api/src/config/cat-catalog-store.ts` → `CLIENT_ID_VALUES`
 *   - `packages/web/src/components/hub-cat-editor.model.ts` → `CLIENT_OPTIONS`
 *
 * Pure data only: no `node:` imports so the web bundle can consume it. Platform-specific
 * install strings are carried as `{ default, win32? }` and rendered by `formatInstallHint`.
 *
 * Adding a new CLI is a descriptor entry here plus (when it needs detection) nothing else.
 */

import type { ClientId } from './cat.js';

/**
 * Agent CLI tool identities used by the first-run wizard contract. Distinct from
 * {@link ClientId}: one CLI tool can back several ClientIds (agy backs `google`) and a
 * ClientId may have no CLI at all (`a2a`).
 */
export type ClientToolId = 'claude' | 'codex' | 'agy' | 'gemini' | 'opencode' | 'kimi';

/** All ClientIds, in the canonical order used by pickers and generated enums. */
export const CLIENT_IDS = [
  'anthropic',
  'openai',
  'google',
  'kimi',
  'opencode',
  'antigravity',
  'a2a',
  'catagent',
  'acp',
] as const;

/**
 * ClientIds accepted by `POST /api/cats`, as a literal tuple so callers can build a typed
 * enum from it (`z.enum(CREATABLE_CLIENT_IDS)`). `a2a` is absent: a remote peer needs
 * `CAT_<ID>_A2A_URL` before it can be routed. `descriptor-registry.test.ts` asserts this
 * tuple matches the descriptors' `creatable` flags, so the two cannot drift.
 */
export const CREATABLE_CLIENT_IDS = [
  'anthropic',
  'openai',
  'google',
  'kimi',
  'opencode',
  'antigravity',
  'catagent',
  'acp',
] as const;

/** Platform-dependent install command surfaced when a CLI is missing. */
export interface InstallHint {
  /** Hint used on macOS / Linux. */
  readonly default: string;
  /** Hint used on Windows; falls back to `default` when omitted. */
  readonly win32?: string;
}

/** How the availability probe may inspect this client. */
export interface ClientProbeSpec {
  /**
   * `path-only` resolves the binary on PATH (and the well-known fallback dirs) and never
   * spawns anything. `path+version` additionally runs `versionArgs` — and is only invoked
   * when the caller opts in (see `CAT_PROVIDER_VERSION_PROBE`), because spawning third-party
   * agent CLIs for detection has produced orphaned CPU-burning processes before (LL-055).
   */
  readonly strategy: 'path-only' | 'path+version';
  /** Args for the version query; required when `strategy` is `path+version`. */
  readonly versionArgs?: readonly string[];
  /** Env var that, when set, means an API key for this provider is present. */
  readonly apiKeyEnv?: string;
}

export interface ClientDescriptor {
  readonly clientId: ClientId;
  /** Human-facing label. */
  readonly label: string;
  /**
   * CLI tool identity for surfaces that predate ClientId (first-run wizard).
   * `null` for providers with no local agent CLI.
   */
  readonly toolId: ClientToolId | null;
  /**
   * Candidate binary names, highest priority first. Also the reverse-lookup key for
   * `formatCliNotFoundError`, so it must list every name a caller may report.
   */
  readonly commands: readonly string[];
  /** Env override for the binary path, e.g. `CAT_ANTHROPIC_PATH`. */
  readonly pathEnvVar?: string;
  /** Default `cli` block written when a member is created without an explicit one. */
  readonly defaultCli: { readonly command: string; readonly outputFormat: string };
  /** Install hint for `commands[0]`. */
  readonly installHint: InstallHint;
  /**
   * Install hints for secondary commands whose fix differs from the primary one. Without
   * this, a member reported missing `gemini` would be told to install `agy`. Commands with
   * no entry here fall back to `installHint`.
   */
  readonly altInstallHints?: Readonly<Record<string, InstallHint>>;
  readonly probe: ClientProbeSpec;
  /**
   * Whether this client is backed by a locally spawned agent CLI. `false` means the
   * availability probe must not report it (no binary exists to find).
   */
  readonly localCli: boolean;
  /**
   * Whether `POST /api/cats` accepts this clientId. `a2a` is excluded: a remote A2A peer
   * needs `CAT_<ID>_A2A_URL` before it can be routed, so creating one through the member
   * editor would produce a permanently unroutable member.
   */
  readonly creatable: boolean;
}

const NO_LOCAL_CLI_PROBE: ClientProbeSpec = { strategy: 'path-only' };

export const CLIENT_DESCRIPTORS: readonly ClientDescriptor[] = [
  {
    clientId: 'anthropic',
    label: 'Claude',
    toolId: 'claude',
    commands: ['claude'],
    pathEnvVar: 'CAT_ANTHROPIC_PATH',
    defaultCli: { command: 'claude', outputFormat: 'stream-json' },
    installHint: { default: 'npm install -g @anthropic-ai/claude-code' },
    probe: { strategy: 'path+version', versionArgs: ['--version'], apiKeyEnv: 'ANTHROPIC_API_KEY' },
    localCli: true,
    creatable: true,
  },
  {
    clientId: 'openai',
    label: 'Codex',
    toolId: 'codex',
    commands: ['codex'],
    pathEnvVar: 'CAT_OPENAI_PATH',
    defaultCli: { command: 'codex', outputFormat: 'json' },
    installHint: { default: 'npm install -g @openai/codex' },
    probe: { strategy: 'path+version', versionArgs: ['--version'], apiKeyEnv: 'OPENAI_API_KEY' },
    localCli: true,
    creatable: true,
  },
  {
    clientId: 'google',
    label: 'Gemini',
    // `agy` is the Antigravity CLI and is what cat-template.json actually runs for
    // google-backed members; `gemini` stays as the legacy CLI fallback.
    toolId: 'agy',
    commands: ['agy', 'gemini'],
    pathEnvVar: 'CAT_GOOGLE_PATH',
    defaultCli: { command: 'agy', outputFormat: 'plainText' },
    installHint: {
      default: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
      win32:
        'curl.exe -fsSL https://antigravity.google/cli/install.cmd -o install.cmd && install.cmd && del install.cmd',
    },
    altInstallHints: { gemini: { default: 'npm install -g @google/gemini-cli' } },
    probe: { strategy: 'path-only', apiKeyEnv: 'GOOGLE_API_KEY' },
    localCli: true,
    creatable: true,
  },
  {
    clientId: 'kimi',
    label: 'Kimi',
    toolId: 'kimi',
    // The legacy `kimi-cli` is probed first by KimiAgentService; `kimi` is the official
    // Kimi Code binary that resolveCliCommand prefers under ~/.kimi-code/bin.
    commands: ['kimi-cli', 'kimi'],
    pathEnvVar: 'CAT_KIMI_PATH',
    defaultCli: { command: 'kimi', outputFormat: 'stream-json' },
    installHint: {
      default: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash',
      win32: 'irm https://code.kimi.com/kimi-code/install.ps1 | iex',
    },
    probe: { strategy: 'path-only', apiKeyEnv: 'MOONSHOT_API_KEY' },
    localCli: true,
    creatable: true,
  },
  {
    clientId: 'opencode',
    label: 'OpenCode',
    toolId: 'opencode',
    commands: ['opencode'],
    pathEnvVar: 'CAT_OPENCODE_PATH',
    defaultCli: { command: 'opencode', outputFormat: 'json' },
    installHint: { default: 'npm install -g opencode-ai' },
    probe: { strategy: 'path-only', apiKeyEnv: 'ANTHROPIC_API_KEY' },
    localCli: true,
    creatable: true,
  },
  {
    clientId: 'antigravity',
    label: 'Antigravity',
    toolId: null,
    // AntigravityAgentService drives the IDE over its ConnectRPC/CDP bridge, not a CLI.
    commands: [],
    defaultCli: { command: 'antigravity', outputFormat: 'json' },
    installHint: {
      default: 'install Antigravity and start its IDE bridge',
      win32: 'install Antigravity and start its IDE bridge',
    },
    probe: NO_LOCAL_CLI_PROBE,
    localCli: false,
    creatable: true,
  },
  {
    clientId: 'a2a',
    label: 'A2A Peer',
    toolId: null,
    commands: [],
    defaultCli: { command: 'a2a', outputFormat: 'json' },
    installHint: { default: 'no local CLI — configure CAT_<ID>_A2A_URL' },
    probe: NO_LOCAL_CLI_PROBE,
    localCli: false,
    creatable: false,
  },
  {
    clientId: 'catagent',
    label: 'CatAgent',
    toolId: null,
    // CatAgentService talks to a remote API directly.
    commands: [],
    defaultCli: { command: 'catagent', outputFormat: 'json' },
    installHint: { default: 'no local CLI needed' },
    probe: NO_LOCAL_CLI_PROBE,
    localCli: false,
    creatable: true,
  },
  {
    clientId: 'acp',
    label: 'ACP Client',
    toolId: null,
    // Generic ACP members supply their own command through `variant.acp.command`.
    commands: [],
    defaultCli: { command: 'acp', outputFormat: 'json' },
    installHint: { default: 'no local CLI needed' },
    probe: NO_LOCAL_CLI_PROBE,
    localCli: false,
    creatable: true,
  },
];

/** Descriptor for every ClientId; throws for an id the registry does not know. */
const BY_CLIENT_ID: ReadonlyMap<string, ClientDescriptor> = new Map(
  CLIENT_DESCRIPTORS.map((descriptor) => [descriptor.clientId, descriptor]),
);

/** Binary name → descriptor, for callers that only know the command they tried to spawn. */
const BY_COMMAND: ReadonlyMap<string, ClientDescriptor> = new Map(
  CLIENT_DESCRIPTORS.flatMap((descriptor) => descriptor.commands.map((command) => [command, descriptor] as const)),
);

export function getClientDescriptor(clientId: string): ClientDescriptor | undefined {
  return BY_CLIENT_ID.get(clientId);
}

/** Descriptor for the CLI binary `command`, or undefined if no descriptor claims it. */
export function getClientDescriptorByCommand(command: string): ClientDescriptor | undefined {
  return BY_COMMAND.get(command);
}

/** ClientIds accepted by `POST /api/cats`. */
export function creatableClientIds(): readonly ClientId[] {
  return CLIENT_DESCRIPTORS.filter((descriptor) => descriptor.creatable).map((descriptor) => descriptor.clientId);
}

/** ClientIds backed by a locally spawnable agent CLI (the only ones a probe may report). */
export function localCliClientIds(): readonly ClientId[] {
  return CLIENT_DESCRIPTORS.filter((descriptor) => descriptor.localCli).map((descriptor) => descriptor.clientId);
}

/**
 * Default `cli` block for a clientId. Unknown ids keep the historical fallback of using
 * the clientId itself as the command name, so a hand-edited catalog with an unrecognised
 * client still produces the shape it did before this registry existed.
 */
export function defaultCliForClient(clientId: string): { command: string; outputFormat: string } {
  const descriptor = getClientDescriptor(clientId);
  if (descriptor) return { ...descriptor.defaultCli };
  return { command: clientId, outputFormat: 'json' };
}

/**
 * Render the platform-appropriate install hint for a descriptor.
 *
 * `platform` is resolved lazily (`typeof process`) rather than as a default parameter so a
 * browser caller that omits it does not evaluate `process.platform` at all.
 */
export function formatInstallHint(descriptor: ClientDescriptor, platform?: NodeJS.Platform | string): string {
  const resolved = platform ?? (typeof process !== 'undefined' ? process.platform : 'linux');
  if (resolved === 'win32' && descriptor.installHint.win32) return descriptor.installHint.win32;
  return descriptor.installHint.default;
}

/**
 * Install hint for a bare command name, e.g. the `command` a caller passed to
 * `formatCliNotFoundError`. Returns undefined when no descriptor claims the command, so the
 * caller keeps its own generic fallback.
 */
export function installHintForCommand(command: string, platform?: NodeJS.Platform | string): string | undefined {
  const descriptor = getClientDescriptorByCommand(command);
  if (!descriptor) return undefined;
  const alt = descriptor.altInstallHints?.[command];
  const resolved = platform ?? (typeof process !== 'undefined' ? process.platform : 'linux');
  if (alt) return resolved === 'win32' && alt.win32 ? alt.win32 : alt.default;
  return formatInstallHint(descriptor, resolved);
}

/**
 * Availability status vocabulary, deliberately the same words the agent-hook health surface
 * uses (`configured | missing | unsupported | error`) so the UI needs one status language
 * rather than two.
 */
export type ProviderAvailabilityStatus = 'configured' | 'missing' | 'unsupported' | 'error';

/**
 * One provider's detected availability.
 *
 * This is the wire contract between the API and the web, defined here so both packages agree
 * on the shape instead of the web re-declaring it — re-declaration is exactly how the ClientId
 * whitelist drifted into five copies in the first place.
 */
export interface ProviderAvailability {
  clientId: ClientId;
  /** CLI tool identity, or null for clients with no local binary. */
  toolId: ClientToolId | null;
  label: string;
  installed: boolean;
  /** The binary that resolved; the first candidate when none did. */
  command: string;
  /** Absolute path when resolved; absent when missing. */
  resolvedPath?: string;
  /**
   * How the binary was found. `env-override` means the `CAT_<CLIENT>_PATH` escape hatch was
   * used, which is how an operator pins a binary that is not on the process's PATH.
   */
  resolvedVia: 'env-override' | 'path' | 'unavailable';
  /** Only populated when version probing is enabled and the CLI answered. */
  version?: string;
  /** Whether an API key env var for this provider is present (does not prove auth works). */
  hasApiKey: boolean;
  status: ProviderAvailabilityStatus;
  /** Actionable reason when status is not `configured`. */
  reason?: string;
  /** Copy-pasteable install command. */
  installHint: string;
  /** False for clients backed by a bridge/remote instead of a spawnable CLI. */
  localCli: boolean;
}

export interface ProviderAvailabilityReport {
  detectedAt: string;
  /** Whether this report attempted version probes. */
  versionProbeEnabled: boolean;
  providers: ProviderAvailability[];
}
