'use client';

import { useRef, useState } from 'react';

type RecoveryState = 'idle' | 'pending' | 'failed' | 'recovered';

/** The caller supplies the Host operation; only its observed true result can claim recovery. */
export function CompanionRecoveryAction({
  partnerName,
  restore,
}: {
  partnerName?: string;
  restore: () => Promise<boolean>;
}) {
  const [state, setState] = useState<RecoveryState>('idle');
  const inFlight = useRef(false);

  const tryRestore = async () => {
    if (inFlight.current || state === 'recovered') return;
    inFlight.current = true;
    setState('pending');
    try {
      setState((await restore()) ? 'recovered' : 'failed');
    } catch {
      setState('failed');
    } finally {
      inFlight.current = false;
    }
  };

  return (
    <div className="mt-2 space-y-1.5" data-testid="companion-recovery-action">
      <button
        type="button"
        disabled={state === 'pending' || state === 'recovered'}
        onClick={() => void tryRestore()}
        className="rounded-lg bg-cafe-accent px-3 py-1.5 font-medium text-[var(--cafe-accent-foreground)] disabled:opacity-60"
      >
        {state === 'pending' ? '正在重新打开…' : state === 'recovered' ? '桌面猫猫球已恢复' : '重新打开桌面猫猫球'}
      </button>
      <p aria-live="polite" className="text-cafe-muted">
        {state === 'failed' ? '未能重新打开；网页聊天仍可用。' : ''}
        {partnerName ? `当前仍由${partnerName}陪伴。` : '所选陪伴者保持不变。'}
      </p>
    </div>
  );
}
