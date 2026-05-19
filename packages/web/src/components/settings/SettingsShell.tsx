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
        <div className="m-3 flex flex-1 flex-col overflow-y-auto rounded-[18px] bg-[var(--console-shell-bg)] px-5 py-6 shadow-[var(--console-shadow-soft)] md:px-9 md:py-8">
          <div className="space-y-5">
            <SettingsContent section={activeSection} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="console-shell flex h-full min-h-0 flex-col overflow-hidden bg-[var(--console-shell-bg)] md:flex-row">
      <aside
        className="flex max-h-[42vh] w-full flex-shrink-0 flex-col overflow-hidden bg-[var(--console-panel-bg)] md:max-h-none md:w-[220px]"
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
        <div className="space-y-5 px-5 py-5 md:px-8 md:py-7">
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
