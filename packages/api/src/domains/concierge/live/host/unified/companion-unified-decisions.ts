import { createHmac, randomBytes } from 'node:crypto';
import type { UnifiedAttentionItemV1, UnifiedAttentionReadV1 } from '@cat-cafe/shared';
import {
  type CompanionDecisionNavigationTarget,
  type CompanionUnifiedDecisions as PublicUnifiedDecisions,
  validateCompanionReply,
} from '@clowder-ai/plugin-contract-beta24';
import { CompanionBridgeError, type CompanionOwnerClient } from '../../companion-owner-client.js';
import { clipLiveText } from '../../live-text-budget.js';
import { parseUnifiedCompanionSource } from './companion-unified-source.js';

export interface CompanionDecisionDestination {
  threadId: string;
  messageId: string;
  blockId?: string;
}
interface Options {
  ownerUserId: string;
  client: CompanionOwnerClient;
  assertCurrent(): Promise<void>;
  canOpenDecision?: (destination: CompanionDecisionDestination) => Promise<boolean>;
  openDecision?: (destination: CompanionDecisionDestination) => Promise<boolean>;
}
const NAVIGATION_TARGETS = ['origin', 'approval_card', 'action'] as const;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

function destinations(item: UnifiedAttentionItemV1) {
  const targets: Partial<Record<CompanionDecisionNavigationTarget, CompanionDecisionDestination>> = {};
  const nav = item.approval?.navigation;
  if (nav?.state === 'anchored') {
    targets.approval_card = { ...nav.approvalCardRef };
    if (nav.originRef.kind === 'message')
      targets.origin = { threadId: nav.originRef.threadId, messageId: nav.originRef.messageId };
  }
  const actions = item.linkedNeedsMe
    .map(({ receipt }) => receipt.action?.actionRef)
    .filter((value) => value !== undefined);
  if (actions.length === 1) {
    const match = /^message:([^:#]+):([^:#]+)(?:#([A-Za-z0-9_-]{1,200}))?$/.exec(actions[0]!);
    if (match?.[1] && match[2])
      targets.action = { threadId: match[1], messageId: match[2], ...(match[3] ? { blockId: match[3] } : {}) };
  }
  return targets;
}

/** The map holds only issued-reference page coordinates; every effect re-reads canonical owner truth. */
export class CompanionUnifiedDecisions {
  private readonly key = randomBytes(32);
  private readonly issued = new Map<string, { offset: number; limit: number }>();
  constructor(private readonly options: Options) {}
  reset(): void {
    this.issued.clear();
  }
  private ref(item: UnifiedAttentionItemV1): string {
    const linked = item.linkedNeedsMe
      .map(({ ownerRead, receipt }) => ({
        ownerSubject: ownerRead.envelope.subjectRef,
        ownerRevision: ownerRead.envelope.revision,
        receipt,
      }))
      .sort((a, b) => canonical(a).localeCompare(canonical(b)));
    return createHmac('sha256', this.key)
      .update(
        canonical({
          owner: this.options.ownerUserId,
          decisionRef: item.decisionRef,
          kind: item.kind,
          summary: item.summary,
          approval: item.approval,
          linked,
        }),
      )
      .digest('hex');
  }
  private async source(page: { offset: number; limit: number }) {
    const response = await this.options.client.requestResponse(
      `/api/concierge/work/decisions?view=unified&offset=${page.offset}&limit=${page.limit}`,
    );
    if (response.statusCode === 401 || response.statusCode === 403)
      throw new CompanionBridgeError('permission_required');
    if (response.statusCode !== 200 && response.statusCode !== 503) throw new CompanionBridgeError('unavailable');
    const source = parseUnifiedCompanionSource(response.body, this.options.ownerUserId, page);
    // Opening and reading share the exact public semantic gate before any navigation effect.
    this.publicRead(
      source,
      source.items.map((item) => this.publicItem(item, [])),
    );
    return source;
  }
  private async navigation(item: UnifiedAttentionItemV1) {
    const result: Partial<Record<CompanionDecisionNavigationTarget, CompanionDecisionDestination>> = {};
    if (!this.options.canOpenDecision || !this.options.openDecision) return result;
    const candidates = destinations(item);
    for (const target of NAVIGATION_TARGETS) {
      const destination = candidates[target];
      if (destination && (await this.options.canOpenDecision(destination))) result[target] = destination;
    }
    return result;
  }
  private publicItem(
    item: UnifiedAttentionItemV1,
    targets: CompanionDecisionNavigationTarget[],
  ): PublicUnifiedDecisions['items'][number] {
    const common = { variantRef: this.ref(item), summary: clipLiveText(item.summary, 500), navigation: { targets } };
    if (item.kind === 'approval' && item.approval)
      return {
        ...common,
        kind: 'approval',
        approval: {
          resolution: item.approval.resolution,
          materializationState: item.approval.materialization.state,
          linkedNeedsMe: item.linkedNeedsMe.length > 0,
        },
      };
    if (item.kind !== 'approval') return { ...common, kind: item.kind };
    throw new CompanionBridgeError('unavailable');
  }
  private publicRead(source: UnifiedAttentionReadV1, items: PublicUnifiedDecisions['items']): PublicUnifiedDecisions {
    const complete =
      source.status === 'available' &&
      source.consistency.state === 'verified' &&
      Object.values(source.sources).every(
        (value) => value.status === 'available' && value.exhaustiveness === 'complete',
      );
    const result = {
      kind: 'decisions' as const,
      version: 1 as const,
      status: source.status,
      observedAt: source.observedAt,
      sources: {
        approvals: { status: source.sources.approvals.status, coverage: source.sources.approvals.exhaustiveness },
        needsMe: { status: source.sources.needsMe.status, coverage: source.sources.needsMe.exhaustiveness },
      },
      items,
      ...(complete && source.totalCount !== undefined ? { totalCount: source.totalCount } : {}),
      page: source.page,
    };
    if (!validateCompanionReply(result)) throw new CompanionBridgeError('unavailable');
    return result;
  }
  async read(offset: number, limit: number): Promise<PublicUnifiedDecisions> {
    const page = { offset, limit },
      source = await this.source(page);
    const items: PublicUnifiedDecisions['items'][number][] = [];
    for (const item of source.items) {
      const nav = await this.navigation(item);
      items.push(
        this.publicItem(
          item,
          NAVIGATION_TARGETS.filter((target) => nav[target] !== undefined),
        ),
      );
    }
    const result = this.publicRead(source, items);
    await this.options.assertCurrent();
    for (const item of items) this.issued.set(item.variantRef, page);
    while (this.issued.size > 1024) this.issued.delete(this.issued.keys().next().value!);
    return result;
  }
  async open(variantRef: string, target: CompanionDecisionNavigationTarget): Promise<boolean> {
    const page = this.issued.get(variantRef);
    if (!page || !this.options.openDecision) return false;
    const source = await this.source(page);
    const item = source.items.find((value) => this.ref(value) === variantRef);
    if (!item) return false;
    const destination = (await this.navigation(item))[target];
    if (!destination) return false;
    await this.options.assertCurrent();
    return this.options.openDecision(destination);
  }
}
