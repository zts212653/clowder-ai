'use client';

import { resolveChatBackgroundState as resolveChatBackground } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import { useCafeTheme } from '@/hooks/useCafeTheme';
import { useChatBackgroundPreferences } from './ChatBackgroundProvider';
import { useRefreshBackgroundRecommendation } from './useRefreshBackgroundRecommendation';

/** One viewport-aligned image; each painted surface composites it directly with its own colour. */
export function ChatBackgroundLayer({ threadId }: { threadId: string | null }) {
  const controller = useChatBackgroundPreferences();
  const { resolvedTheme } = useCafeTheme();
  const preference = controller ? resolveChatBackground(controller.preferences, threadId) : null;
  const image = preference?.kind === 'image' ? preference : null;
  useRefreshBackgroundRecommendation(image, threadId);
  const imageUrl = image?.url ?? null;
  const [loaded, setLoaded] = useState<string | null>(null);
  useEffect(() => {
    if (!imageUrl) {
      setLoaded(null);
      return;
    }
    let active = true;
    const asset = new Image();
    asset.onload = () => {
      if (active) setLoaded(imageUrl);
    };
    asset.onerror = () => {
      if (active) setLoaded(null);
    };
    asset.src = imageUrl;
    return () => {
      active = false;
    };
  }, [imageUrl]);
  const visible = image !== null && loaded === image.url;
  const opacity = image?.opacity[resolvedTheme];
  const placement = image?.placement;
  useEffect(() => {
    const root = document.documentElement;
    if (!visible || opacity === undefined) return;
    root.style.setProperty('--chat-background-image', `url("${imageUrl}")`);
    root.style.setProperty('--chat-background-veil-opacity', String(1 - opacity));
    root.style.setProperty('--chat-background-size', placement === 'fill' ? 'cover' : 'auto');
    root.style.setProperty('--chat-background-repeat', placement === 'tile' ? 'repeat' : 'no-repeat');
    root.dataset.chatBackground = 'image';
    return () => {
      delete root.dataset.chatBackground;
      for (const name of ['image', 'veil-opacity', 'size', 'repeat'])
        root.style.removeProperty(`--chat-background-${name}`);
    };
  }, [visible, imageUrl, opacity, placement]);
  if (!visible) return null;
  return (
    <div
      aria-hidden="true"
      className="chat-background-layer"
      data-testid="chat-background-layer"
      data-placement={image.placement}
      data-image-url={image.url}
      style={{ backgroundImage: `url("${image.url}")` }}
    >
      <div className="chat-background-veil" />
    </div>
  );
}
