'use client';
import type { ChatFileReference } from '@cat-cafe/shared';
import type { ReactNode, RefObject } from 'react';
import { API_URL } from '@/utils/api-client';
import { AuthenticatedMediaImage } from '../AuthenticatedMediaImage';
import { useShellCopy } from '../shell/shell-copy';
import { useShellLanguage } from '../shell/shell-language';
import { ChatFileActions } from './ChatFileActions';
import { ChatReferenceIcon, chatReferenceFileType } from './ChatReferenceIcon';
import styles from './chat-reference.module.css';
import { chatReferenceCopy } from './chat-reference.shell-copy';

function size(bytes: number) {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
export function ChatFileReferenceView({
  target,
  layout,
  anchor,
  onOpen,
  error,
  lightbox,
}: {
  target: ChatFileReference;
  layout: string;
  anchor: RefObject<HTMLSpanElement>;
  onOpen: () => void;
  error: string;
  lightbox: ReactNode;
}) {
  const t = useShellCopy(chatReferenceCopy),
    language = useShellLanguage();
  const card = layout === 'card',
    image = target.mime.startsWith('image/');
  const absolutePath = target.absolutePath.replace(/\/+$/, '') || '/';
  const separator = absolutePath.lastIndexOf('/');
  const filename = absolutePath.slice(separator + 1) || '/';
  const directory = absolutePath.slice(0, separator + 1);
  const raw = `${API_URL}/api/workspace/file/raw?${new URLSearchParams({ worktreeId: target.worktreeId, path: target.path })}`;
  const name = card ? (
    <span data-chat-file-name className={styles.name}>
      {filename}
      {target.line ? <span className={styles.line}>:{target.line}</span> : null}
    </span>
  ) : (
    <>
      <span className={styles.filename}>{filename}</span>
      {target.line ? <span className={styles.line}>:{target.line}</span> : null}
    </>
  );
  const picture = <AuthenticatedMediaImage url={raw} alt="" className={card ? styles.preview : styles.thumbnail} />;
  const type = target.entryType === 'directory' ? t.directory : image ? t.image : chatReferenceFileType(target);
  return (
    <span
      ref={anchor}
      data-chat-reference-kind="file"
      data-chat-reference-layout={layout}
      className={`${styles.reference} ${styles.interactive} ${card ? styles.card : styles.chip} ${card && image ? styles.imageCard : ''}`}
      title={target.absolutePath}
    >
      <button
        type="button"
        aria-label={`${target.absolutePath}${target.line ? `:${target.line}` : ''}`}
        className={`shell-focusable ${styles.open}`}
        onClick={onOpen}
      >
        {card && image ? (
          <>
            {picture}
            <span className={styles.caption}>
              {name}
              <span className={styles.meta}>
                {t.image}
                {target.width && target.height ? ` · ${target.width}×${target.height}` : ` · ${size(target.size)}`}
              </span>
            </span>
          </>
        ) : card ? (
          <>
            <span className={styles.big}>
              <ChatReferenceIcon target={target} />
            </span>
            <span className={styles.fileBody}>
              {name}
              <span className={`${styles.directory} ${styles.mono}`}>{directory}</span>
              <span data-chat-file-metadata className={`${styles.meta} ${styles.fileMeta}`}>
                {type}
                {target.pageCount !== undefined ? ` · ${target.pageCount} ${t[target.pageUnit ?? 'pages']}` : ''} ·{' '}
                {size(target.size)} ·{' '}
                {new Date(target.modifiedAt).toLocaleDateString(language === 'en' ? 'en-US' : 'zh-CN')}
              </span>
            </span>
          </>
        ) : (
          <>
            {image ? picture : <ChatReferenceIcon target={target} />}
            {name}
          </>
        )}
      </button>
      <ChatFileActions target={target} hideTrigger anchorRef={anchor} />
      {error ? <span role="alert">{error}</span> : null}
      {lightbox}
    </span>
  );
}
