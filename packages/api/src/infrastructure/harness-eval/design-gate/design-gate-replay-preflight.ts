/**
 * F192 R4 — Design-gate replay identity preflight + source equivalence check.
 *
 * Scans both live-tree AND origin/main bundles for window collision against the
 * incoming DesignGateEpisodeSourceSelector, then compares sourceMapId to
 * distinguish exact replays from real conflicts.
 *
 * R4 fixes:
 * - Scans origin/main via FreshMainReader (stale-live-tree replay detection)
 * - SourceEquivalenceCheck falls back to origin/main when live tree misses bundle
 *
 * @module
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  ReplayPreflight,
  ReplayPreflightResult,
  SourceEquivalenceCheck,
  VerdictSourceRefs,
} from '../publish-verdict/types.js';
import type { DesignGateEpisodeSourceSelector } from './design-gate-types.js';

function isDesignGateSelector(refs: VerdictSourceRefs): refs is DesignGateEpisodeSourceSelector {
  return 'kind' in refs && refs.kind === 'design-gate-episode-source-map' && 'sourceMapId' in refs;
}

interface BundleWindow {
  startMs: number;
  endMs: number;
}

// --- JSON parsers (work with string content, no file path dependency) ---

function parseDomainIdFromJson(json: string): string | null {
  try {
    const lcRoot = JSON.parse(json);
    return typeof lcRoot?.domainId === 'string' ? lcRoot.domainId : null;
  } catch {
    return null;
  }
}

function parseWindowFromJson(json: string): BundleWindow | null {
  try {
    const snapshot = JSON.parse(json);
    if (typeof snapshot?.window?.startMs === 'number' && typeof snapshot?.window?.endMs === 'number') {
      return { startMs: snapshot.window.startMs, endMs: snapshot.window.endMs };
    }
  } catch {
    // corrupt → null
  }
  return null;
}

function parseSourceMapIdFromJson(json: string): string | null {
  try {
    const refs = JSON.parse(json);
    return typeof refs?.selector?.sourceMapId === 'string' ? refs.selector.sourceMapId : null;
  } catch {
    return null;
  }
}

// --- File-path-based readers (live tree — equivalence check fallback only) ---

async function readStoredSourceMapId(bundlePath: string): Promise<string | null> {
  try {
    return parseSourceMapIdFromJson(await readFile(resolve(bundlePath, 'raw', 'episode-source-refs.json'), 'utf-8'));
  } catch {
    return null;
  }
}

// --- Collision checker for a single bundle ---

async function checkBundleCollision(
  domainId: string,
  window: BundleWindow,
  sourceMapId: string,
  bundleEntry: string,
  readDomainId: () => Promise<string | null>,
  readWindow: () => Promise<BundleWindow | null>,
  readSourceMapId: () => Promise<string | null>,
): Promise<ReplayPreflightResult | null> {
  const storedDomain = await readDomainId();
  if (storedDomain !== domainId) return null;

  const storedWindow = await readWindow();
  if (!storedWindow) return null;
  if (storedWindow.startMs !== window.startMs || storedWindow.endMs !== window.endMs) return null;

  // Window collision — compare source identity
  const storedMapId = await readSourceMapId();
  if (storedMapId === null) {
    return {
      kind: 'conflict',
      storedVerdictId: bundleEntry,
      detail: `Window matches existing verdict ${bundleEntry} but stored bundle has no source identity (incomplete/orphan)`,
    };
  }
  if (storedMapId === sourceMapId) {
    return { kind: 'replay', storedVerdictId: bundleEntry };
  }
  return {
    kind: 'conflict',
    storedVerdictId: bundleEntry,
    detail: `Window matches existing verdict ${bundleEntry} but source differs (stored sourceMapId: ${storedMapId}, incoming: ${sourceMapId})`,
  };
}

// --- Preflight helpers (extracted to keep cognitive complexity ≤ 15) ---

function parseWindowFromYaml(content: string): BundleWindow | null {
  const startMatch = content.match(/startMs:\s*(\d+)/);
  const endMatch = content.match(/endMs:\s*(\d+)/);
  if (!startMatch || !endMatch) return null;
  return { startMs: Number(startMatch[1]), endMs: Number(endMatch[1]) };
}

async function scanMainBundles(
  mainReader: import('../publish-verdict/types.js').FreshMainReader,
  domainId: string,
  window: BundleWindow,
  sourceMapId: string,
): Promise<ReplayPreflightResult | null> {
  for (const entry of await mainReader.listBundleEntries()) {
    const result = await checkBundleCollision(
      domainId,
      window,
      sourceMapId,
      entry,
      async () => parseDomainIdFromJson((await mainReader.readFile(`bundles/${entry}/lifecycle-root.json`)) ?? ''),
      async () => parseWindowFromJson((await mainReader.readFile(`bundles/${entry}/snapshot.json`)) ?? ''),
      async () =>
        parseSourceMapIdFromJson((await mainReader.readFile(`bundles/${entry}/raw/episode-source-refs.json`)) ?? ''),
    );
    if (result) return result;
  }
  return null;
}

/**
 * Design-gate replay identity preflight. Zero side effects for exact replays:
 * scans origin/main for matching (domain, window) and compares sourceMapId.
 *
 * - Same sourceMapId on main -> 'replay' (no_new_window, publisher skipped)
 * - Different sourceMapId on main -> 'conflict' (409)
 * - Missing source identity in stored bundle -> 'conflict' (fail closed)
 * - No window collision -> null (proceed to publish)
 * - No mainReader (git fetch failed) -> null (fail closed, publisher handles)
 *
 * R7: origin/main is the SOLE authority for replay detection. Live-tree
 * scanning is only for conflict detection (different source in-flight).
 * A live-only same-source bundle is an in-flight publication, not canonical
 * proof — return null to let the publisher handle it authoritatively.
 */
