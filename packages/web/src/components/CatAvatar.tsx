'use client';

import { useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { hexToRgba } from '@/lib/color-utils';
import { PawIcon } from './icons/PawIcon';

type CatStatus = 'pending' | 'streaming' | 'done' | 'error' | 'alive_but_silent' | 'suspected_stall';

interface CatAvatarProps {
  catId: string;
  size?: number;
  status?: CatStatus;
}

export function CatAvatar({ catId, size = 32, status }: CatAvatarProps) {
  const [imgError, setImgError] = useState(false);
  const { getCatById } = useCatData();
  const cat = getCatById(catId);

  const isStreaming = status === 'streaming';
  const isError = status === 'error';
  const ringColor = cat?.color.primary ?? '#9CA3AF'; // gray-400 fallback
  const glowShadow = isStreaming && cat ? `0 0 10px ${hexToRgba(ringColor, 0.5)}` : undefined;

  return (
    <div
      className={`rounded-full ring-2 overflow-hidden flex-shrink-0 bg-cafe-surface-elevated flex items-center justify-center transition-shadow duration-300 ${
        isStreaming ? 'animate-pulse' : ''
      }`}
      style={{
        width: size,
        height: size,
        ['--tw-ring-color' as string]: isError ? '#ef4444' : ringColor,
        boxShadow: glowShadow,
      }}
    >
      {imgError ? (
        <PawIcon className="w-4 h-4 text-cafe-muted" />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={cat?.avatar ?? `/avatars/${catId}.png`}
          alt={cat?.displayName ?? catId}
          width={size}
          height={size}
          className="object-cover"
          onError={() => setImgError(true)}
        />
      )}
    </div>
  );
}
