import { useEffect } from 'react';
import { useVisibleCafePresence as usePresence } from '../hooks/useVisibleCafePresence';
import { useFrameVisible } from './frame-api';

export function useVisibleCafePresence(options: Parameters<typeof usePresence>[0]): void {
  const visible = useFrameVisible();
  usePresence({ ...options, enabled: (options.enabled ?? true) && visible });
  useEffect(() => {
    window.parent.postMessage({ type: 'clowder-frame-ready' }, window.location.origin);
  }, []);
}
