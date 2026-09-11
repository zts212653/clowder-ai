/**
 * F171: Detect which agent CLI clients are installed on the user's machine.
 * Only returns clients that are actually available for binding.
 *
 * LL-055 (src extension): never spawn agent runtimes for detection. Use
 * existence probes (`which`/`where`) only. Reason: complex CLIs like
 * `opencode` boot a full agent process for `opencode version`, ignore
 * SIGTERM on `exec` timeout, and macOS lacks PR_SET_PDEATHSIG so the
 * orphaned child burns CPU forever (PPID=1, ~67% CPU per leak observed
 * 2026-05-08). PATH probes can't spawn anything we have to babysit.
 *
 * This module is now a *projection* of the canonical detector
 * (`agents/providers/provider-detection.ts`). It used to carry its own five-entry CLI table,
 * which had drifted from the catalog: it probed `gemini` while four members in
 * cat-template.json actually run `agy`, so the wizard under-reported what was installed.
 * The ClientId → binary mapping now lives only in the shared descriptor registry.
 */

import { CLIENT_DESCRIPTORS, type ClientId, type ClientToolId } from '@cat-cafe/shared';
import {
  detectProviderAvailability,
  type ProviderAvailability,
  type ProviderDetectionDeps,
} from '../agents/providers/provider-detection.js';

export interface DetectedClient {
  /** Client ID — the CLI tool identity (claude, codex, agy, opencode, kimi) */
  client: ClientToolId;
  /** Provider key matching ClientValue in hub-cat-editor (anthropic, openai, etc.) */
  provider: ClientId;
  /** Human-readable label */
  label: string;
  /** Binary name that resolved, or the first candidate when nothing resolved */
  cli: string;
  /** Whether the CLI binary is found in PATH */
  installed: boolean;
  /**
   * Only populated when `CAT_PROVIDER_VERSION_PROBE=1`. Version probing is opt-in because it
   * spawns the CLI; see the module header.
   */
  version?: string;
  /** Whether an API key env var is set for this provider */
  hasApiKey: boolean;
  /** Copy-pasteable install command, so the wizard can show the fix instead of a static hint */
  installHint: string;
  /** Actionable reason when the CLI is not installed */
  reason?: string;
}

interface CliSpec {
  client: ClientToolId;
  provider: ClientId;
  label: string;
  /** Every candidate binary name, highest priority first. */
  commands: readonly string[];
  cli: string;
  envKey: string;
}

/** Descriptor-backed detection specs, highest-priority binary first. */
const CLI_SPECS: CliSpec[] = CLIENT_DESCRIPTORS.flatMap((descriptor) => {
  const command = descriptor.commands[0];
  if (!descriptor.localCli || descriptor.toolId === null || command === undefined) return [];
  return [
    {
      client: descriptor.toolId,
      provider: descriptor.clientId,
      label: descriptor.label,
      commands: descriptor.commands,
      cli: command,
      envKey: descriptor.probe.apiKeyEnv ?? '',
    },
  ];
});

/** Project one canonical availability record into the wizard's client shape. */
function toDetectedClient(provider: ProviderAvailability): DetectedClient | null {
  // The wizard only offers clients that a member could actually bind to a local CLI.
  if (!provider.localCli || provider.toolId === null) return null;
  return {
    client: provider.toolId,
    provider: provider.clientId,
    label: provider.label,
    cli: provider.command,
    installed: provider.installed,
    ...(provider.version ? { version: provider.version } : {}),
    hasApiKey: provider.hasApiKey,
    installHint: provider.installHint,
    ...(provider.reason ? { reason: provider.reason } : {}),
  };
}

/**
 * Detect all available CLI clients in parallel.
 * Pass detection deps from tests to avoid touching the real filesystem.
 */
export async function detectAvailableClients(deps?: ProviderDetectionDeps): Promise<DetectedClient[]> {
  const report = await detectProviderAvailability(deps);
  return report.providers.map(toDetectedClient).filter((client): client is DetectedClient => client !== null);
}

/** Return only clients that are installed. */
export async function getInstalledClients(deps?: ProviderDetectionDeps): Promise<DetectedClient[]> {
  const all = await detectAvailableClients(deps);
  return all.filter((c) => c.installed);
}

/** Exposed for tests — assert no spec carries a version-fetching command. */
export function getCliSpecsForTest(): readonly CliSpec[] {
  return CLI_SPECS;
}
