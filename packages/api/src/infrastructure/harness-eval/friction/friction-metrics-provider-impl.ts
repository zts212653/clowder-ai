import type { FrictionRollupInput, FrictionRollupSourceSelector } from '@cat-cafe/shared';
import type { IFrustrationIssueStore } from '../../../domains/cats/services/stores/ports/FrustrationIssueStore.js';
import type { IMessageStore } from '../../../domains/cats/services/stores/ports/MessageStore.js';
import type { IEmbeddingService } from '../../../domains/memory/interfaces.js';
import type { FrictionMetricsProvider } from '../publish-verdict/friction-generator-adapter.js';
import type { TaskOutcomeEpisodeStore } from '../task-outcome/task-outcome-store.js';
import { CancelAdapter } from './cancel-adapter.js';
import { EvalDomainAdapter } from './eval-domain-adapter.js';
import { FrictionAggregator } from './friction-aggregator.js';
import { FrictionClusterer } from './friction-clusterer.js';
import { buildFrictionRollupInput } from './friction-rollup-input.js';
import { PawFeelAdapter } from './paw-feel-adapter.js';
import { UserFeedbackAdapter } from './user-feedback-adapter.js';

/**
 * friction 自己 domain 的 featureId（= eval-friction.yaml handoffTarget = 'F245'）。
 * R1 self-exclusion（@gpt52）：friction 的 eval-domain channel 不吃自己产出的 bundle，
 * 否则 enabled:true 后 friction bundle 的 frictionCounts 被下一轮当新 signal 吃回 → 跨 run 自放大。
 * 必须与 eval-friction-live-verdict 写入 snapshot 的 featureId 一致（submitted-packet-guard 保证 = domain.featureId）。
 */
const FRICTION_SELF_EXCLUDE_FEATURE_IDS: ReadonlySet<string> = new Set(['F245']);

/**
 * F245 Phase C PR1b — production FrictionMetricsProvider.
 *
 * Composes the 4 Phase A/B channel adapters (paw-feel / cancel / user-feedback /
 * eval-domain) over the live read-side stores, runs aggregate → cluster →
 * FrictionRollupInput for the selector window. All 4 adapters are READ-ONLY
 * (KD-4): no writeback anywhere in this path.
 *
 * deps use `Pick<>` so tests can inject narrow stubs. embeddingService is optional
 * — when absent (or not ready) the clusterer fails open to rule-only clustering
 * and marks the rollup degraded (mirrors the memory domain lexical degrade range).
 */
export interface FrictionMetricsProviderDeps {
  messageStore: Pick<IMessageStore, 'getBefore'>;
  taskOutcomeStore: Pick<TaskOutcomeEpisodeStore, 'listSignalsInWindow'>;
  frustrationIssueStore: Pick<IFrustrationIssueStore, 'listConfirmedInWindow'>;
  /** LIVE docs/harness-feedback root — EvalDomainAdapter scans bundles snapshot.json files. */
  harnessFeedbackRoot: string;
  embeddingService?: IEmbeddingService;
}

export class FrictionMetricsProviderImpl implements FrictionMetricsProvider {
  constructor(private readonly deps: FrictionMetricsProviderDeps) {}

  async resolve(selector: FrictionRollupSourceSelector): Promise<FrictionRollupInput> {
    const sources = [
      new PawFeelAdapter(this.deps.messageStore),
      new CancelAdapter(this.deps.taskOutcomeStore),
      new UserFeedbackAdapter(this.deps.frustrationIssueStore),
      new EvalDomainAdapter(this.deps.harnessFeedbackRoot, {
        excludeFeatureIds: FRICTION_SELF_EXCLUDE_FEATURE_IDS,
      }),
    ];
    const aggregator = new FrictionAggregator(sources);
    // undefined embedding → clusterer fail-opens to rule-only + degraded=true.
    const clusterer = new FrictionClusterer(this.deps.embeddingService);
    return buildFrictionRollupInput(aggregator, clusterer, selector.windowStartMs, selector.windowEndMs);
  }
}
