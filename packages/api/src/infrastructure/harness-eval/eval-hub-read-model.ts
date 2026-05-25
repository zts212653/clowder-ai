import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { resolveA2aEvidenceBundle } from './eval-a2a-artifact-resolver.js';
import { type EvalDomainRegistryEntry, parseEvalDomainRegistryFile } from './eval-domain-registry.js';

type CountRecord = Record<string, number | null>;

export interface LoadEvalHubSummaryInput {
  harnessFeedbackRoot: string;
}

export interface EvalHubSummary {
  generatedAt: string;
  counts: {
    total: number;
    actionable: number;
    keepObserve: number;
    stale: number;
  };
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
}

interface ParsedVerdictMarkdown {
  id: string;
  path: string;
  frontmatter: Record<string, unknown>;
  markdown: string;
}

export function loadEvalHubSummary(input: LoadEvalHubSummaryInput): EvalHubSummary {
  const verdictsDir = join(input.harnessFeedbackRoot, 'verdicts');
  const domains = loadDomains(input.harnessFeedbackRoot);
  const items = readdirSync(verdictsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => parseVerdictMarkdown(join(verdictsDir, entry.name)))
    .filter((verdict) => verdict.frontmatter.feedback_type === 'live-verdict')
    .map((verdict) => buildEvalHubItem(input.harnessFeedbackRoot, verdict, domains))
    .sort((a, b) => b.trend.generatedAt.localeCompare(a.trend.generatedAt));

  return {
    generatedAt: new Date().toISOString(),
    counts: {
      total: items.length,
      actionable: items.filter((item) => item.verdict !== 'keep_observe').length,
      keepObserve: items.filter((item) => item.verdict === 'keep_observe').length,
      stale: items.filter((item) => item.lifecycle.stale).length,
    },
    items,
  };
}

function buildEvalHubItem(
  harnessFeedbackRoot: string,
  verdict: ParsedVerdictMarkdown,
  domains: Map<EvalDomainRegistryEntry['domainId'], EvalDomainRegistryEntry>,
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
      stale: false,
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
  };
}

function parseVerdictMarkdown(path: string): ParsedVerdictMarkdown {
  const markdown = readFileSync(path, 'utf8');
  const frontmatter = parseFrontmatter(markdown);
  return {
    id: basename(path, '.md'),
    path,
    frontmatter,
    markdown,
  };
}

function parseFrontmatter(markdown: string): Record<string, unknown> {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match?.[1]) return {};
  const parsed = parseYaml(match[1]);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

function loadDomains(harnessFeedbackRoot: string): Map<EvalDomainRegistryEntry['domainId'], EvalDomainRegistryEntry> {
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

function extractBullet(markdown: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = markdown.match(new RegExp(`^- ${escaped}:\\s*(.+)$`, 'm'));
  return match?.[1]?.trim();
}

function extractEvidenceRefs(markdown: string): EvalHubItem['evidence'] {
  const lines = markdown.split('\n').map((line) => line.trim());
  const evidenceStart = lines.findIndex((line) => line === 'Evidence:');
  const refs = evidenceStart === -1 ? [] : extractEvidenceSectionRefs(lines.slice(evidenceStart + 1));
  return {
    snapshotRefs: refs.filter((ref) => ref.startsWith('snapshot:')),
    attributionRefs: refs.filter((ref) => ref.startsWith('attribution:')),
    metricRefs: refs.filter((ref) => ref.startsWith('metric:')),
    otherRefs: refs.filter(
      (ref) => !ref.startsWith('snapshot:') && !ref.startsWith('attribution:') && !ref.startsWith('metric:'),
    ),
  };
}

function extractEvidenceSectionRefs(lines: string[]): string[] {
  const refs: string[] = [];
  for (const line of lines) {
    if (isMarkdownSectionHeading(line)) break;
    if (line.startsWith('- ')) refs.push(line.slice(2).trim());
  }
  return refs;
}

function isMarkdownSectionHeading(line: string): boolean {
  if (line.length === 0 || line.startsWith('- ')) return false;
  return line.endsWith(':') || /^#{1,6}\s+/.test(line);
}

function parseHarness(value: string | undefined): EvalHubItem['harnessUnderEval'] {
  const text = requiredText(value, 'harness');
  const match = text.match(/^([^/]+)\/([^\s]+)\s+\((.+)\)$/);
  if (!match) throw new Error(`invalid harness format: ${text}`);
  return {
    featureId: match[1],
    componentId: match[2],
    name: match[3],
  };
}

function requiredVerdict(value: string | undefined): EvalHubItem['verdict'] {
  const normalized = requiredText(value, 'verdict').replaceAll('`', '');
  if (
    normalized === 'delete_sunset' ||
    normalized === 'build' ||
    normalized === 'fix' ||
    normalized === 'keep_observe'
  ) {
    return normalized;
  }
  throw new Error(`unknown verdict: ${normalized}`);
}

function requiredText(value: string | undefined, field: string): string {
  if (!value || value.trim().length === 0) throw new Error(`${field} is required`);
  return value.trim();
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${field} is required`);
  return value;
}

function repoRelative(repoRoot: string, path: string): string {
  return relative(repoRoot, path).replaceAll('\\', '/');
}