export const designGateReplayPreflight: ReplayPreflight = async (sourceRefs, ctx) => {
  if (!isDesignGateSelector(sourceRefs)) return null;

  // R6: fail closed without fresh-main reader. Without canonical origin/main
  // verification, stale live-tree bundles could suppress authoritative identity.
  // Let the publisher's own worktree check handle it instead.
  if (!ctx.mainReader) return null;

  // R6/R10: resolve incoming window from origin/main ONLY for typed success.
  // Live-tree source maps may allow publication to proceed (return null),
  // but MUST NOT supply the window for a terminal typed success proof.
  const sourceMapRelPath = `design-gate/source-maps/${sourceRefs.sourceMapId}.yaml`;
  const mainContent = await ctx.mainReader.readFile(sourceMapRelPath);
  const incomingWindow = mainContent ? parseWindowFromYaml(mainContent) : null;

  if (!incomingWindow) {
    // R10: main source-map unavailable (absent or read error).
    // Cannot distinguish — proceed to publisher for authoritative check.
    // Live YAML is NOT used for typed success proof.
    return null;
  }

  // R8: Main is the SOLE authority for ALL terminal replay/conflict decisions.
  const mainResult = await scanMainBundles(ctx.mainReader, ctx.domainId, incomingWindow, sourceRefs.sourceMapId);
  if (mainResult) return mainResult;
  return null;
};

/**
 * Design-gate source equivalence check for catch-block defense layer.
 * Reads the stored bundle's raw/episode-source-refs.json and compares
 * sourceMapId with the incoming sourceRefs.
 *
 * R9: When mainReader is available and main has the bundle, source identity
 * MUST come from main. readFile() returns null for both "absent" and "git
 * show error" — either way, when the bundle IS on main, that null means
 * the source identity is incomplete/corrupt on the canonical source. We
 * must fail closed, NOT fall back to live tree where stale matching data
 * could turn canonical proof failure into typed success.
 *
 * Live-tree fallback is only used when main does NOT have the bundle at all
 * (backward compat for in-flight data not yet on main).
 *
 * Throws if the stored bundle is incomplete (fail closed -> 409).
 */
export const designGateSourceEquivalenceCheck: SourceEquivalenceCheck = async (
  storedVerdictId,
  incomingSourceRefs,
  ctx,
) => {
  if (!isDesignGateSelector(incomingSourceRefs)) return false;

  if (ctx.mainReader) {
    // R10: Check ALL canonical artifacts for this verdict, not just lifecycle.
    // If main has ANY artifact (verdict file OR lifecycle), this is a canonical
    // entity and source identity MUST come from main — never live tree.
    // A verdict-only artifact on main is an incomplete/orphan bundle.
    const mainHasBundle = (await ctx.mainReader.readFile(`bundles/${storedVerdictId}/lifecycle-root.json`)) !== null;
    const mainHasVerdict = (await ctx.mainReader.readFile(`verdicts/${storedVerdictId}.md`)) !== null;

    if (mainHasBundle || mainHasVerdict) {
      // Canonical artifact exists — source MUST come from main.
      // readFile null = absent or git show error; either way fail closed.
      const srcJson = await ctx.mainReader.readFile(`bundles/${storedVerdictId}/raw/episode-source-refs.json`);
      const storedSourceMapId = srcJson ? parseSourceMapIdFromJson(srcJson) : null;
      if (storedSourceMapId === null) {
        throw new Error(
          `Stored verdict ${storedVerdictId} has no source identity on canonical main (incomplete/corrupt bundle)`,
        );
      }
      return storedSourceMapId === incomingSourceRefs.sourceMapId;
    }
    // Main doesn't have any artifact for this verdict — fall through to live tree
  }

  // No mainReader or main has no artifact for this verdict — fall back to live tree
  const storedSourceMapId = await readStoredSourceMapId(resolve(ctx.harnessFeedbackRoot, 'bundles', storedVerdictId));
  if (storedSourceMapId === null) {
    throw new Error(`Stored verdict ${storedVerdictId} has no source identity (incomplete/orphan bundle)`);
  }
  return storedSourceMapId === incomingSourceRefs.sourceMapId;
};

/**
 * R12: Resolve domain-scoped replay deps for the publish-verdict handler.
 * Returns preflight + source equivalence when domainId matches, empty otherwise.
 * Keeps eval-hub route under the 350-line cap by centralizing domain dispatch.
 */
export function resolveDesignGateReplayDeps(domainId: string): {
  replayPreflight?: ReplayPreflight;
  checkStoredSourceEquivalence?: SourceEquivalenceCheck;
} {
  if (domainId !== 'eval:design-gate') return {};
  return {
    replayPreflight: designGateReplayPreflight,
    checkStoredSourceEquivalence: designGateSourceEquivalenceCheck,
  };
}
