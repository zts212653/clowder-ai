'use client';
import { useEffect, useRef, useState } from 'react';
import { recallReplyTimeLabel } from '@/hooks/recall-display';
import { type RecallGroup, recallCounts } from '@/hooks/recall-feed-model';
import { useCatData } from '@/hooks/useCatData';
import { resolveCatDisplayName } from '@/lib/cat-display-name';
import { CatAvatar } from '../CatAvatar';
import { RecallCard } from './RecallRow';

function recallGroupName(group: RecallGroup, getCatById: ReturnType<typeof useCatData>['getCatById']): string {
  if (!group.catId) return '未记录是哪只猫';
  const cat = getCatById(group.catId);
  if (!cat) return '猫的名字暂时读不到';
  return cat.nickname || resolveCatDisplayName(group.catId, getCatById);
}

function useRecallGroupDisclosure(initiallyExpanded: boolean, targeted: boolean) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const sectionRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  useEffect(() => setExpanded(initiallyExpanded), [initiallyExpanded]);
  useEffect(() => {
    if (!targeted) return;
    sectionRef.current?.scrollIntoView?.({ block: 'nearest' });
    toggleRef.current?.focus({ preventScroll: true });
  }, [targeted]);
  return { expanded, setExpanded, sectionRef, toggleRef };
}

export function RecallReplyGroup({
  group,
  initiallyExpanded,
  onLocate,
  locating,
  earlierRepliesPending = false,
  allowDeliveryExpansion = true,
  replyTimeLabel,
  targeted = false,
}: {
  group: RecallGroup;
  initiallyExpanded: boolean;
  locating?: boolean;
  earlierRepliesPending?: boolean;
  allowDeliveryExpansion?: boolean;
  replyTimeLabel?: string;
  targeted?: boolean;
  onLocate: (group: RecallGroup) => void;
}) {
  const { expanded, setExpanded, sectionRef, toggleRef } = useRecallGroupDisclosure(initiallyExpanded, targeted);
  const { getCatById } = useCatData();
  const cat = group.catId ? getCatById(group.catId) : undefined;
  const name = recallGroupName(group, getCatById);
  const time = replyTimeLabel ?? recallReplyTimeLabel(group, earlierRepliesPending);
  return (
    <section
      ref={sectionRef}
      data-recall-group={group.id}
      data-recall-target={targeted || undefined}
      className={`min-w-0 border-b border-cafe-border-subtle ${expanded ? 'rounded-lg border bg-cafe-surface-elevated p-3' : 'py-3'}`}
    >
      <div className="flex items-start gap-2">
        <button
          ref={toggleRef}
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <svg
            aria-hidden="true"
            className={`h-3 w-3 shrink-0 text-cafe-secondary ${expanded ? 'rotate-90' : ''}`}
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
          >
            <path d="m4 2 4 4-4 4" />
          </svg>
          {group.catId && cat && <CatAvatar catId={group.catId} size={24} ring="none" />}
          <span className="min-w-0 flex-1 text-compact">
            <span className="mr-2 font-medium text-cafe-black">{name}</span>
            <span className="text-xs text-cafe-secondary">{time}</span>
            <span className="mt-1 block text-xs text-cafe-secondary">{recallCounts(group.events)}</span>
          </span>
        </button>
        <button
          type="button"
          disabled={locating || (!group.messageId && (!group.invocationId || !group.catId))}
          title={group.catId ? '定位这条回复' : '未记录猫和回复的对应关系'}
          onClick={() => onLocate(group)}
          className="shrink-0 py-1 text-xs text-cafe-accent hover:underline disabled:text-cafe-secondary disabled:no-underline"
        >
          {locating ? '定位中…' : '定位回复'}
        </button>
      </div>
      {expanded && (
        <div className="mt-2 space-y-1">
          {group.events.map((event) => (
            <RecallCard key={event.id} event={event} allowDeliveryExpansion={allowDeliveryExpansion} />
          ))}
        </div>
      )}
    </section>
  );
}
