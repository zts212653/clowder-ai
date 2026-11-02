'use client';

import { useRouter } from 'next/navigation';
import { type CSSProperties, useState } from 'react';
import type { CatData } from '@/hooks/useCatData';
import type { ConversationViewPreferenceController } from '@/hooks/useConversationViewPreference';
import { formatModelName } from '@/lib/model-display-name';
import { AvatarImageWithFallback } from '../AvatarImageWithFallback';
import { Lightbox } from '../Lightbox';
import { MemberCopyProvider } from '../members/editor-presentation';
import { useShellCopy } from '../shell/shell-copy';
import { CatProfileCardOverlay } from './CatProfileCardOverlay';
import { CatProfileStatus } from './CatProfileStatus';
import styles from './cat-profile-card.module.css';
import { catProfileCardCopy } from './cat-profile-card.shell-copy';

export function CatProfileCard({
  cat,
  threadId,
  anchor,
  onClose,
  onMention,
  conversationView,
}: {
  cat: CatData;
  threadId: string;
  anchor: HTMLElement;
  onClose(): void;
  onMention?: () => void;
  conversationView?: ConversationViewPreferenceController;
}) {
  const router = useRouter();
  const copy = useShellCopy(catProfileCardCopy);
  const [imageOpen, setImageOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const name = cat.nickname || cat.displayName;
  const handle = cat.mentionPatterns.find((pattern) => pattern.replace(/^@/, '') === cat.id) ?? cat.mentionPatterns[0];
  const identity = [cat.breedDisplayName || cat.displayName, handle && `@${handle.replace(/^@/, '')}`]
    .filter(Boolean)
    .join(' · ');
  const avatar = cat.avatar || '/avatars/default.png';
  const viewCat = async () => {
    if (!conversationView) return;
    setSaving(true);
    setError(false);
    try {
      if (await conversationView.save({ mode: 'cat', catId: cat.id })) onClose();
      else setError(true);
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <CatProfileCardOverlay anchor={anchor} label={copy.title(name)} suspended={imageOpen} onClose={onClose}>
        <header
          className={styles.header}
          data-has-banner={!!cat.banner || undefined}
          style={{ '--cat-card-surface': cat.color.secondary } as CSSProperties}
        >
          {cat.banner && (
            <div className={styles.banner}>
              <AvatarImageWithFallback src={cat.banner} alt="" className="h-full w-full object-cover" />
            </div>
          )}
          <button
            type="button"
            className={styles.avatar}
            aria-label={copy.original(name)}
            onClick={() => setImageOpen(true)}
          >
            <AvatarImageWithFallback src={avatar} alt={name} className="h-full w-full object-cover" />
          </button>
          <div className={styles.identity}>
            <h2>{name}</h2>
            <p title={identity}>{identity}</p>
          </div>
        </header>
        <div className={styles.body}>
          <MemberCopyProvider>
            <CatProfileStatus cat={cat} threadId={threadId} onClose={onClose} />
          </MemberCopyProvider>
          <p className={styles.model}>
            {copy.model} <span>{formatModelName(cat.variantLabel?.trim() || cat.defaultModel)}</span>
          </p>
          {cat.personality && <p className={styles.personality}>「{cat.personality}」</p>}
          {error && (
            <p role="alert" className={styles.error}>
              {copy.switchFailed}
            </p>
          )}
        </div>
        <footer className={styles.actions}>
          <button type="button" disabled={!onMention} onClick={onMention}>
            {copy.mention}
          </button>
          <button
            type="button"
            disabled={!conversationView || conversationView.loading || saving}
            onClick={() => void viewCat()}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              aria-hidden="true"
            >
              <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" />
              <circle cx="8" cy="8" r="2" />
            </svg>
            {saving ? copy.switching : copy.onlyCat}
          </button>
          <button
            type="button"
            className={styles.settings}
            onClick={() => {
              onClose();
              router.push(`/settings?s=members&shell=v2&cat=${encodeURIComponent(cat.id)}`);
            }}
          >
            {copy.settings}
          </button>
        </footer>
      </CatProfileCardOverlay>
      {imageOpen && <Lightbox url={avatar} alt={copy.originalAlt(name)} onClose={() => setImageOpen(false)} />}
    </>
  );
}
