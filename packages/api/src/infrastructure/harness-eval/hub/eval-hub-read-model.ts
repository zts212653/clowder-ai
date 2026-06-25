import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { resolveA2aEvidenceBundle } from '../a2a/eval-a2a-artifact-resolver.js';
import { type EvalDomainRegistryEntry, parseEvalDomainRegistryFile } from '../domain/eval-domain-registry.js';
import { type EvalHubFrictionProjection, loadEvalHubFrictionProjection } from './eval-hub-friction-projection.js';
import {
  computeNextCronFire,
  computeStale,
  extractBullet,
  extractEvidenceRefs,
  markSupersededAsClosed,
  type ParsedVerdictMarkdown,
  parseHarness,
  parseVerdictMarkdown,
  repoRelative,
  requiredString,
  requiredText,
  requiredVerdict,
} from './eval-hub-read-model-helpers.js';

type CountRecord = Record<string, number | null>;

export interface LoadEvalHubSummaryInput {
  harnessFeedbackRoot: string;
  /**
   * Wall-clock reference for staleness checks. Defaults to `new Date()`.
   * Injectable so date-dependent regression tests don't drift over time.
   * F192 P2: enables `lifecycle.stale` lifecycle calculation (previously hardcoded false).
   */
  now?: Date;
}

export interface EvalDomainSummary {
  domainId: string;
  displayName: string;
  systemThreadId: string;
  frequency: string;
  evalCatId: string;
  evalCatHandle: string;
  /**
   * Sunset state. `false` means the domain's yaml has `enabled: false` —
   * scheduled cron silently skips it, and `nextCronFireAt` is omitted (because
   * cron does NOT fire for sunset domains; showing a future fire time would be
   * the operator-facing mirror of the silent-fire bug the sunset is meant to
   * fix). Frontend renders a "Sunset" indicator instead of "下次评估".
   * `true` (default) means the domain is active and the cron will fire as
   * scheduled.
   */
  enabled: boolean;
  hasVerdict: boolean;
  latestVerdictId?: string;
  latestVerdict?: EvalHubItem['verdict'];
  /**
   * Next scheduled cron fire time (computed from frequency, not verdict
   * re-eval deadline). Omitted when `enabled === false` — sunset domains
   * have no upcoming fire, and surfacing a future date would lie to operators.
   */
  nextCronFireAt?: string;
}

export interface EvalHubSummary {
  generatedAt: string;
  counts: {
    total: number;
    actionable: number;
    keepObserve: number;
    stale: number;
    registeredDomains: number;
  };
  domains: EvalDomainSummary[];
  items: EvalHubItem[];
}

export interface EvalHubItem {
  id: string;
  domainId: EvalDomainRegistryEntry['domainId'];
  packetId: string;
  feedbackType: 'live-verdict';
  verdict: 'delete_sunset' | 'build' | 'fix' | 'keep_observe';
  phenomenon: string;
  ownerAsk: string;
  harnessUnderEval: {
    featureId: string;
    componentId: string;
    name: string;
  };
  reeval: {
    nextEvalAt?: string;
    status: 'observing' | 'pending_owner' | 'pending_reeval';
    summary: string;
  };
  lifecycle: {
    ownerResponseStatus: 'not_required' | 'not_started';
    closureStatus: 'observing' | 'open';
    stale: boolean;
  };
  evidence: {
    snapshotRefs: string[];
    attributionRefs: string[];
    metricRefs: string[];
    otherRefs: string[];
  };
  trend: {
    generatedAt: string;
    window: {
      startMs?: number;
      endMs?: number;
      durationHours: number;
    };
    components: Array<{
      componentId: string;
      componentName: string;
      confidence: string;
      activationCounts: CountRecord;
      frictionCounts: CountRecord;
    }>;
  };
  systemWorkspace: {
    kind: 'eval_domain';
    id: EvalDomainRegistryEntry['domainId'];
    label: string;
    threadId: string;
    stateSot: 'registry';
  };
  source: {
    verdictPath: string;
    bundleDir: string;
  };
  friction?: EvalHubFrictionProjection;
}

