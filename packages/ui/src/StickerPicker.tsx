import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface StickerChoice {
  readonly id: string;
  readonly label: string;
  readonly group: string;
}
export interface StickerPickerProps {
  readonly choices: readonly StickerChoice[];
  readonly language?: 'zh' | 'en';
  readonly readImage: (id: string, signal: AbortSignal) => Promise<Blob>;
  readonly onSelect: (id: string, image: Blob) => Promise<void> | void;
  readonly onClose: () => void;
}

/** Shared artwork chooser. Hosts supply current-user image access and retain draft/send ownership. */
export function StickerPicker({ choices, language = 'zh', readImage, onSelect, onClose }: StickerPickerProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [group, setGroup] = useState<string>();
  const en = language === 'en';
  useEffect(() => {
    const prior = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialog.current?.showModal();
    return () => {
      dialog.current?.close();
      if (prior?.isConnected) prior.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(
    <dialog
      ref={dialog}
      className="cafe-sticker-picker"
      aria-label={en ? 'Stickers' : '贴纸'}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === dialog.current) onClose();
      }}
    >
      <header>
        <strong>{en ? 'Stickers' : '贴纸'}</strong>
        <button type="button" onClick={onClose} aria-label={en ? 'Close stickers' : '关闭贴纸'}>
          ×
        </button>
      </header>
      <p>{en ? 'Choose an expression to add to your draft' : '选一张，放进草稿'}</p>
      <nav aria-label={en ? 'Artwork characters' : '贴纸角色'}>
        <button type="button" aria-pressed={!group} onClick={() => setGroup(undefined)}>
          {en ? 'All' : '全部'}
        </button>
        {[...new Set(choices.map((choice) => choice.group))].map((value) => (
          <button type="button" key={value} aria-pressed={group === value} onClick={() => setGroup(value)}>
            {value}
          </button>
        ))}
      </nav>
      <div className="cafe-sticker-grid">
        {choices
          .filter((choice) => !group || choice.group === group)
          .map((choice) => (
            <StickerTile key={choice.id} choice={choice} en={en} readImage={readImage} onSelect={onSelect} />
          ))}
      </div>
    </dialog>,
    document.body,
  );
}

function StickerTile({
  choice,
  en,
  readImage,
  onSelect,
}: {
  choice: StickerChoice;
  en: boolean;
  readImage: StickerPickerProps['readImage'];
  onSelect: StickerPickerProps['onSelect'];
}) {
  const button = useRef<HTMLButtonElement>(null);
  const [requested, setRequested] = useState(false);
  const [image, setImage] = useState<{ blob: Blob; url: string }>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [selecting, setSelecting] = useState(false);
  const active = useRef(true);
  useEffect(() => {
    if (!button.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setRequested(true);
        observer.disconnect();
      }
    });
    observer.observe(button.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!requested) return;
    const controller = new AbortController();
    let url: string | undefined;
    setError(undefined);
    void readImage(choice.id, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(blob);
        setImage({ blob, url });
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(en ? 'Unavailable · Retry' : '暂时无法读取 · 重试');
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [requested, choice.id, readImage, attempt, en]);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  return (
    <button
      ref={button}
      type="button"
      className="cafe-sticker-tile"
      aria-label={choice.label}
      disabled={selecting || (!image && !error)}
      onClick={() => {
        if (error) {
          setAttempt((value) => value + 1);
          return;
        }
        if (!image) return;
        setSelecting(true);
        void Promise.resolve(onSelect(choice.id, image.blob))
          .catch(() => {
            if (active.current) setError(en ? 'Could not add · Retry' : '未能放进草稿 · 重试');
          })
          .finally(() => {
            if (active.current) setSelecting(false);
          });
      }}
    >
      {image ? <img src={image.url} alt="" /> : <span aria-hidden="true">…</span>}
      <span>{error ?? choice.label.split(' · ')[0]}</span>
    </button>
  );
}
