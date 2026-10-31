'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { type CatData, useCatData } from '@/hooks/useCatData';
import type { ComposerRoutingPreviewReason, RoutingPreviewState } from '@/hooks/useRoutingPreview';
import { AppTooltip } from './AppTooltip';
import { ComposerRecipientMenu, type ComposerRecipientOption } from './ComposerRecipientMenu';
import styles from './ComposerRoutingPreview.module.css';
import { buildCatOptions, type CatOption } from './chat-input-options';
import { composerRoutingCopy } from './composer-routing.shell-copy';
import {
  buildComposerRecipientIdentities,
  type ComposerRecipientIdentity,
  composerCatName,
} from './composer-routing-presentation';
import { ShellCatAvatar } from './shell/ShellCatAvatar';
import { ShellGlyph } from './shell/ShellIcons';
import { useShellCopy } from './shell/shell-copy';
import { useShellLanguage } from './shell/shell-language';
import { useCompactRoutingLayout } from './useCompactRoutingLayout';

type ComposerRoutingWords = typeof composerRoutingCopy.zh;
type CatLookup = ReturnType<typeof useCatData>['getCatById'];

interface RoutingPreviewPresentation {
  joinedNames: string;
  reason: string;
  stateLabel: string;
  whisperPreview: boolean;
  unavailableNotice?: string;
}

function buildRecipientOptions(
  cats: CatData[],
  identities: ReadonlyMap<string, ComposerRecipientIdentity>,
): ComposerRecipientOption[] {
  return buildCatOptions(cats)
    .filter((option) => !option.isGroup)
    .map((option) => ({ ...option, insert: identities.get(option.id)?.insert ?? null }));
}