export function loadEvalHubSummary(input: LoadEvalHubSummaryInput): EvalHubSummary {
  const verdictsDir = join(input.harnessFeedbackRoot, 'verdicts');
  const domains = loadDomains(input.harnessFeedbackRoot);
  const now = input.now ?? new Date();
  const items = readdirSync(verdictsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => parseVerdictMarkdown(join(verdictsDir, entry.name)))
    .filter((verdict) => verdict.frontmatter.feedback_type === 'live-verdict')
    .map((verdict) => buildEvalHubItem(input.harnessFeedbackRoot, verdict, domains, now))
    .sort((a, b) => b.trend.generatedAt.localeCompare(a.trend.generatedAt));

  // F192 P2 — supersede gating (PR 791 review).
  // Stale is a *lifecycle state of the active finding per domain*, not a property
  // every historical verdict carries. After sorting by trend.generatedAt desc, the
  // first item per domain is the active verdict; the rest have been closed by
  // re-eval (a newer live verdict landed) and must not count as stale even when
  // their own nextEvalAt has elapsed — otherwise counts.stale would accumulate
  // historical overdue verdicts forever and never return to zero, defeating the
  // re-eval closure loop the Hub exists to surface (AC-E7 / AC-E9).
  markSupersededAsClosed(items);

  // F192 livefix OQ-16: Build domain summaries for ALL registered domains,
  // including those without verdicts (e.g. eval:memory before first eval run).
  const domainSummaries: EvalDomainSummary[] = [...domains.values()].map((domain) => {
    const domainVerdicts = items.filter((item) => item.domainId === domain.domainId);
    const latest = domainVerdicts[0]; // items already sorted by date desc
    // Sunset 2026-06-06 (F192 silent-fire fix): when domain.enabled === false the
    // scheduled cron silently skips it, so we must NOT publish a future
    // nextCronFireAt — that would mirror silent-fire on the operator-facing surface
    // (Hub UI would say "next fire Sunday" while cron actually never fires).
    const isEnabled = domain.enabled !== false;
    return {
      domainId: domain.domainId,
      displayName: domain.displayName,
      systemThreadId: domain.systemThreadId,
      frequency: domain.frequency,
      evalCatId: domain.evalCat.catId,
      evalCatHandle: domain.evalCat.handle,
      enabled: isEnabled,
      hasVerdict: domainVerdicts.length > 0,
      ...(isEnabled ? { nextCronFireAt: computeNextCronFire(domain.frequency, now).toISOString() } : {}),
      ...(latest
        ? {
            latestVerdictId: latest.id,
            latestVerdict: latest.verdict,
          }
        : {}),
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    counts: {
      total: items.length,
      actionable: items.filter((item) => item.verdict !== 'keep_observe').length,
      keepObserve: items.filter((item) => item.verdict === 'keep_observe').length,
      stale: items.filter((item) => item.lifecycle.stale).length,
      registeredDomains: domainSummaries.length,
    },
    domains: domainSummaries,
    items,
  };
}

function buildEvalHubItem(
  harnessFeedbackRoot: string,
  verdict: ParsedVerdictMarkdown,
  domains: Map<EvalDomainRegistryEntry['domainId'], EvalDomainRegistryEntry>,
  now: Date,
): EvalHubItem {
  const verdictId = verdict.id;
  const bundleDir = join(harnessFeedbackRoot, 'bundles', verdictId);
  const repoRoot = dirname(dirname(harnessFeedbackRoot));
  let resolved: ReturnType<typeof resolveA2aEvidenceBundle>;
  try {
    resolved = resolveA2aEvidenceBundle({ bundleDir, verdictId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to resolve evidence bundle for ${verdictId}: ${message}`);
  }

  const domainId = requiredString(verdict.frontmatter.domain_id, 'domain_id') as EvalDomainRegistryEntry['domainId'];
  const domain = domains.get(domainId);
  if (!domain) {
    throw new Error(
      `unknown domain_id '${domainId}' in verdict ${verdictId}; registered domains: ${[...domains.keys()].join(', ')}`,
    );
  }

  const evidence = extractEvidenceRefs(verdict.markdown);
  const verdictValue = requiredVerdict(extractBullet(verdict.markdown, 'Verdict'));
  const phenomenon = requiredText(extractBullet(verdict.markdown, 'Phenomenon'), 'phenomenon');
  const ownerAsk = requiredText(extractBullet(verdict.markdown, 'Owner ask'), 'owner ask');
  const harness = parseHarness(extractBullet(verdict.markdown, 'Harness'));
  const reevalSummary = requiredText(extractBullet(verdict.markdown, 'Re-eval'), 're-eval');
  const nextEvalAt = reevalSummary.match(/\d{4}-\d{2}-\d{2}T[0-9:.]+Z/)?.[0];
  const friction = loadEvalHubFrictionProjection(domainId, bundleDir, repoRoot);

  return {
    id: verdictId,
    domainId,
    packetId: requiredString(verdict.frontmatter.packet_id, 'packet_id'),
    feedbackType: 'live-verdict',
    verdict: verdictValue,
    phenomenon,
    ownerAsk,
    harnessUnderEval: harness,
    reeval: {
      ...(nextEvalAt ? { nextEvalAt } : {}),
      status: verdictValue === 'keep_observe' ? 'observing' : 'pending_owner',
      summary: reevalSummary,
    },
    lifecycle: {
      ownerResponseStatus: verdictValue === 'keep_observe' ? 'not_required' : 'not_started',
      closureStatus: verdictValue === 'keep_observe' ? 'observing' : 'open',
      // F192 P2: stale = past the verdict's own re-eval deadline (nextEvalAt).
      // SLA reevalWithinHours is already absorbed into nextEvalAt at verdict-creation time,
      // so adding extra grace here would double-discount. A missing nextEvalAt cannot expire.
      stale: computeStale(nextEvalAt, now),
    },
    evidence,
    trend: {
      generatedAt: resolved.snapshot.generatedAt,
      window: resolved.snapshot.window,
      components: resolved.snapshot.components.map((component) => ({
        componentId: component.componentId,
        componentName: component.componentName,
        confidence: component.confidence,
        activationCounts: component.activationCounts,
        frictionCounts: component.frictionCounts,
      })),
    },
    systemWorkspace: {
      kind: 'eval_domain',
      id: domainId,
      label: domain.displayName,
      threadId: domain.systemThreadId,
      stateSot: domain.threadPolicy.stateSot,
    },
    source: {
      verdictPath: repoRelative(repoRoot, verdict.path),
      bundleDir: repoRelative(repoRoot, bundleDir),
    },
    ...(friction ? { friction } : {}),
  };
}

/** Loads all registered eval domains from YAML files. Exported for registry-only validation (e.g. PATCH override). */
export function loadDomains(
  harnessFeedbackRoot: string,
): Map<EvalDomainRegistryEntry['domainId'], EvalDomainRegistryEntry> {
  const domainsDir = join(harnessFeedbackRoot, 'eval-domains');
  if (!existsSync(domainsDir)) return new Map();
  const domains = new Map<EvalDomainRegistryEntry['domainId'], EvalDomainRegistryEntry>();
  for (const entry of readdirSync(domainsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.yaml')) continue;
    const parsed = parseYaml(readFileSync(join(domainsDir, entry.name), 'utf8'));
    const domain = parseEvalDomainRegistryFile(parsed);
    domains.set(domain.domainId, domain);
  }
  return domains;
}
