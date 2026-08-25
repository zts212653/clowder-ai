import { parse as parseYaml } from 'yaml';

import {
  type DesignGateEpisodeSource,
  type DesignGateGitTruth,
  type DesignGatePullRequestEvidence,
  type DesignGatePullRequestReader,
  type DesignGateReviewMessageReader,
  landedAlphaReceiptSchema,
  type ResolvedDesignGateEpisode,
} from './design-gate-types.js';

const PR_REF = /^github:pr:([^/\s]+\/[^#\s]+)#([1-9]\d*)$/;
const GIT_REF = /^git:([0-9a-f]{40})$/;
const REVIEW_MESSAGE_REF = /^cat-cafe:thread:([^/\s]+)\/message:([^\s]+)$/;
const REVIEW_VERDICT_REF = /^local-review:([^:\s]+):g([1-9]\d*):(approved|changes_requested|commented)$/;

interface RepoRefEvidence {
  path: string;
  anchor: string | undefined;
  content: string;
}

interface ResolveDesignGateEpisodeDeps {
  pullRequestReader: DesignGatePullRequestReader;
  reviewMessageReader: DesignGateReviewMessageReader;
  gitTruth: DesignGateGitTruth;
  readRepoRef(ref: string): RepoRefEvidence;
}

export async function resolveDesignGateEpisode(
  source: DesignGateEpisodeSource,
  deps: ResolveDesignGateEpisodeDeps,
): Promise<ResolvedDesignGateEpisode> {
  const reasons: string[] = [];
  const sourceRefs = uniqueRefs(source);
  const admission = resolveAdmission(source, deps, reasons);
  const pr = await resolvePullRequest(source, deps, reasons);
  const reviewerCatId = await resolveReview(source, admission.authorCatId, deps, reasons);
  const consequence = await resolveLandedAlpha(source, pr, deps, reasons, sourceRefs);

  return {
    episodeId: source.episodeId,
    featureId: source.featureId,
    authorCatId: admission.authorCatId,
    reviewerCatId,
    eligibility: {
      eligible: admission.eligible,
      trigger: admission.eligible ? 'preservation_boundary_delta' : null,
    },
    consequence,
    sourceRefs: [...new Set(sourceRefs)].sort(),
    validation: { status: reasons.length === 0 ? 'valid' : 'invalid', reasons },
  };
}

function resolveAdmission(
  source: DesignGateEpisodeSource,
  deps: ResolveDesignGateEpisodeDeps,
  reasons: string[],
): { authorCatId: string | null; eligible: boolean } {
  try {
    const admission = deps.readRepoRef(source.admissionRef);
    assertAnchor(admission, source.admissionRef);
    const authorCatId = /^description_author:\s*([a-z0-9-]+)\s*$/m.exec(admission.content)?.[1] ?? null;
    if (!authorCatId) reasons.push('eligible admission has no canonical description_author');
    const normalizedAdmission = anchoredSection(admission, source.admissionRef).toLowerCase().replace(/\*\*/g, '');
    const hasEvidencePacket =
      /map delta:\s*none/.test(normalizedAdmission) &&
      ['canonical source', 'consumer evidence', 'claim guard'].every((needle) => normalizedAdmission.includes(needle));
    if (!hasEvidencePacket) reasons.push('eligible admission is missing the preservation evidence packet');

    const triggerContract = deps.readRepoRef(source.triggerContractRef);
    assertAnchor(triggerContract, source.triggerContractRef);
    const hasTrigger = anchoredSection(triggerContract, source.triggerContractRef).includes(
      'preservation_boundary_delta',
    );
    if (!hasTrigger) reasons.push('trigger contract does not define preservation_boundary_delta');
    return { authorCatId, eligible: hasEvidencePacket && hasTrigger };
  } catch (error) {
    reasons.push(sourceFailure('eligible admission', error));
    return { authorCatId: null, eligible: false };
  }
}

async function resolvePullRequest(
  source: DesignGateEpisodeSource,
  deps: ResolveDesignGateEpisodeDeps,
  reasons: string[],
): Promise<DesignGatePullRequestEvidence | null> {
  try {
    const pr = await deps.pullRequestReader.resolve(source.pullRequestRef);
    assertPullRequest(source, pr, deps, reasons);
    return pr;
  } catch (error) {
    reasons.push(sourceFailure('pull request', error));
    return null;
  }
}

async function resolveReview(
  source: DesignGateEpisodeSource,
  authorCatId: string | null,
  deps: ResolveDesignGateEpisodeDeps,
  reasons: string[],
): Promise<string | null> {
  try {
    const reviewRef = parseReviewMessageRef(source.reviewMessageRef);
    const verdictRef = parseReviewVerdictRef(source.reviewVerdictRef);
    const review = await deps.reviewMessageReader.getById(reviewRef.messageId);
    if (!review) throw new Error('review message unavailable');
    if (
      review.id !== verdictRef.messageId ||
      review.id !== reviewRef.messageId ||
      review.threadId !== reviewRef.threadId
    ) {
      reasons.push('non-author review refs do not resolve to the same persisted message');
    }
    if (review.extra?.localReviewVerdict?.verdict !== verdictRef.verdict || verdictRef.verdict !== 'approved') {
      reasons.push('non-author review has no matching typed approved verdict');
    }
    if (!review.content.includes(parseGitRef(source.exactHeadRef))) {
      reasons.push('non-author review verdict is not bound to exact HEAD');
    }
    if (!review.catId || review.catId === authorCatId) reasons.push('non-author review requirement is not satisfied');
    return review.catId;
  } catch (error) {
    reasons.push(sourceFailure('non-author review', error));
    return null;
  }
}

async function resolveLandedAlpha(
  source: DesignGateEpisodeSource,
  pr: DesignGatePullRequestEvidence | null,
  deps: ResolveDesignGateEpisodeDeps,
  reasons: string[],
  sourceRefs: string[],
): Promise<ResolvedDesignGateEpisode['consequence']> {
  try {
    const alpha = landedAlphaReceiptSchema.parse(parseYaml(deps.readRepoRef(source.landedAlphaReceiptRef).content));
    const serviceNames = new Set(alpha.services.map((service) => service.name));
    if (!serviceNames.has('api') || !serviceNames.has('web')) {
      reasons.push('landed Alpha receipt must contain API and web success receipts');
    }
    if (alpha.earlierSelfCheckRef !== source.gateReceiptRef) {
      reasons.push('landed Alpha does not distinguish and bind the earlier self-check receipt');
    }
    if (pr?.mergeSha && alpha.includedMergeRevision !== pr.mergeSha) {
      reasons.push('landed Alpha included merge revision does not match the PR merge');
    }
    if (!(await deps.gitTruth.isOriginMainAncestor(alpha.landedRevision))) {
      reasons.push('landed Alpha revision is not retained by canonical origin/main');
    }
    if (!(await deps.gitTruth.isAncestor(alpha.includedMergeRevision, alpha.landedRevision))) {
      reasons.push('landed Alpha revision does not contain the merge revision');
    }
    if (alpha.consequence.kind === 'escape_observed') {
      deps.readRepoRef(alpha.consequence.incidentRef);
      deps.readRepoRef(alpha.consequence.fixAttributionRef);
      sourceRefs.push(alpha.consequence.incidentRef, alpha.consequence.fixAttributionRef);
    }
    sourceRefs.push(alpha.consequence.evidenceRef);
    return alpha.consequence;
  } catch (error) {
    reasons.push(sourceFailure('landed Alpha consequence', error));
    return null;
  }
}

function assertPullRequest(
  source: DesignGateEpisodeSource,
  pr: DesignGatePullRequestEvidence,
  deps: ResolveDesignGateEpisodeDeps,
  reasons: string[],
): void {
  const expectedPr = parsePullRequestRef(source.pullRequestRef);
  const expectedHead = parseGitRef(source.exactHeadRef);
  if (pr.repoFullName !== expectedPr.repoFullName || pr.number !== expectedPr.number) {
    reasons.push('pull request identity does not match the canonical ref');
  }
  if (pr.state !== 'MERGED' || !pr.mergeSha) reasons.push('pull request is not merged with a merge revision');
  if (pr.headSha !== expectedHead) reasons.push('pull request exact HEAD does not match the episode ref');
  if (!pr.body.includes('Map delta: none')) reasons.push('pull request lacks the preservation claim');
  if (!pr.body.includes(`Exact target: \`${expectedHead}\``) || !/`pnpm gate`\s*[—-]\s*PASS/.test(pr.body)) {
    reasons.push('gate/self-check receipt is missing or not bound to exact HEAD');
  }
  if (!source.gateReceiptRef.startsWith(`github:pr:${pr.repoFullName}#${pr.number}@${expectedHead}#validation/`)) {
    reasons.push('gate receipt ref is not bound to PR exact HEAD');
  }
  for (const ref of source.consumerBoundaryRefs) {
    const path = deps.readRepoRef(ref).path;
    if (!pr.changedFiles.includes(path)) reasons.push(`declared consumer boundary is absent from PR diff: ${path}`);
  }
}

function assertAnchor(evidence: RepoRefEvidence, ref: string): void {
  if (!evidence.anchor) throw new Error(`repo doc ref must include an anchor: ${ref}`);
  const anchors = evidence.content
    .split('\n')
    .filter((line) => /^#{1,6}\s+/.test(line))
    .map((line) => headingAnchor(line.replace(/^#{1,6}\s+/, '')));
  if (!anchors.includes(evidence.anchor)) throw new Error(`repo doc anchor unavailable: ${ref}`);
}

function anchoredSection(evidence: RepoRefEvidence, ref: string): string {
  if (!evidence.anchor) throw new Error(`repo doc ref must include an anchor: ${ref}`);
  const lines = evidence.content.split('\n');
  const start = lines.findIndex((line) => {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    return heading?.[2] !== undefined && headingAnchor(heading[2]) === evidence.anchor;
  });
  if (start === -1) throw new Error(`repo doc anchor unavailable: ${ref}`);
  const level = /^(#{1,6})\s+/.exec(lines[start] ?? '')?.[1]?.length;
  if (!level) throw new Error(`repo doc anchor unavailable: ${ref}`);
  const end = lines.findIndex((line, index) => index > start && new RegExp(`^#{1,${level}}\\s+`).test(line));
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
}

function headingAnchor(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function parsePullRequestRef(ref: string): { repoFullName: string; number: number } {
  const match = PR_REF.exec(ref);
  if (!match?.[1] || !match[2]) throw new Error(`invalid GitHub PR ref: ${ref}`);
  return { repoFullName: match[1], number: Number(match[2]) };
}

function parseGitRef(ref: string): string {
  const match = GIT_REF.exec(ref);
  if (!match?.[1]) throw new Error(`invalid exact HEAD ref: ${ref}`);
  return match[1];
}

function parseReviewMessageRef(ref: string): { threadId: string; messageId: string } {
  const match = REVIEW_MESSAGE_REF.exec(ref);
  if (!match?.[1] || !match[2]) throw new Error(`invalid review message ref: ${ref}`);
  return { threadId: match[1], messageId: match[2] };
}

function parseReviewVerdictRef(ref: string): { messageId: string; verdict: string } {
  const match = REVIEW_VERDICT_REF.exec(ref);
  if (!match?.[1] || !match[3]) throw new Error(`invalid local review verdict ref: ${ref}`);
  return { messageId: match[1], verdict: match[3] };
}

function uniqueRefs(source: DesignGateEpisodeSource): string[] {
  return [
    source.admissionRef,
    source.triggerContractRef,
    ...source.consumerBoundaryRefs,
    source.pullRequestRef,
    source.exactHeadRef,
    source.gateReceiptRef,
    source.reviewMessageRef,
    source.reviewVerdictRef,
    source.landedAlphaReceiptRef,
  ];
}

function sourceFailure(label: string, error: unknown): string {
  return `${label} source invalid: ${error instanceof Error ? error.message : String(error)}`;
}