function useWholeRecipientName(label: string, active: boolean) {
  const slot = useRef<HTMLSpanElement>(null);
  const content = useRef<HTMLSpanElement>(null);
  const [fits, setFits] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: A new localized label must be measured before paint.
  useLayoutEffect(() => {
    const slotElement = slot.current;
    const contentElement = content.current;
    if (!active || !slotElement || !contentElement) {
      setFits(false);
      return;
    }

    const measure = () => {
      const available = slotElement.getBoundingClientRect().width;
      const required = contentElement.getBoundingClientRect().width;
      setFits(required > 0 && required <= available + 1);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(slotElement);
    observer?.observe(contentElement);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [active, label]);

  return { slot, content, fits };
}

function explainReason(reason: ComposerRoutingPreviewReason, names: string, copy: ComposerRoutingWords): string {
  switch (reason.kind) {
    case 'current_message_mentions':
      return copy.currentMentions(names);
    case 'previous_user_mentions':
      return copy.previousMentions(names);
    case 'recent_replier':
      return copy.recentReplier(names);
    case 'preferred_cat':
      return copy.preferredReason(names);
    case 'default_cat':
      return copy.defaultReason(names);
    case 'preferred_parallel':
      return copy.preferredParallel(names);
    case 'concierge_preferred':
      return copy.conciergePreferred(names);
    case 'available_participant':
      return copy.availableParticipant(names);
    case 'thread_policy':
      return copy.threadPolicy(names);
    case 'whisper_recipients':
      return copy.whisperRecipients(names);
  }
}

function presentRoutingPreview(
  preview: RoutingPreviewState,
  copy: ComposerRoutingWords,
  language: 'zh' | 'en',
  getCatById: CatLookup,
  identities: ReadonlyMap<string, ComposerRecipientIdentity>,
): RoutingPreviewPresentation {
  const names =
    preview.status === 'ready'
      ? preview.targetCats.map(
          (catId) =>
            identities.get(catId)?.label ?? composerCatName(catId, getCatById, language === 'zh' ? '猫猫' : 'Cat'),
        )
      : [];
  const joinedNames = names.join(language === 'zh' ? '、' : ', ');
  const whisperPreview = preview.status === 'ready' && preview.reason.kind === 'whisper_recipients';
  if (joinedNames && preview.status === 'ready') {
    const unavailableNames = preview.unavailableTargets
      ?.map(
        (catId) =>
          identities.get(catId)?.label ?? composerCatName(catId, getCatById, language === 'zh' ? '猫猫' : 'Cat'),
      )
      .join(language === 'zh' ? '、' : ', ');
    const unavailableNotice =
      !whisperPreview && unavailableNames ? copy.unavailableRedirect(unavailableNames, joinedNames) : undefined;
    return {
      joinedNames,
      reason: unavailableNotice ?? explainReason(preview.reason, joinedNames, copy),
      stateLabel: joinedNames,
      whisperPreview,
      unavailableNotice,
    };
  }
  if (whisperPreview) {
    return {
      joinedNames,
      reason: copy.whisperNeedsRecipient,
      stateLabel: copy.whisperNoRecipient,
      whisperPreview,
    };
  }
  const stateLabel = preview.status === 'error' ? copy.unavailable : copy.confirming;
  return { joinedNames, reason: stateLabel, stateLabel, whisperPreview };
}

export function ComposerRoutingPreview({
  preview,
  onInsertMention,
  compact = false,
}: {
  preview: RoutingPreviewState;
  onInsertMention: (option: CatOption) => void;
  compact?: boolean;
}) {
  const copy = useShellCopy(composerRoutingCopy);
  const language = useShellLanguage();
  const { cats, getCatById } = useCatData();
  const trigger = useRef<HTMLButtonElement>(null);
  const sendToLabel = useRef<HTMLSpanElement>(null);
  const avatarGroup = useRef<HTMLSpanElement>(null);
  const chevron = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const identities = useMemo(() => buildComposerRecipientIdentities(cats), [cats]);
  const options = useMemo(() => buildRecipientOptions(cats, identities), [cats, identities]);
  const { reason, stateLabel, whisperPreview, unavailableNotice } = presentRoutingPreview(
    preview,
    copy,
    language,
    getCatById,
    identities,
  );
  const readyWithRecipients = preview.status === 'ready' && preview.targetCats.length > 0;
  const visibleRecipientCount = readyWithRecipients ? Math.min(preview.targetCats.length, 3) : 0;
  const recipientName = useWholeRecipientName(stateLabel, readyWithRecipients && !compact);
  const recipientNameIsDecorative = compact ? true : !recipientName.fits;
  const compactLayout = useCompactRoutingLayout({
    active: compact,
    hasChevron: !whisperPreview,
    visibleRecipientCount,
    button: trigger,
    sendToLabel,
    avatarGroup,
    chevron,
  });

  useEffect(() => {
    if (whisperPreview) setOpen(false);
  }, [whisperPreview]);

  return (
    <span
      className={`${styles.root} ${compact ? `${styles.compactRoot} max-sm:min-w-0 max-sm:flex-1 max-sm:overflow-hidden` : ''}`}
      data-testid="composer-routing-root"
      data-layout={compact ? 'compact' : 'default'}
      data-compact-recipient-count={compact ? visibleRecipientCount : undefined}
      data-compact-minimum-width={compactLayout.mobile ? compactLayout.minimumWidth : undefined}
      style={
        compactLayout.mobile && compactLayout.minimumWidth > 0
          ? {
              flexBasis: `${compactLayout.minimumWidth}px`,
              minInlineSize: `${compactLayout.minimumWidth}px`,
            }
          : undefined
      }
    >
      <AppTooltip label={reason} side="top" multiline disabled={open && !whisperPreview}>
        <button
          ref={trigger}
          type="button"
          data-testid="composer-routing-preview"
          className={`${styles.button} shell-focusable shell-rail-item flex h-8 min-w-0 items-center gap-1 rounded-lg px-1.5 text-xs text-[var(--shell-muted)] ${
            compact
              ? `${styles.compactButton} max-sm:gap-0.5 max-sm:overflow-hidden max-sm:whitespace-nowrap max-sm:px-0`
              : ''
          }`}
          aria-label={`${copy.sendTo}: ${stateLabel}. ${reason}`}
          aria-haspopup={whisperPreview ? undefined : 'dialog'}
          aria-expanded={whisperPreview ? undefined : open}
          aria-disabled={whisperPreview || undefined}
          onClick={() => {
            if (!whisperPreview) setOpen((value) => !value);
          }}
        >
          <span ref={sendToLabel} className="shrink-0 whitespace-nowrap">
            {copy.sendTo}
          </span>
          {preview.status === 'ready' && preview.targetCats.length > 0 ? (
            <span
              ref={avatarGroup}
              className={`flex shrink-0 -space-x-1 ${compact ? 'max-sm:ml-1' : ''}`}
              data-testid="composer-routing-avatars"
              aria-hidden="true"
            >
              {preview.targetCats.slice(0, 3).map((catId) => (
                <span key={catId} className="rounded-full ring-1 ring-[var(--shell-paper)]">
                  <ShellCatAvatar catId={catId} size={16} />
                </span>
              ))}
            </span>
          ) : null}
          {readyWithRecipients ? (
            <span
              ref={compact ? undefined : recipientName.slot}
              data-testid="composer-routing-name"
              data-name-fits={compact ? undefined : recipientName.fits ? 'true' : 'false'}
              data-compact-name-policy={compact ? 'whole-or-hidden' : undefined}
              aria-hidden={recipientNameIsDecorative}
              className={`${styles.readyName} ${compact ? 'truncate whitespace-nowrap' : ''} text-[var(--shell-ink-soft)]`}
              style={
                compact
                  ? compactLayout.mobile && !compactLayout.showName
                    ? { display: 'none' }
                    : undefined
                  : { visibility: recipientName.fits ? 'visible' : 'hidden' }
              }
            >
              {compact ? (
                stateLabel
              ) : (
                <span ref={recipientName.content} className={styles.readyNameContent}>
                  {stateLabel}
                </span>
              )}
            </span>
          ) : (
            <span
              data-testid="composer-routing-name"
              aria-hidden="true"
              className={`${styles.stateName} truncate whitespace-nowrap text-[var(--shell-ink-soft)]`}
            >
              {stateLabel}
            </span>
          )}
          {!whisperPreview ? (
            <span ref={chevron} className="flex-none" aria-hidden="true">
              <ShellGlyph name="chevronDown" className="h-3 w-3" />
            </span>
          ) : null}
        </button>
      </AppTooltip>
      {unavailableNotice ? (
        <output className="block whitespace-normal break-words px-1.5 text-xs text-[var(--shell-muted)]">
          {unavailableNotice}
        </output>
      ) : null}
      {open && !whisperPreview ? (
        <ComposerRecipientMenu
          anchor={trigger}
          copy={copy}
          identities={identities}
          options={options}
          onInsertMention={onInsertMention}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </span>
  );
}
