/**
 * Provider availability — the wire contract between the API and the web.
 *
 * Split out of `client-descriptor.ts` so the registry module stays inside the repo's 350-line
 * file limit (`CONTRIBUTING.md`), and because these two things change for different reasons:
 * the registry describes *what a client is*, this describes *what detection observed*.
 *
 * Defined once here so both packages agree on the shape instead of the web re-declaring it —
 * re-declaration is exactly how the ClientId whitelist drifted into five copies.
 */

import type { ClientId } from './cat.js';
import type { ClientToolId } from './client-descriptor.js';

/**
 * Availability status vocabulary, deliberately the same words the agent-hook health surface
 * uses (`configured | missing | unsupported | error`) so the UI needs one status language
 * rather than two.
 */
export type ProviderAvailabilityStatus = 'configured' | 'missing' | 'unsupported' | 'error';

/** One provider's detected availability. */
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
  /**
   * Reserved, and **never populated**. Detection must not spawn the CLI (LL-055), so no code
   * path can produce a version. Kept so consumers that already render an optional version keep
   * compiling and simply render nothing, exactly as `DetectedClient.version` does.
   */
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
  providers: ProviderAvailability[];
}
