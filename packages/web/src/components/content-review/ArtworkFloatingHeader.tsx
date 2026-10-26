import { type RefObject, useState } from 'react';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useArtworkChrome, useRegisterArtworkWorkMode } from './ArtworkChrome';
import styles from './artwork-actions.module.css';
import { artworkActionsCopy } from './artwork-actions.shell-copy';

export function ArtworkFloatingHeader({
  title,
  position,
  onClose,
  closeRef,
  onOpenWorkspace,
  busy,
  onError,
}: {
  title: string;
  position?: string;
  onClose: () => void;
  closeRef: RefObject<HTMLButtonElement>;
  onOpenWorkspace?: () => Promise<boolean>;
  busy?: boolean;
  onError: (message: string | null) => void;
}) {
  const chrome = useArtworkChrome();
  const t = useShellCopy(artworkActionsCopy);
  const [opening, setOpening] = useState(false);
  const openWorkspace = async () => {
    if (!onOpenWorkspace || busy || opening) return;
    setOpening(true);
    onError(null);
    try {
      if (await onOpenWorkspace()) onClose();
      else onError(t.openFailed);
    } catch {
      onError(t.openFailed);
    } finally {
      setOpening(false);
    }
  };
  useRegisterArtworkWorkMode(onOpenWorkspace ? () => void openWorkspace() : undefined, !!busy || opening);
  return (
    <header className={styles.header} data-testid="artwork-header">
      <span className={styles.title} title={title}>
        {title}
      </span>
      {position ? (
        <span className="shrink-0 text-xs tabular-nums text-cafe-muted" data-testid="artwork-gallery-position">
          {position}
        </span>
      ) : null}
      <div ref={chrome?.setVersion} className={styles.version} />
      <div className={styles.headerActions}>
        {onOpenWorkspace ? (
          <button
            type="button"
            data-testid="lightbox-open-workspace"
            disabled={busy || opening}
            className={styles.workMode}
            onClick={() => void openWorkspace()}
          >
            {t.workMode}
          </button>
        ) : null}
        <div ref={chrome?.setActions} role="group" aria-label={t.more} tabIndex={-1} className={styles.headerActions} />
        <button ref={closeRef} type="button" aria-label={t.close} onClick={onClose}>
          ×
        </button>
      </div>
    </header>
  );
}
