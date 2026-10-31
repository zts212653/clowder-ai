'use client';
import type { ComponentProps } from 'react';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useCatData } from '@/hooks/useCatData';
import { resolveCatNameplateName } from '@/lib/cat-display-name';
import { WorkGalleryCard } from './WorkGalleryCard';
import { worksPanelCopy } from './works-panel.shell-copy';

/** Chat changes the footer, never the cover or the work identity. */
export function ChatWorkCard({
  artifact,
  onOpen,
  ...props
}: ComponentProps<typeof WorkGalleryCard> & { onOpen: () => void }) {
  const t = useShellCopy(worksPanelCopy);
  const { getCatById } = useCatData();
  const who = artifact.catId ? resolveCatNameplateName(artifact.catId, getCatById) : '—';
  const version = artifact.work ? t.version(artifact.work.ownerRevision) : '';
  return (
    <WorkGalleryCard
      {...props}
      artifact={artifact}
      footer={
        <>
          <small>{[who, version].filter(Boolean).join(' · ')}</small>
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
