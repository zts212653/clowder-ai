'use client';

import type { ChatBackgroundImageState as ChatBackgroundImage } from '@cat-cafe/shared';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef } from 'react';
import { useActualColours } from '@/hooks/useActualColours';
import { useThemeStore } from '@/stores/themeStore';
import {
  backgroundManualModes,
  followAutomaticBackgroundOpacity,
  recommendedBackgroundOpacity,
} from './background-opacity';
import { sampleBackgroundOpacity } from './background-sampling';
import { useChatBackgroundPreferences } from './ChatBackgroundProvider';

/** Recompute automatic defaults when the actual surface or selectable theme palettes change. */
export function useRefreshBackgroundRecommendation(image: ChatBackgroundImage | null, threadId: string | null) {
  const controller = useChatBackgroundPreferences();
  const themes = useThemeStore((state) => state.themes);
  const actual = useActualColours();
  const actualColourKey = JSON.stringify(actual);
  const themeKey = useMemo(() => JSON.stringify(themes.map(({ base, params }) => ({ base, params }))), [themes]);
  const pathname = usePathname();
  const section = useSearchParams().get('s');
  const current = useRef(image);
  current.current = image;
  const attempted = useRef<string | null>(null);
  const save = controller?.save;
  const ready = controller?.enabled && !controller.loading && !controller.loadError;
  const override = threadId && controller?.preferences.threads[threadId] !== undefined ? threadId : null;
  useEffect(() => {
    if (!image || !ready || !save) return;
    const key = JSON.stringify([themeKey, actualColourKey, pathname, section, override, image.url, image.placement]);
    if (attempted.current === key) return;
    attempted.current = key;
    let active = true;
    let finished = false;
    void sampleBackgroundOpacity(image.url, image.placement, actual)
      .then(async (readableOpacity) => {
        if (!active || current.current !== image) return;
        finished = true;
        const recommendedOpacity = recommendedBackgroundOpacity(readableOpacity);
        if (
          recommendedOpacity.light === image.recommendedOpacity.light &&
          recommendedOpacity.dark === image.recommendedOpacity.dark &&
          readableOpacity.light === image.readableOpacity?.light &&
          readableOpacity.dark === image.readableOpacity?.dark
        )
          return;
        await save({
          scope: override ? 'thread' : 'global',
          ...(override ? { threadId: override } : {}),
          background: {
            ...image,
            opacity: followAutomaticBackgroundOpacity(image, recommendedOpacity),
            recommendedOpacity,
            readableOpacity,
            manualOpacity: backgroundManualModes(image),
          },
        });
      })
      .catch(() => {
        // A failed decode never writes a replacement preference. A new surface/theme/choice can try again.
        finished = true;
      });
    return () => {
      active = false;
      if (!finished && attempted.current === key) attempted.current = null;
    };
  }, [image, themeKey, actualColourKey, actual, pathname, section, override, ready, save]);
}
