import type { ApprovalItem } from '@cat-cafe/shared';
import { CriticalText } from './content-overflow';

export function GenericApprovalRecommendation({
  item,
  f221TasteEvidence,
  f225HandoffDetails,
  f193TargetThreadId,
  sourceThreadTitle,
  targetThreadTitle,
  resolveCatName,
}: {
  item: ApprovalItem;
  f221TasteEvidence?: string;
  f225HandoffDetails?: string;
  f193TargetThreadId: string;
  sourceThreadTitle: string;
  targetThreadTitle: string | null;
  resolveCatName: (catId: string) => string;
}) {
  return (
    <div className="space-y-2 text-micro">
      {item.sourceFeatureId === 'F128' && item.detail.reason != null && (
        <CriticalText summary="审批理由" details={String(item.detail.reason)} tone="warning" />
      )}
      {item.sourceFeatureId === 'F225' && f225HandoffDetails && (
        <CriticalText summary="交接记录" details={f225HandoffDetails} tone="info" />
      )}
      {item.sourceFeatureId === 'F221' && <TasteRecommendation item={item} evidence={f221TasteEvidence} />}
      {item.sourceFeatureId === 'F193' && (
        <DispatchRecommendation
          item={item}
          sourceThreadTitle={sourceThreadTitle}
          targetThreadTitle={targetThreadTitle}
          targetThreadId={f193TargetThreadId}
          resolveCatName={resolveCatName}
        />
      )}
      {item.sourceFeatureId === 'F260' && <EntityRecommendation item={item} />}
    </div>
  );
}

function TasteRecommendation({ item, evidence }: { item: ApprovalItem; evidence?: string }) {
  return (
    <div className="space-y-1">
      {evidence && <CriticalText summary="品味提案依据" details={evidence} tone="info" />}
      <div className="flex flex-wrap items-center gap-1.5">
        {item.detail.dimension != null && <DetailChip>{String(item.detail.dimension)}</DetailChip>}
        {item.detail.privacy === 'sensitive' && (
          <span className="rounded-md bg-[var(--semantic-warning)] px-1.5 py-0.5 font-medium text-[var(--cafe-accent-foreground)]">
            sensitive
          </span>
        )}
        {Array.isArray(item.detail.tags) &&
          item.detail.tags.map((tag) => <DetailChip key={String(tag)}>{String(tag)}</DetailChip>)}
      </div>
    </div>
  );
}

function DispatchRecommendation({
  item,
  sourceThreadTitle,
  targetThreadTitle,
  targetThreadId,
  resolveCatName,
}: {
  item: ApprovalItem;
  sourceThreadTitle: string;
  targetThreadTitle: string | null;
  targetThreadId: string;
  resolveCatName: (catId: string) => string;
}) {
  const targetCats = Array.isArray(item.detail.targetCats)
    ? item.detail.targetCats
        .map((catId) => (typeof catId === 'string' ? resolveCatName(catId) : String(catId)))
        .join(', ')
    : String(item.detail.targetCats);

  return (
    <div className="space-y-1">
      <div className="flex min-w-0 items-center gap-1">
        <span className="shrink-0 opacity-60">从：</span>
        <span className="flex-1 truncate">{sourceThreadTitle}</span>
        <span className="shrink-0 opacity-60">→</span>
        <span className="flex-1 truncate">{targetThreadTitle ?? targetThreadId}</span>
      </div>
      {item.detail.content != null && (
        <CriticalText summary="派发内容" details={String(item.detail.content)} tone="info" />
      )}
      {item.detail.targetCats != null && <p>交给： {targetCats}</p>}
    </div>
  );
}

function EntityRecommendation({ item }: { item: ApprovalItem }) {
  return (
    <div className="space-y-1">
      <p data-testid="entity-proposal-identity">
        提案 {item.proposalId} · 目标实体 {String(item.detail.entityId ?? '未指定')}
      </p>
      {item.detail.canonicalName != null && (
        <p className="font-medium">
          {String(item.detail.canonicalName)} ({String(item.detail.entityType ?? 'entity')})
        </p>
      )}
      {Array.isArray(item.detail.aliases) && item.detail.aliases.length > 0 && (
        <p className="truncate">别名: {item.detail.aliases.join(', ')}</p>
      )}
      {item.detail.rationale != null && (
        <CriticalText summary="登记理由" details={String(item.detail.rationale)} tone="info" />
      )}
    </div>
  );
}

function DetailChip({ children }: { children: string }) {
  return <span className="rounded bg-cafe-muted px-1 py-0.5 text-micro">{children}</span>;
}
