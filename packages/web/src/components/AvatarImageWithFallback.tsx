'use client';

import { useEffect, useState } from 'react';

const AVATAR_FALLBACK_DATA_URL =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByeD0iOCIgZmlsbD0iI2U1ZTdlYiIvPjxjaXJjbGUgY3g9IjMyIiBjeT0iMzgiIHI9IjE0IiBmaWxsPSIjOWNhM2FmIi8+PHBvbHlnb24gcG9pbnRzPSIyMCwyMiAxNiw4IDI4LDE2IiBmaWxsPSIjOWNhM2FmIi8+PHBvbHlnb24gcG9pbnRzPSI0NCwyMiA0OCw4IDM2LDE2IiBmaWxsPSIjOWNhM2FmIi8+PGNpcmNsZSBjeD0iMjciIGN5PSIzNiIgcj0iMiIgZmlsbD0iIzM3NDE1MSIvPjxjaXJjbGUgY3g9IjM3IiBjeT0iMzYiIHI9IjIiIGZpbGw9IiMzNzQxNTEiLz48L3N2Zz4=';

interface AvatarImageWithFallbackProps {
  src: string | null | undefined;
  alt: string;
  className?: string;
}

export function AvatarImageWithFallback({ src, alt, className }: AvatarImageWithFallbackProps) {
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    setErrored(false);
  }, [src]);

  const finalSrc = errored || !src ? AVATAR_FALLBACK_DATA_URL : src;

  return (
    // biome-ignore lint/performance/noImgElement: avatar src may be a runtime upload URL or inline SVG fallback, not suitable for next/image optimization
    // eslint-disable-next-line @next/next/no-img-element
    <img src={finalSrc} alt={alt} className={className} onError={() => setErrored(true)} />
  );
}
