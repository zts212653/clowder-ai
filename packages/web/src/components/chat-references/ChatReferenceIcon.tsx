import type { ChatFileReference } from '@cat-cafe/shared';
import styles from './chat-reference.module.css';

export function chatReferenceFileType(target: Pick<ChatFileReference, 'path' | 'entryType'>): string {
  if (target.entryType === 'directory') return 'Folder';
  const extension = target.path.split('.').at(-1)?.toLowerCase() ?? '';
  return (
    (
      {
        md: 'Markdown',
        mdx: 'Markdown',
        pptx: 'PowerPoint',
        ppt: 'PowerPoint',
        docx: 'Word',
        doc: 'Word',
        xlsx: 'Excel',
        xls: 'Excel',
        pdf: 'PDF',
      } as Record<string, string>
    )[extension] ?? extension.toUpperCase()
  );
}
export function ChatReferenceIcon({ target }: { target: Pick<ChatFileReference, 'path' | 'entryType'> }) {
  if (target.entryType === 'directory')
    return (
      <span className={styles.icon}>
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M1.5 4.2a1 1 0 0 1 1-1h3.4l1.4 1.5h6.2a1 1 0 0 1 1 1v6.8a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"
            fill="#efe3c6"
            stroke="#b39a62"
          />
        </svg>
      </span>
    );
  const type = chatReferenceFileType(target);
  const office = (
    {
      PowerPoint: ['P', '#c9532d'],
      Word: ['W', '#3b67a8'],
      Excel: ['X', '#2f7a4d'],
      PDF: ['PDF', '#b8392f'],
    } as Record<string, string[]>
  )[type];
  if (office)
    return (
      <span
        aria-hidden="true"
        className={`${styles.officeIcon} ${type === 'PDF' ? styles.pdfIcon : ''}`}
        style={{ background: office[1] }}
      >
        {office[0]}
      </span>
    );
  const code = /\.(?:[cm]?[jt]sx?|py|rs|go|sh|css|html|json|ya?ml|toml)$/i.test(target.path);
  return (
    <span className={styles.icon}>
      <svg
        viewBox="0 0 16 16"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      >
        <path d="M3.5 1.5h6l3 3v10h-9z" />
        <path d="M9.5 1.5v3h3" />
        {code ? (
          <path d="M6.6 8.3 5.2 9.8l1.4 1.5M9.4 8.3l1.4 1.5-1.4 1.5" />
        ) : (
          <path d="M5.5 8h5M5.5 10.2h5M5.5 12.4h3" strokeLinecap="round" />
        )}
      </svg>
    </span>
  );
}

export function ChatMissingFileIcon() {
  return (
    <span className={styles.icon}>
      <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.1">
        <path d="M3.5 1.5h6l3 3v10h-9z" strokeDasharray="2 1.6" />
        <path d="M5 12 11 6" />
      </svg>
    </span>
  );
}
