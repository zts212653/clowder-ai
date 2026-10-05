'use client';

import { lazy, Suspense, useState } from 'react';
import { useThemeStore } from '@/stores/themeStore';
import { type ShellPresentation, useShellPresentation, writeShellPresentation } from '../shell/shell-presentation';

const OklchTuner = lazy(() => import('../dev/OklchTuner').then((m) => ({ default: m.OklchTuner })));

const MAX_CUSTOM = 2;

const PRESENTATIONS: ReadonlyArray<{ id: ShellPresentation; label: string; note: string }> = [
  { id: 'v2', label: '新版界面', note: '窄栏、对话栏与顶栏按新版布局' },
  { id: 'classic', label: '经典界面', note: '原来的布局，数据和权限完全相同' },
];

/**
 * 主题 — the one place for how the app looks. Themes come from the existing themeStore (built-in light/dark and up to
 * two custom ones); nothing here keeps its own copy. 界面版本 sits here because it only changes presentation.
 */
export function ThemeSettingsPanel() {
  const store = useThemeStore();
  const presentation = useShellPresentation();
  const [tunerOpen, setTunerOpen] = useState(false);
  const customCount = store.themes.filter((theme) => !theme.builtIn).length;

  return (
    <div className="space-y-6" data-testid="theme-settings-panel">
      <section aria-labelledby="shell-presentation-heading">
        <h2 id="shell-presentation-heading" className="text-sm font-semibold" style={{ color: 'var(--shell-ink)' }}>
          界面版本
        </h2>
        <div role="radiogroup" aria-labelledby="shell-presentation-heading" className="mt-2 flex flex-col gap-1.5">
          {PRESENTATIONS.map((option) => {
            const selected = presentation === option.id;
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={selected}
                data-testid={`shell-presentation-${option.id}`}
                onClick={() => writeShellPresentation(option.id)}
                className="shell-focusable flex items-center gap-3 rounded-lg px-3 py-2 text-left text-sm"
                style={{
                  background: selected ? 'var(--shell-selected)' : 'var(--shell-paper)',
                  border: '1px solid var(--shell-hairline)',
                  color: 'var(--shell-ink)',
                }}
              >
                <span
                  aria-hidden="true"
                  className="h-3.5 w-3.5 flex-none rounded-full"
                  style={{
                    border: '1.5px solid var(--shell-ink)',
                    background: selected ? 'var(--shell-ink)' : 'transparent',
                  }}
                />
                <span className="flex-1">
                  {option.label}
                  <span className="ml-2 text-xs" style={{ color: 'var(--shell-muted)' }}>
                    {option.note}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="theme-list-heading">
        <h2 id="theme-list-heading" className="text-sm font-semibold" style={{ color: 'var(--shell-ink)' }}>
          配色
        </h2>
        <ul className="mt-2 flex list-none flex-col gap-1.5 p-0">
          {store.themes.map((theme) => {
            const active = theme.id === store.activeId;
            return (
              <li
                key={theme.id}
                className="flex items-center gap-2 rounded-lg px-3 py-2"
                style={{
                  background: active ? 'var(--shell-selected)' : 'var(--shell-paper)',
                  border: '1px solid var(--shell-hairline)',
                }}
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => store.setActive(theme.id)}
                  data-testid={`theme-${theme.id}`}
                  className="shell-focusable flex-1 rounded-md text-left text-sm"
                  style={{ color: 'var(--shell-ink)' }}
                >
                  {theme.name}
                  {active && (
                    <span className="ml-2 text-xs" style={{ color: 'var(--shell-muted)' }}>
                      使用中
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    store.setActive(theme.id);
                    setTunerOpen(true);
                  }}
                  className="shell-focusable rounded-md px-2 py-1 text-xs"
                  style={{ color: 'var(--shell-body)' }}
                  aria-label={`编辑 ${theme.name}`}
                >
                  编辑
                </button>
                {!theme.builtIn && (
                  <button
                    type="button"
                    onClick={() => store.deleteCustom(theme.id)}
                    className="shell-focusable rounded-md px-2 py-1 text-xs"
                    style={{ color: 'var(--shell-body)' }}
                    aria-label={`删除 ${theme.name}`}
                  >
                    删除
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        {customCount < MAX_CUSTOM && (
          <button
            type="button"
            onClick={() => {
              const id = store.createCustom(`自定义 ${customCount + 1}`, store.activeId);
              if (id) setTunerOpen(true);
            }}
            className="shell-focusable mt-2 rounded-lg px-3 py-2 text-sm"
            style={{ border: '1px solid var(--shell-hairline-strong)', color: 'var(--shell-ink)' }}
          >
            新建主题
          </button>
        )}
      </section>

      {tunerOpen && (
        <Suspense>
          <OklchTuner onClose={() => setTunerOpen(false)} />
        </Suspense>
      )}
    </div>
  );
}
