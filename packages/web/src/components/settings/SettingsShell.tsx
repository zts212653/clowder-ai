'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback } from 'react';
import { SettingsContent } from './SettingsContent';
import { SettingsNav } from './SettingsNav';
import { DEFAULT_SECTION } from './settings-nav-config';

function SettingsShellInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeSection = searchParams.get('s') ?? DEFAULT_SECTION;
  const standalone = searchParams.get('standalone') === '1';

  const handleSelect = useCallback(
    (sectionId: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set('s', sectionId);
      router.replace(`/settings?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  if (standalone) {
    return (
      <div className="flex h-full flex-col bg-[var(--console-panel-bg)]">
        <div className="flex flex-1 flex-col overflow-y-auto rounded-[18px] bg-[var(--console-shell-bg)] shadow-[var(--console-shadow-soft)] m-3 px-9 py-8">
          <div className="space-y-5">
            <SettingsContent section={activeSection} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="console-shell flex h-full min-h-0 overflow-hidden bg-[var(--console-shell-bg)]">
      <aside
        className="flex w-[220px] flex-shrink-0 flex-col overflow-hidden bg-[var(--console-panel-bg)]"
        data-console-panel="settings-nav"
      >
        <div className="px-4 pt-4 pb-2">
          <h1 className="text-lg font-bold text-cafe">设置</h1>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          <SettingsNav activeSection={activeSection} onSelect={handleSelect} />
        </div>
      </aside>

      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="space-y-5 px-8 py-7">
          <SettingsContent section={activeSection} />
        </div>
      </div>
    </div>
  );
}

export function SettingsShell() {
  return (
    <Suspense>
      <SettingsShellInner />
    </Suspense>
  );
}
