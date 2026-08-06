import { getEvalCatOverride } from '../domain/eval-domain-override.js';
import { loadDomains } from '../hub/eval-hub-read-model.js';
import { refreshMeasurementBundleCensusFile } from '../measurement/measurement-bundle-census-file.js';
import type { GitPublisher, HandlerError, RefreshPublishedVerdictPrResult } from './types.js';

const SAFE_VERDICT_ID = /^[a-z0-9][a-z0-9-]*$/;
const FULL_SHA = /^[a-f0-9]{40}$/;

export interface RefreshPublishedVerdictDeps {
  harnessFeedbackRoot: string;
  gitPublisher?: GitPublisher;
  redis?: Parameters<typeof getEvalCatOverride>[0];
  now?: () => Date;
}

export interface RefreshPublishedVerdictInput {
  domain: string;
  catId: string;
  verdictId: string;
  expectedHeadSha: string;
}

export type RefreshPublishedVerdictSuccess = { ok: true } & RefreshPublishedVerdictPrResult;

function validateInput(input: RefreshPublishedVerdictInput): HandlerError | null {
  if (!SAFE_VERDICT_ID.test(input.verdictId)) {
    return {
      status: 400,
      error: 'invalid_verdict_id',
      detail: 'verdictId must be a lowercase alphanumeric slug with optional hyphens',
    };
  }
  if (!FULL_SHA.test(input.expectedHeadSha)) {
    return {
      status: 400,
      error: 'invalid_expected_head_sha',
      detail: 'expectedHeadSha must be a full lowercase 40-character Git SHA',
    };
  }
  return null;
}

function mapRefreshError(message: string): HandlerError {
  const mappings: Array<[string, number]> = [
    ['verdict_pr_not_found', 404],
    ['verdict_pr_head_mismatch', 409],
    ['verdict_pr_local_branch_conflict', 409],
    ['verdict_pr_scope_invalid', 409],
    ['verdict_pr_refresh_conflict', 409],
    ['verdict_pr_ambiguous', 409],
  ];
  const matched = mappings.find(([prefix]) => message.startsWith(prefix));
  if (matched) return { status: matched[1], error: matched[0], detail: message };
  return { status: 500, error: 'verdict_pr_refresh_failed', detail: message };
}

export async function handleRefreshPublishedVerdict(
  deps: RefreshPublishedVerdictDeps,
  input: RefreshPublishedVerdictInput,
): Promise<RefreshPublishedVerdictSuccess | HandlerError> {
  const inputError = validateInput(input);
  if (inputError) return inputError;

  const domains = loadDomains(deps.harnessFeedbackRoot);
  const domainEntry = domains.get(input.domain as Parameters<typeof domains.get>[0]);
  if (!domainEntry) {
    return {
      status: 400,
      error: 'domain_not_registered',
      detail: `Domain '${input.domain}' not found in eval-domains/ registry`,
    };
  }

  let allowedCatId = domainEntry.evalCat.catId as string;
  let overrideApplied = false;
  if (deps.redis) {
    try {
      const override = await getEvalCatOverride(deps.redis, input.domain);
      if (override) {
        allowedCatId = override.catId;
        overrideApplied = true;
      }
    } catch {
      // Match publish behavior: a failed override read falls back to static registry truth.
    }
  }
  if (input.catId !== allowedCatId) {
    return {
      status: 403,
      error: 'not_allowed',
      detail: `catId '${input.catId}' is not the eval cat for domain '${input.domain}' (expected '${allowedCatId}'${overrideApplied ? ' via OQ-20 Redis override' : ' from registry'})`,
    };
  }

  if (!deps.gitPublisher?.refreshPublishedVerdictPr) {
    return {
      status: 501,
      error: 'refresh_not_wired',
      detail: 'The configured verdict publisher does not implement the refresh_pr lifecycle transition.',
    };
  }

  const domainSlug = input.domain.replace(/:/g, '-');
  try {
    const result = await deps.gitPublisher.refreshPublishedVerdictPr({
      branchName: `verdict/auto/${domainSlug}/${input.verdictId}`,
      verdictId: input.verdictId,
      expectedHeadSha: input.expectedHeadSha,
      generatedAt: (deps.now?.() ?? new Date()).toISOString(),
      refreshDerivedCensus: refreshMeasurementBundleCensusFile,
    });
    return { ok: true, ...result };
  } catch (error) {
    return mapRefreshError(error instanceof Error ? error.message : String(error));
  }
}
