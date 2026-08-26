import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';

import {
  type DesignGateEpisodeBundle,
  type DesignGateEpisodeSourceMap,
  type DesignGateEpisodeSourceSelector,
  type DesignGateGitTruth,
  type DesignGatePullRequestReader,
  type DesignGateReviewMessageReader,
  designGateEpisodeSelectorSchema,
  designGateEpisodeSourceMapSchema,
  type ResolvedDesignGateEpisode,
} from './design-gate-types.js';
import { resolveDesignGateEpisode } from './resolve-design-gate-episode.js';

const SOURCE_MAP_ROOT = 'docs/harness-feedback/design-gate/source-maps';
const FOUR_WEEKS_MS = 28 * 24 * 60 * 60 * 1_000;
const REPO_REF = /^repo:([^#]+)(?:#(.+))?$/;

export interface DesignGateEpisodeSourceProvider {
  resolve(selector: DesignGateEpisodeSourceSelector): Promise<DesignGateEpisodeBundle>;
}

export interface DesignGateThresholdTransition {
  eventId: string;
  sourceMapId: string;
  sourceMapRef: string;
  previousEligibleEpisodes: number;
  currentEligibleEpisodes: number;
  sourceValid: boolean;
}

export interface DesignGateThresholdTransitionProvider {
  resolveLatestTransition(): Promise<DesignGateThresholdTransition>;
}

export function validateDesignGateEpisodeSelector(input: unknown): string | null {
  const parsed = designGateEpisodeSelectorSchema.safeParse(input);
  return parsed.success
    ? null
    : parsed.error.issues.map((issue) => `${issue.path.join('.') || 'selector'}: ${issue.message}`).join('; ');
}

export class DesignGateEpisodeSourceProviderImpl implements DesignGateEpisodeSourceProvider {
  constructor(
    private readonly deps: {
      repoRoot: string;
      pullRequestReader: DesignGatePullRequestReader;
      reviewMessageReader: DesignGateReviewMessageReader;
      gitTruth: DesignGateGitTruth;
    },
  ) {}

  async resolve(selectorInput: DesignGateEpisodeSourceSelector): Promise<DesignGateEpisodeBundle> {
    const selector = designGateEpisodeSelectorSchema.parse(selectorInput);
    const sourceMapRef = `${SOURCE_MAP_ROOT}/${selector.sourceMapId}.yaml`;
    const sourceMap = this.resolveCurrentSourceMap(selector.sourceMapId);

    const episodes = await Promise.all(
      sourceMap.episodes.map((episode) =>
        resolveDesignGateEpisode(episode, {
          ...this.deps,
          readRepoRef: (ref) => this.readRepoRef(ref),
        }),
      ),
    );
    const eligibleEpisodes = episodes.filter((episode) => episode.eligibility.eligible).length;
    const validEpisodes = episodes.filter((episode) => episode.validation.status === 'valid');
    const elapsedMs = sourceMap.window.endMs - sourceMap.window.startMs;
    const mature = elapsedMs >= FOUR_WEEKS_MS || eligibleEpisodes >= 20;
    const validity = this.resolveValidity(sourceMap.validityResultRef, episodes);
    return {
      selector,
      sourceMapRef,
      window: sourceMap.window,
      episodes,
      vector: {
        eligibleEpisodes,
        preReviewUniqueCatches: null,
        postMergeDivergenceEscapes: validEpisodes.filter((episode) => episode.consequence?.kind === 'escape_observed')
          .length,
        falsePositiveBlocks: null,
        extraActiveMinutes: null,
        extraReviewRounds: null,
      },
      validity,
      observation: {
        status: mature ? 'window_mature' : 'observing',
        mature,
        elapsedMs,
        eligibleEpisodeCount: eligibleEpisodes,
        maturityRule: 'four_weeks_or_twenty_episodes',
      },
    };
  }

  async resolveLatestTransition(): Promise<DesignGateThresholdTransition> {
    const catalog = this.readSourceMapCatalog();
    if (catalog.length === 0) throw new Error('design-gate source map unavailable: latest');
    const latestEndMs = Math.max(...catalog.map((sourceMap) => sourceMap.window.endMs));
    const latestCandidates = catalog.filter((sourceMap) => sourceMap.window.endMs === latestEndMs);
    if (latestCandidates.length !== 1) {
      throw new Error('design-gate source map catalog has an ambiguous latest window');
    }
    const latest = latestCandidates[0];
    if (!latest) throw new Error('design-gate source map unavailable: latest');

    const bundle = await this.resolve({
      kind: 'design-gate-episode-source-map',
      sourceMapId: latest.sourceMapId,
    });
    const priorMaps = catalog.filter((sourceMap) => sourceMap.window.endMs < latestEndMs);
    const previousEndMs =
      priorMaps.length > 0 ? Math.max(...priorMaps.map((sourceMap) => sourceMap.window.endMs)) : null;
    const previousCandidates =
      previousEndMs === null ? [] : priorMaps.filter((sourceMap) => sourceMap.window.endMs === previousEndMs);
    if (previousCandidates.length > 1) {
      throw new Error('design-gate source map catalog has an ambiguous previous window');
    }
    const previousEpisodeIds = new Set(previousCandidates[0]?.episodes.map((episode) => episode.episodeId) ?? []);
    const previousEligibleEpisodes = bundle.episodes.filter(
      (episode) => previousEpisodeIds.has(episode.episodeId) && episode.eligibility.eligible,
    ).length;

    return {
      eventId: `design-gate-source-map:${latest.sourceMapId}`,
      sourceMapId: latest.sourceMapId,
      sourceMapRef: bundle.sourceMapRef,
      previousEligibleEpisodes,
      currentEligibleEpisodes: bundle.vector.eligibleEpisodes,
      sourceValid:
        bundle.validity.status !== 'invalid' &&
        bundle.episodes.every((episode) => episode.validation.status === 'valid'),
    };
  }

  private resolveCurrentSourceMap(sourceMapId: string) {
    const catalog = this.readSourceMapCatalog();
    const selected = catalog.find((sourceMap) => sourceMap.sourceMapId === sourceMapId);
    if (!selected) throw new Error(`design-gate source map unavailable: ${sourceMapId}`);

    const latestEndMs = Math.max(...catalog.map((sourceMap) => sourceMap.window.endMs));
    const latest = catalog.filter((sourceMap) => sourceMap.window.endMs === latestEndMs);
    if (latest.length !== 1) throw new Error('design-gate source map catalog has an ambiguous latest window');
    if (latest[0]?.sourceMapId !== sourceMapId) {
      throw new Error(`stale design-gate source map: ${sourceMapId}; current=${latest[0]?.sourceMapId}`);
    }

    const selectedEpisodeIds = new Set(selected.episodes.map((episode) => episode.episodeId));
    const omittedEpisodeIds = catalog
      .flatMap((sourceMap) => sourceMap.episodes)
      .map((episode) => episode.episodeId)
      .filter((episodeId) => !selectedEpisodeIds.has(episodeId));
    if (omittedEpisodeIds.length > 0) {
      throw new Error(`latest design-gate source map is not cumulative: ${[...new Set(omittedEpisodeIds)].join(', ')}`);
    }
    return selected;
  }

  private readSourceMapCatalog(): DesignGateEpisodeSourceMap[] {
    const sourceMapDir = resolve(this.deps.repoRoot, SOURCE_MAP_ROOT);
    return readdirSync(sourceMapDir)
      .filter((filename) => filename.endsWith('.yaml'))
      .sort()
      .map((filename) => {
        const sourceMap = designGateEpisodeSourceMapSchema.parse(
          parseYaml(this.readRepoPath(`${SOURCE_MAP_ROOT}/${filename}`)),
        );
        const filenameId = filename.slice(0, -'.yaml'.length);
        if (sourceMap.sourceMapId !== filenameId) {
          throw new Error(`source map id does not match filename: ${filename}`);
        }
        return sourceMap;
      });
  }

  private resolveValidity(
    resultRef: string | undefined,
    episodes: ResolvedDesignGateEpisode[],
  ): DesignGateEpisodeBundle['validity'] {
    const invalidReasons = episodes.flatMap((episode) => episode.validation.reasons);
    if (invalidReasons.length > 0) return { status: 'invalid', resultRef: resultRef ?? null, reasons: invalidReasons };
    if (!resultRef) {
      return {
        status: 'insufficient',
        resultRef: null,
        reasons: ['measurement validity result is not yet linked'],
      };
    }
    try {
      const result = parseYaml(this.readRepoRef(resultRef).content) as {
        kind?: string;
        domainId?: string;
        decision?: { status?: string; reasons?: string[] };
      };
      if (result.kind !== 'f267-measurement-bundle-result' || result.domainId !== 'eval:design-gate') {
        throw new Error('validity result does not belong to eval:design-gate');
      }
      if (result.decision?.status === 'usable') return { status: 'usable', resultRef, reasons: [] };
      return {
        status: 'insufficient',
        resultRef,
        reasons: result.decision?.reasons ?? ['measurement result is not usable'],
      };
    } catch (error) {
      return { status: 'invalid', resultRef, reasons: [sourceFailure('measurement validity result', error)] };
    }
  }

  private readRepoRef(ref: string): { path: string; anchor: string | undefined; content: string } {
    const match = REPO_REF.exec(ref);
    if (!match?.[1]) throw new Error(`invalid repo source ref: ${ref}`);
    return { path: match[1], anchor: match[2], content: this.readRepoPath(match[1]) };
  }

  private readRepoPath(repoPath: string): string {
    if (isAbsolute(repoPath) || repoPath.includes('..') || repoPath.includes('\\') || repoPath.includes('\0')) {
      throw new Error(`unsafe repo path: ${repoPath}`);
    }
    const path = resolve(this.deps.repoRoot, repoPath);
    const repoRelative = relative(this.deps.repoRoot, path);
    if (repoRelative.startsWith('..') || isAbsolute(repoRelative) || !existsSync(path)) {
      throw new Error(`repo source unavailable: ${repoPath}`);
    }
    return readFileSync(path, 'utf8');
  }
}

function sourceFailure(label: string, error: unknown): string {
  return `${label} source invalid: ${error instanceof Error ? error.message : String(error)}`;
}
