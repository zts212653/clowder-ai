/**
 * F213 Phase A: deprecated managed MCP server registry + marker-based identification.
 *
 * **Purpose**: When cat-cafe orchestrator no longer auto-provisions a managed MCP
 * server (e.g. `cat-cafe` all-in-one after F193 Phase C split-only migration), user
 * config files may still contain stale entries from before the deprecation. L5
 * startup cleanup (in `mcp-config-adapters.ts` writers) uses this registry to
 * **selectively remove** stale entries that we can prove we wrote ourselves —
 * while **preserving** third-party entries that happen to share the same server id.
 *
 * **Why selective marker matching matters** (F213 design decision, 砚砚 review
 * 2026-05-26 Q4): user may have a custom third-party server registered under the
 * `cat-cafe` name (e.g. a personal fork or experimental implementation). Naive
 * removal would destroy their config. Markers identify entries by their
 * known-managed shape (binary path suffix, documented workaround signature),
 * not just by server id.
 *
 * **Coordinate system reframe note** (PR #1894 → F213 2026-05-26): the prior
 * lookup-helper approach in CodexAgentService (5 rounds of cloud-codex P1) tried
 * to mirror codex CLI's own config-source lookup priority (user → project →
 * ancestor → CODEX_HOME → /etc). That was scaffolding — it side-stepped
 * recreating the codex internal behavior in our codebase, doomed to miss new
 * sources. The L5 startup cleanup approach (this module) removes the stale
 * entries *before* codex ever loads them, eliminating the lookup race entirely.
 *
 * See:
 * - `docs/features/F213-stale-mcp-config-cleanup.md`
 * - `docs/decisions/036-f209-retrieval-surface-multi-layer.md` (amended 2026-05-26)
 * - `docs/discussions/2026-05-26-codex-mcp-legacy-deprecation/README.md`
 */

/**
 * A marker that identifies an MCP server entry as our own (cat-cafe-managed)
 * deprecated entry. Used by `isOurOwnedDeprecatedEntry` to safely distinguish
 * "we wrote this in the past, now stale" from "user wrote this themselves
 * with the same server name" — third-party entries must be preserved.
 */
export type ManagedEntryMarker =
  | {
      kind: 'argsSuffix';
      /**
       * Suffix matched against `entry.args[0]` after `\` → `/` normalize.
       * E.g. `'packages/mcp-server/dist/index.js'` matches a path written by
       * our own capability orchestrator pre-F193 Phase C split.
       */
      value: string;
    }
  | {
      kind: 'echoLegacyShim';
      /**
       * Matches the workaround we documented in PR #1894 close comment:
       * `command="echo"` + `args=["legacy-shim"]`.
       */
      commandValue: 'echo';
      argsValue: 'legacy-shim';
    };

export interface DeprecatedManagedServer {
  /** MCP server id (e.g. `'cat-cafe'`). */
  readonly serverName: string;
  /** Why this server is deprecated (human-readable, used in log.warn). */
  readonly reason: string;
  /**
   * Markers that prove an entry was previously written by our own managed
   * orchestrator (safe to remove). Third-party entries with the same
   * `serverName` but no matching marker are preserved.
   */
  readonly knownManagedMarkers: readonly ManagedEntryMarker[];
  /** Optional: F number that introduced the deprecation (for traceability). */
  readonly deprecatedBy?: string;
}

export const DEPRECATED_MANAGED_SERVERS: readonly DeprecatedManagedServer[] = [
  {
    serverName: 'cat-cafe',
    reason:
      'F193 Phase C / F207 Phase B0 / F195 split-only migration: replaced by split servers (cat-cafe-collab, cat-cafe-memory, cat-cafe-signals, cat-cafe-limb, cat-cafe-audio, cat-cafe-finance)',
    // F213 砚砚 review 2026-05-26 P1: `argsSuffix` marker removed for safety —
    // any user fork at `/users/alice/forks/cat-cafe/packages/mcp-server/dist/index.js`
    // would falsely match suffix → mistakenly removed → third-party preservation
    // contract violated. Without a forward-only owner-tag mechanism (future
    // F213 Phase B+), there is no reliable ownership proof for historical
    // orchestrator-managed entries. Conservative answer: only delete entries
    // that match the specific `echoLegacyShim` workaround (third parties would
    // not coincidentally use this exact command + args combination). The L4
    // per-invocation dummy disabled override in `CodexAgentService.ts` ensures
    // runtime safety for legacy entries the L5 cleanup cannot prove ownership of.
    knownManagedMarkers: [{ kind: 'echoLegacyShim', commandValue: 'echo', argsValue: 'legacy-shim' }],
    deprecatedBy: 'F193 Phase C / F213',
  },
];

/**
 * Decide whether the given `entry` (parsed from existing `mcp_servers.<id>`
 * config) was written by our own managed orchestrator and is now safe to
 * remove. Returns `false` (= preserve) for any third-party / unknown shape.
 *
 * Defensive: any non-object / null / missing-args / non-string-args[0] input
 * returns `false`, never throws — this runs at startup time on user config
 * files of varying provenance.
 */
export function isOurOwnedDeprecatedEntry(serverName: string, entry: unknown): boolean {
  const deprecated = DEPRECATED_MANAGED_SERVERS.find((d) => d.serverName === serverName);
  if (!deprecated) return false;
  if (typeof entry !== 'object' || entry === null) return false;
  const entryRecord = entry as Record<string, unknown>;
  const command = entryRecord.command;
  const args = entryRecord.args;
  if (!Array.isArray(args) || args.length === 0) return false;
  const firstArg = args[0];
  if (typeof firstArg !== 'string') return false;
  for (const marker of deprecated.knownManagedMarkers) {
    if (marker.kind === 'argsSuffix') {
      const normalized = firstArg.replace(/\\/g, '/');
      if (normalized.endsWith(marker.value)) return true;
    } else if (marker.kind === 'echoLegacyShim') {
      if (command === marker.commandValue && firstArg === marker.argsValue) return true;
    }
  }
  return false;
}
