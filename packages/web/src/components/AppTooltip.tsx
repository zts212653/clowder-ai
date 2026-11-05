'use client';

import { type AppTooltipProps, AppTooltip as SharedTooltip } from '@cat-cafe/ui';
import type { RefObject } from 'react';
import { useActionOwnerReset, useActionSurfaceRef } from './message-v2/message-action-ownership';

export {
  APP_TOOLTIP_CONTENT_DELAY_MS,
  APP_TOOLTIP_DELAY_MS,
  APP_TOOLTIP_WARM_MS,
  type AppTooltipSide,
  resetAppTooltipWarmState,
} from '@cat-cafe/ui';

function useAppOwnership(close: () => void, tip: RefObject<HTMLDivElement>) {
  useActionOwnerReset(close, undefined, undefined, true);
  return useActionSurfaceRef<HTMLDivElement>(undefined, undefined, tip);
}
export function AppTooltip(props: Omit<AppTooltipProps, 'useOwnership'>) {
  return <SharedTooltip {...props} useOwnership={useAppOwnership} />;
}
