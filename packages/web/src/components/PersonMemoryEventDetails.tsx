'use client';
import type {
  PersonMemoryInformedEvidence,
  PersonMemoryInteractionApprovalDetail,
  TemporalValue,
} from '@cat-cafe/shared';
import { useCoCreatorDisplay } from '@/hooks/useCoCreatorConfig';
import { jumpToApprovalAnchor } from './ApprovalProvenanceLinks';
import { type PersonMemoryDraftView, sourceLabel } from './PersonMemoryDraftDetails';
import { personMemoryEvidenceCopy } from './person-memory-evidence.shell-copy';
import { useShellCopy } from './shell/shell-copy';
import { useShellLanguage } from './shell/shell-language';

export function EventDraftDetails({
  displayName,
  event,
  informedEvidence,
  sourceRole,
}: {
  displayName: string;
  event: PersonMemoryInteractionApprovalDetail;
  informedEvidence: PersonMemoryInformedEvidence[];
  sourceRole: PersonMemoryDraftView['sourceRole'];
}) {
  const t = useShellCopy(personMemoryEvidenceCopy),
    language = useShellLanguage();
  const ownerName = useCoCreatorDisplay().name;
  const temporal = (value: TemporalValue | undefined): string => {
    if (!value) return t.unknown;
    if (value.kind === 'exact') return value.value;
    if (value.kind === 'approximate') return value.raw;
    return `${value.raw}（${value.alternatives.map((a) => `${a.label === 'explicit_date' ? t.explicit : a.label === 'weekday_resolution' ? t.weekday : t.alternative}=${a.value}`).join(' / ')}）`;
  };
  const sources = informedEvidence.length
    ? informedEvidence.map((s, index) => ({
        key: s.sourceId,
        testId: `person-memory-informed-source-${index}`,
        fields: s.targetFields,
        excerpt: s.boundedExcerpt,
        ref: s.drillSourceRef,
        label: [
          t.sources[s.sourceKind],
          ...s.assertionRoles.map((r) => t.roles[r]),
          ...(s.confirmationScope ? [t.confirmed] : []),
        ].join(' · '),
      }))
    : event.sourceEvidence.map((s, index) => ({
        key: s.sourceRef.messageId,
        testId: `person-memory-event-source-${index}`,
        fields: s.supports,
        excerpt: s.evidenceExcerpt,
        ref: s.sourceRef,
        label: '',
      }));
  return (
    <span className="block space-y-2 rounded-md bg-[var(--cafe-muted)] p-2 text-xs">
      <span className="block text-micro font-medium opacity-65">
        {t.event} · {sourceLabel(sourceRole, language, ownerName)}
      </span>
      <span className="block font-medium">{t.person(displayName)}</span>
      <span className="block text-sm font-medium">{t.headline(event.headline)}</span>
      <span className="block">{t.time(temporal(event.occurredAt))}</span>
      <span className="block">{t.duration(temporal(event.duration))}</span>
      <span className="block">{t.topic(event.importanceOrTopic)}</span>
      <span className="block">
        {t.uncertain(event.uncertaintyNotes.length ? event.uncertaintyNotes.join('；') : t.none)}
      </span>
      <span className="block space-y-1 border-t border-[var(--cafe-border)] pt-2">
        {sources.map((s, index) => (
          <span key={s.key} className="block rounded border border-[var(--cafe-border)] p-1.5">
            <span className="block opacity-65">
              {t.evidence(index + 1, s.fields.map((f) => t.fields[f]).join('、'))}
            </span>
            {s.label ? <span className="block opacity-65">{s.label}</span> : null}
            <span className="block">“{s.excerpt}”</span>
            {s.ref ? (
              <button
                type="button"
                data-testid={s.testId}
                className="shell-focusable mt-1 rounded border border-[var(--cafe-border)] px-2 py-0.5 font-medium"
                onClick={(click) => {
                  click.preventDefault();
                  click.stopPropagation();
                  if (s.ref) jumpToApprovalAnchor(s.ref.threadId, s.ref.messageId);
                }}
              >
                {t.source}
              </button>
            ) : null}
          </span>
        ))}
      </span>
    </span>
  );
}
