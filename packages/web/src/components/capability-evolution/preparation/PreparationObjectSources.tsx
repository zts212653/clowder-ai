import { type OwnerTruthRefV1, refIdentity } from '@cat-cafe/shared';
import { jumpToApprovalAnchor } from '@/components/ApprovalProvenanceLinks';
import { EvolutionSource } from '../EvolutionVersionEvidence';
import type { EvolutionPreparationSubmissionProjection } from './evolution-preparation-resource';

export function preparationObjectSourceLabel(source: OwnerTruthRefV1): string {
  const git = /^git:([^:]+):(.+)$/u.exec(source.ownerStateRef);
  if (git) return `${git[2]?.split('/').at(-1)} · ${git[1]?.slice(0, 8)}`;
  if (source.ownerFeatureId === 'F117' && source.ownerStateRef.startsWith('message:')) return '对话原文';
  return source.ownerStateRef;
}

export function PreparationObjectSources({
  itemId,
  sources,
  submission,
}: {
  itemId: string;
  sources: OwnerTruthRefV1[];
  submission?: EvolutionPreparationSubmissionProjection;
}) {
  const evidence = submission?.evidenceSources?.find((source) => source.sourceKey === itemId);
  return (
    <section className="evolution-preparation-object-sources" aria-label="对象来源">
      {sources.map((source, index) => {
        const read = evidence?.refs.find((value) => refIdentity(value.ref) === refIdentity(source));
        const anchor =
          read?.status === 'available' && read.threadId && read.messageId
            ? { threadId: read.threadId, messageId: read.messageId }
            : undefined;
        return (
          <div key={`${refIdentity(source)}:${index}`}>
            <p className="evolution-preparation-state-value">{preparationObjectSourceLabel(source)}</p>
            <span className="evolution-preparation-state-note">
              {anchor ? '对话原文可读' : read?.status === 'unavailable' ? '原件当前不可读' : '引用已提交 · 原件未核读'}
            </span>
            {anchor && (
              <button
                type="button"
                className="evolution-link ml-3"
                onClick={() => jumpToApprovalAnchor(anchor.threadId, anchor.messageId)}
              >
                回读来源原文
              </button>
            )}
            <EvolutionSource label="来源与版本" source={source} />
          </div>
        );
      })}
    </section>
  );
}
