'use client';
import type { ComponentProps } from 'react';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useCatData } from '@/hooks/useCatData';
import { resolveCatNameplateName } from '@/lib/cat-display-name';
import { WorkGalleryCard } from './WorkGalleryCard';
import { useWorkCardMessage, workCardTime } from './work-card-message-context';
import { worksPanelCopy } from './works-panel.shell-copy';

/** Chat changes the footer, never the cover or the work identity. */
export function ChatWorkCard({
  artifact,
  onOpen,
  ...props
}: ComponentProps<typeof WorkGalleryCard> & { onOpen: () => void }) {
  const t = useShellCopy(worksPanelCopy);
  const { getCatById } = useCatData();
  const message = useWorkCardMessage();
  const name = artifact.catId ? resolveCatNameplateName(artifact.catId, getCatById) : '—';
  const who = message.byline === 'watcher' ? `${t.watcher} · ${name}` : name;
  const version = artifact.work ? t.version(artifact.work.ownerRevision) : '';
  const time = message.at ? workCardTime(message.at) : '';
  return (
    <WorkGalleryCard
      {...props}
      artifact={artifact}
      footer={
        <>
          <small>{[who, version, time].filter(Boolean).join(' · ')}</small>
          <button
            type="button"
            disabled={props.busy || props.disabled}
            onClick={onOpen}
            className="recent-work-chat shell-focusable"
            data-testid="chat-work-open"
          >
            {t.open}
          </button>
        </>
      }
    />
  );
}
