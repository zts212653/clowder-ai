'use client';

import { PawIcon } from './icons/PawIcon';

/**
 * IdeateHeader — 独立观点采样横幅
 * Shown when parallel (ideate) mode is active.
 * Displays above the message area with a gradient background.
 */
export function IdeateHeader() {
  return (
    <div className="px-5 py-2.5 bg-gradient-to-r from-opus-bg via-codex-bg to-gemini-bg border-b border-cafe">
      <div className="flex items-center gap-2">
        <span className="animate-pulse">
          <PawIcon className="h-4 w-4 text-cafe-secondary" />
        </span>
        <span className="text-sm font-medium text-cafe-secondary">独立观点采样中</span>
        <span className="text-xs text-cafe-muted">猫猫们各自独立思考中...</span>
      </div>
    </div>
  );
}
