'use client';

import { useEffect, useState } from 'react';
import { API_URL, apiFetch } from '@/utils/api-client';

const HMR_IMAGE_URL = /^hmr:(hmr_[A-Za-z0-9_-]{32})$/;

export function AuthenticatedMediaImage({
  url,
  alt,
  className,
  onOpen,
}: {
  url: string;
  alt: string;
  className: string;
  onOpen?: (src: string) => void;
}) {
  const isHmr = url.startsWith('hmr:');
  const hmrId = HMR_IMAGE_URL.exec(url)?.[1];
  const [privateSrc, setPrivateSrc] = useState<{ hmrId: string; src: string } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!isHmr) return;
    if (!hmrId) {
      setFailed(true);
      return;
    }
    const abort = new AbortController();
    let objectUrl: string | undefined;
    setPrivateSrc(null);
    setFailed(false);
    void apiFetch(`/api/media/hmr/${encodeURIComponent(hmrId)}`, { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('private media unavailable');
        return response.blob();
      })
      .then((blob) => {
        if (abort.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setPrivateSrc({ hmrId, src: objectUrl });
      })
      .catch(() => {
        if (!abort.signal.aborted) setFailed(true);
      });
    return () => {
      abort.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [hmrId, isHmr]);

  if (isHmr && (failed || !hmrId)) {
    return (
      <span role="img" aria-label={alt} className="text-sm text-cafe-muted">
        图片暂不可用
      </span>
    );
  }
  const activePrivateSrc = privateSrc && privateSrc.hmrId === hmrId ? privateSrc.src : null;
  if (isHmr && !activePrivateSrc) {
    return <output className="text-sm text-cafe-muted">图片加载中</output>;
  }
  const src = isHmr ? (activePrivateSrc ?? '') : url.startsWith('/uploads/') ? `${API_URL}${url}` : url;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      className={className}
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onClick={() => onOpen?.(src)}
      onKeyDown={(event) => {
        if (onOpen && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          onOpen(src);
        }
      }}
      onError={() => {
        if (isHmr) setFailed(true);
      }}
    />
  );
}
