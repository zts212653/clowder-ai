'use client';

import { useEffect, useRef } from 'react';

interface RuntimeUpdateRequiredDialogProps {
  onReload: () => void;
}

export function RuntimeUpdateRequiredDialog({ onReload }: RuntimeUpdateRequiredDialogProps) {
  const reloadButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    reloadButtonRef.current?.focus();
    const keepRecoveryFocused = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      event.preventDefault();
      reloadButtonRef.current?.focus();
    };
    window.addEventListener('keydown', keepRecoveryFocused);
    return () => {
      window.removeEventListener('keydown', keepRecoveryFocused);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-[var(--console-overlay-backdrop)] p-4 backdrop-blur-sm"
      data-testid="runtime-update-required"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="runtime-update-required-title"
      aria-describedby="runtime-update-required-description"
    >
      <div className="w-full max-w-md rounded-2xl border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] p-5 shadow-xl">
        <h2 id="runtime-update-required-title" className="text-lg font-semibold text-cafe-primary">
          页面已经更新
        </h2>
        <p id="runtime-update-required-description" className="mt-2 text-sm leading-6 text-cafe-secondary">
          当前打开的页面来自上一个版本。为了避免旧页面提交不兼容的数据，发送和转发已暂停；刷新后可以继续。
        </p>
        <button
          ref={reloadButtonRef}
          type="button"
          onClick={onReload}
          className="mt-4 min-h-11 w-full rounded-xl bg-[var(--color-cafe-accent)] px-4 py-2.5 text-sm font-semibold text-[var(--color-cafe-on-accent)] transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-cafe-accent)] focus-visible:ring-offset-2"
        >
          刷新页面
        </button>
      </div>
    </div>
  );
}
