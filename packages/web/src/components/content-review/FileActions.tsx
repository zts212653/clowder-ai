'use client';
import { createPortal } from 'react-dom';
import { useWorkspaceSurfaceVisibility } from '@/components/workbench/WorkspaceSurfaceVisibility';
import styles from './artwork-actions.module.css';
import { FileActionMenu } from './FileActionMenu';
import { downloadContentFile, runContentFileAction } from './file-action-client';
import type { FileActionsProps } from './file-actions-contract';
import { ReviewToolbarIcon } from './ReviewToolbarIcon';
import { useFileActionController } from './useFileActionController';

export function FileActions(props: FileActionsProps) {
  const {
    source,
    filename,
    mime,
    byteLength,
    width,
    height,
    target,
    visible: requestedVisible = true,
    text,
    copyName = false,
    showDownload = false,
    hideTrigger = false,
    appearance = 'menu',
    viewport,
    wholeWorkAction,
    onHistory,
    workMode,
  } = props;
  const visible = useWorkspaceSurfaceVisibility() && requestedVisible;
  const {
    src,
    isVideo,
    link,
    t,
    position,
    setPosition,
    info,
    notice,
    menu,
    trigger,
    perform,
    copyPixels,
    copyLocation,
    copyContent,
    canCopyContent,
    openMenu,
    closeMenu,
  } = useFileActionController({ ...props, visible });
  if (!visible || !link) return null;
  if (appearance === 'copy')
    return (
      <button
        type="button"
        className="rounded border border-cafe px-2 py-1 text-xs"
        onClick={() => void copyPixels()}
        title={notice ? t[notice] : t.copyImage}
      >
        {notice ? t[notice] : t.copyImage}
      </button>
    );
  const actions = (
    <>
      {appearance === 'classic' ? (
        <>
          {text !== undefined && (
            <button
              type="button"
              onClick={() => void perform(() => navigator.clipboard.writeText(text), 'copiedContent')}
            >
              {t.copyContent}
            </button>
          )}
          <button
            type="button"
            disabled={!info}
            onClick={() => void copyLocation()}
            title={info?.local ? t.copyPath : t.copyLink}
          >
            {info?.local ? t.copyPath : t.copyLink}
          </button>
          {info?.local && info.canReveal !== false && (
            <button
              type="button"
              onClick={() => void perform(() => runContentFileAction(source, 'reveal'))}
              title={t.reveal}
            >
              {t.reveal}
            </button>
          )}
        </>
      ) : null}
      {showDownload ? (
        <button
          type="button"
          onClick={() => void perform(() => downloadContentFile(link, filename))}
          className={`${styles.trigger} ${styles.download}`}
          aria-label={t.download}
          title={t.download}
        >
          <span className={styles.downloadIcon}>
            <ReviewToolbarIcon name="download" />
          </span>
          <span className={styles.downloadLabel}>{t.download}</span>
        </button>
      ) : null}
      {!hideTrigger ? (
        <button
          ref={trigger}
          type="button"
          className={styles.trigger}
          aria-label={t.more}
          aria-haspopup="menu"
          aria-expanded={!!position}
          onClick={() => {
            if (position) setPosition(null);
            else {
              const r = trigger.current?.getBoundingClientRect();
              openMenu(r?.right ?? 8, r?.bottom ?? 8);
            }
          }}
        >
          ⋯
        </button>
      ) : null}
      {position ? (
        <FileActionMenu
          position={position}
          menu={menu}
          trigger={trigger}
          info={info}
          link={link}
          filename={filename}
          mime={mime}
          byteLength={byteLength}
          width={width}
          height={height}
          isVideo={isVideo}
          src={src}
          wholeWorkAction={wholeWorkAction}
          workMode={workMode}
          download={() => void perform(() => downloadContentFile(link, filename))}
          history={onHistory}
          scale={viewport?.renderedScale}
          close={closeMenu}
          copyLocation={copyLocation}
          copyPixels={copyPixels}
          fileAction={(action) => void perform(() => runContentFileAction(source, action))}
          canCopyContent={canCopyContent}
          copyContent={copyContent}
          copyName={
            copyName ? () => void perform(() => navigator.clipboard.writeText(filename), 'copiedContent') : undefined
          }
          toggleSize={
            viewport
              ? () => {
                  if (Math.abs(viewport.renderedScale - 1) < 0.001) viewport.fit();
                  else viewport.actual();
                }
              : undefined
          }
        />
      ) : null}
      {notice ? <output className={styles.notice}>{t[notice]}</output> : null}
    </>
  );
  return target ? createPortal(actions, target) : actions;
}
