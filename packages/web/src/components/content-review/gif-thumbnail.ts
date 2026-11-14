'use client';
import { useSyncExternalStore } from 'react';
import { API_URL } from '@/utils/api-client';

const query = '(prefers-reduced-motion: reduce)';
function subscribe(listener: () => void) {
  const media = window.matchMedia?.(query);
  media?.addEventListener('change', listener);
  return () => media?.removeEventListener('change', listener);
}
const snapshot = () => Boolean(window.matchMedia?.(query).matches);
export function useReducedMediaMotion() {
  return useSyncExternalStore(subscribe, snapshot, () => true);
}

/** Preview-only routing. Open/download callers keep the original URL and MIME. */
export function gifThumbnailSource(src: string, reduced: boolean, mime?: string) {
  if (!reduced || (mime !== 'image/gif' && !/\.gif(?:[?#]|$)/i.test(src))) return src;
  const local = (src.startsWith('/') && !src.startsWith('//')) || src.startsWith(`${API_URL}/`);
  if (!local) return src;
  const uploaded = /^(.*\/uploads\/[^/?#]+)(?:\?[^#]*)?$/.exec(src);
  if (uploaded) return `${uploaded[1]}/gif-poster`;
  if (/\/api\/content-publications\/[^/]+\/media\/\d+(?:\?|$)|\/api\/workspace\/file\/raw\?/.test(src))
    return `${src}${src.includes('?') ? '&' : '?'}display=gif-poster`;
  return src;
}
