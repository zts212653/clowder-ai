import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { resolveA2aEvidenceBundle } from '../a2a/eval-a2a-artifact-resolver.js';
import {
  type EvalDomainRegistryEntry,
  isEvalDomainRegistryYamlFile,
  parseEvalDomainRegistryFile,
  parseEvalMetricGlossary,
} from '../domain/eval-domain-registry.js';
import { loadEvalHubFrictionProjection } from './eval-hub-friction-projection.js';
import { synthesizeEvalHubNextCheck, synthesizeEvalHubOperatorNarrative } from './eval-hub-operator-narrative.js';
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
import type {
  EvalDomainSummary,
  EvalHubItem,
  EvalHubSummary,
  LoadEvalHubSummaryInput,
} from './eval-hub-read-model-types.js';
import { resolveEvalHubRepoWorktreeId } from './eval-hub-repo-worktree-id.js';

export function loadEvalHubSummary(input: LoadEvalHubSummaryInput): EvalHubSummary {
  const verdictsDir = join(input.harnessFeedbackRoot, 'verdicts');
  const repoRoot = dirname(dirname(input.harnessFeedbackRoot));
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
  for (const item of items) {
    item.operatorNarrative.nextCheck = synthesizeEvalHubNextCheck(
      item.verdict,
      item.lifecycle.stale,
      item.operatorNarrative.evidenceQuality,
    );
  }

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
      // F248 Phase A — conditional spread keeps the optional display field out
      // of the summary when a domain omits it (exactOptional-safe), matching
      // how nextCronFireAt / latestVerdict are handled below.
      ...(domain.descriptionForHuman ? { descriptionForHuman: domain.descriptionForHuman } : {}),
      ...(domain.metricGlossary ? { metricGlossary: domain.metricGlossary } : {}),
      ...(isEnabled ? { nextCronFireAt: computeNextCronFire(domain.frequency, now).toISOString() } : {}),
      ...(latest
        ? {
            latestVerdictId: latest.id,
            latestVerdict: latest.verdict,
          }
        : {}),
    };
  });

  // F248 Phase C: use the workspace worktree-list contract (including
  // duplicate-basename suffixes) so summary consumers all get the same
  // canonical worktree id, not just the API route wrapper.
  const repoWorktreeId = resolveEvalHubRepoWorktreeId(repoRoot);

  return {
    generatedAt: new Date().toISOString(),
    repoProjectPath: repoRoot,
    repoWorktreeId,
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
  const stale = computeStale(nextEvalAt, now);

  return {
    id: verdictId,
    domainId,
    packetId: requiredString(verdict.frontmatter.packet_id, 'packet_id'),
    feedbackType: 'live-verdict',
    verdict: verdictValue,
    phenomenon,
    operatorNarrative: synthesizeEvalHubOperatorNarrative({
      verdict: verdictValue,
      domainDescription: domain.descriptionForHuman ?? domain.displayName,
      featureId: harness.featureId,
      snapshot: resolved.snapshot,
      attribution: resolved.attributionReport,
      ...(domain.metricGlossary ? { metricGlossary: domain.metricGlossary } : {}),
      stale,
    }),
    ownerAsk,
    harnessUnderEval: harness,
    reeval: {
      ...(nextEvalAt ? { nextEvalAt } : {}),
      status: verdictValue === 'keep_observe' ? 'observing' : 'pending_owner',
      summary: reevalSummary,
    },
    lifecycle:
      verdictValue === 'keep_observe'
        ? {
            availability: 'not_required',
            ownerResponseStatus: 'not_required',
            closureStatus: 'observing',
            reevalStatus: 'not_required',
            stale,
          }
        : {
            availability: 'unavailable',
            ownerResponseStatus: 'unavailable',
            closureStatus: 'unavailable',
            reevalStatus: 'unavailable',
            stale,
            unavailableReason: 'canonical lifecycle event log unavailable',
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
    if (!entry.isFile() || !isEvalDomainRegistryYamlFile(entry.name)) continue;
    const parsed = parseYaml(readFileSync(join(domainsDir, entry.name), 'utf8'));
    const domain = parseEvalDomainRegistryFile(parsed);
    if (domain.metricGlossaryRef) {
      const sidecar = parseYaml(readFileSync(join(domainsDir, domain.metricGlossaryRef), 'utf8'));
      domain.metricGlossary = { ...parseEvalMetricGlossary(sidecar), ...domain.metricGlossary };
    }
    domains.set(domain.domainId, domain);
  }
  return domains;
}
