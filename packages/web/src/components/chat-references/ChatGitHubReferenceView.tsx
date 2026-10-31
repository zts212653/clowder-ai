import type { ChatGitHubReference } from '@cat-cafe/shared';
import type { ReactNode, RefObject } from 'react';
import { AppTooltip } from '../AppTooltip';
import { useShellCopy } from '../shell/shell-copy';
import { useShellLanguage } from '../shell/shell-language';
import styles from './chat-reference.module.css';
import { chatReferenceCopy } from './chat-reference.shell-copy';

function GitHubIcon({ issue }: { issue: boolean }) {
  return (
    <span className={`${styles.icon} ${styles.githubIcon}`}>
      <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
        {issue ? (
          <>
            <circle cx="8" cy="8" r="6" />
            <circle cx="8" cy="8" r="1.4" fill="currentColor" />
          </>
        ) : (
          <>
            <circle cx="4.5" cy="3.5" r="1.7" />
            <circle cx="4.5" cy="12.5" r="1.7" />
            <circle cx="11.5" cy="12.5" r="1.7" />
            <path d="M4.5 5.2v5.6M11.5 10.8V6.5a2 2 0 0 0-2-2H7.3m1.3-1.4-1.4 1.4 1.4 1.4" />
          </>
        )}
      </svg>
    </span>
  );
}

function MetadataParts({ items, leading }: { items: string[]; leading?: ReactNode }) {
  return (
    <span className={styles.prMetaFlow}>
      {leading ? (
        <span className={styles.prMetaLeading}>
          <span className={styles.prMetaSeparator} />
          {leading}
          {items.length > 0 ? ' ' : null}
        </span>
      ) : null}
      {items.map((item, index) => (
        <span key={index} className={styles.prMetaItem} title={item}>
          <span className={styles.prMetaSeparator}>{index === 0 ? '' : ' · '}</span>
          <span className={styles.prMetaValue}>{item}</span>
        </span>
      ))}
    </span>
  );
}

export function ChatGitHubReferenceView({
  target,
  layout,
  anchor,
  onOpen,
}: {
  target: ChatGitHubReference;
  layout: string;
  anchor: RefObject<HTMLSpanElement>;
  onOpen: () => void;
}) {
  const t = useShellCopy(chatReferenceCopy),
    language = useShellLanguage();
  const card = layout === 'card',
    local = target.objectType === 'pull' && !!target.worktreeId;
  const state =
    target.state === 'merged'
      ? styles.merged
      : target.state === 'closed'
        ? styles.closed
        : target.state === 'open'
          ? styles.githubOpen
          : '';
  const pill = target.state ? (
    <span data-chat-reference-state={target.state} className={styles.pill}>
      {target.state === 'open' ? t.openState : t[target.state]}
    </span>
  ) : null;
  const title = target.title
    ? Array.from(target.title).slice(0, 28).join('') + (Array.from(target.title).length > 28 ? '…' : '')
    : '';
  const metadata = [
    target.additions !== undefined && target.deletions !== undefined
      ? `+${target.additions} −${target.deletions}`
      : null,
    target.changedFiles !== undefined ? `${target.changedFiles} ${t.files}` : null,
    target.checks ? t[target.checks] : null,
    target.author ?? null,
    target.updatedAt
      ? new Date(target.updatedAt).toLocaleTimeString(language === 'en' ? 'en-US' : 'zh-CN', {
          hour: '2-digit',
          minute: '2-digit',
        })
      : null,
  ].filter((item): item is string => item !== null);
  const inline = (
    <>
      <GitHubIcon issue={target.objectType === 'issue'} />
      <span className={styles.inlineTitle}>
        #{target.number}
        {title ? ` ${title}` : ''}
      </span>
      {pill}
    </>
  );
  const fullLabel = `#${target.number}${target.title ? ` ${target.title}` : ''}${target.state ? ` · ${target.state === 'open' ? t.openState : t[target.state]}` : ''}`;
  return (
    <AppTooltip label={fullLabel} detail={target.url} intent="content" multiline>
      <span
        ref={anchor}
        data-chat-reference-kind="github"
        data-chat-reference-layout={layout}
        className={`${styles.reference} ${state} ${card ? `${styles.card} ${styles.prCard}` : styles.chip}`}
      >
        {card ? (
          <>
            <span className={styles.big}>
              <GitHubIcon issue={target.objectType === 'issue'} />
            </span>
            <span className={styles.prBody}>
              <span className={`${styles.meta} ${styles.prRepository}`}>
                <MetadataParts items={[target.repo, `#${target.number}`]} />
              </span>
              {target.title ? <span className={styles.name}>{target.title}</span> : null}
              <span className={`${styles.meta} ${styles.prStatus}`}>
                <MetadataParts items={metadata} leading={pill} />
              </span>
              <span className={styles.prActions}>
                {local ? (
                  <button type="button" className={`shell-focusable ${styles.open}`} onClick={onOpen}>
                    {t.changes}
                  </button>
                ) : null}
                <a href={target.url} target="_blank" rel="noopener noreferrer">
                  {t.github} ↗
                </a>
              </span>
            </span>
          </>
        ) : local ? (
          <button type="button" aria-label={fullLabel} className={`shell-focusable ${styles.open}`} onClick={onOpen}>
            {inline}
          </button>
        ) : (
          <a aria-label={fullLabel} className={styles.open} href={target.url} target="_blank" rel="noopener noreferrer">
            {inline}
          </a>
        )}
      </span>
    </AppTooltip>
  );
}
