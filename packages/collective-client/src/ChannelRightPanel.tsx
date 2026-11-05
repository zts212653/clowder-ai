import type { ReactNode } from 'react';
import { useCollectiveLanguage, useCollectiveText } from './collective-copy.js';
export function ChannelRightPanel({
  title,
  onClose,
  children,
}: {
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const t = useCollectiveText();
  const language = useCollectiveLanguage();
  const label = t(title);
  return (
    <aside className="context-panel channel-right-panel" aria-label={label} data-spatial-role="context-panel">
      <header className="context-header">
        <h2>{label}</h2>
        <button type="button" aria-label={language === 'en' ? `Close ${label}` : `关闭${label}`} onClick={onClose}>
          ×
        </button>
      </header>
      <div className="channel-right-content">{children}</div>
    </aside>
  );
}
