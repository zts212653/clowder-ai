'use client';

import { useEffect, useRef, useState } from 'react';
import { useThemeStore } from '@/stores/themeStore';

export function PaletteIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
      <title>主题</title>
      <path
        d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.65-.75 1.65-1.69 0-.44-.18-.84-.44-1.12-.29-.29-.44-.66-.44-1.13 0-.92.75-1.67 1.67-1.67H17c3.04 0 5.5-2.5 5.5-5.56C22.5 6.01 17.96 2 12 2z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="10" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="7" r="1" fill="currentColor" stroke="none" />
      <circle cx="16" cy="10" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function EditIcon({ className = 'w-3.5 h-3.5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className}>
      <title>编辑</title>
      <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface Props {
  onEditTheme: () => void;
}

const BTN = 'flex h-10 w-10 items-center justify-center rounded-lg transition-all';
const ACTIVE = 'bg-[var(--console-rail-active)] shadow-[var(--shadow-elevation-2)]';
const HOVER = 'hover:bg-[var(--console-rail-item)] hover:shadow-[var(--shadow-elevation-2)]';

export function ThemeMenu({ onEditTheme }: Props) {
  const store = useThemeStore();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const customCount = store.themes.filter((t) => !t.builtIn).length;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`${BTN} ${open ? ACTIVE : HOVER}`}
        title="主题"
      >
        <PaletteIcon />
      </button>
      {open && (
        <div className="absolute left-12 bottom-0 w-48 rounded-lg bg-cafe-surface-sunken border border-[var(--console-border-soft)] shadow-xl p-1.5 z-50 text-xs space-y-1">
          {store.themes.map((t) => {
            const m = t.base;
            const p = t.params;
            const bgL = m === 'light' ? 0.88 : 0.28;
            const bg = `oklch(${bgL} ${p.accentChroma * 0.35} ${p.accentHue})`;
            const fg = `oklch(${m === 'light' ? 0.2 : 0.92} 0.01 ${p.accentHue})`;
            const accent = `oklch(0.65 ${p.accentChroma} ${p.accentHue})`;
            return (
              <div
                key={t.id}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md"
                style={{ background: bg, color: fg }}
              >
                <button
                  type="button"
                  className="flex-1 flex items-center gap-1.5 text-left hover:opacity-80"
                  onClick={() => {
                    store.setActive(t.id);
                    setOpen(false);
                  }}
                >
                  <span>{t.name}</span>
                  {t.id === store.activeId && (
                    <svg
                      className="w-3.5 h-3.5 ml-auto"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke={accent}
                      strokeWidth="2"
                    >
                      <path d="M3 8l4 4 6-7" />
                    </svg>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    store.setActive(t.id);
                    onEditTheme();
                    setOpen(false);
                  }}
                  className="p-1 rounded opacity-50 hover:opacity-100"
                  title={`编辑 ${t.name}`}
                >
                  <EditIcon />
                </button>
                {!t.builtIn && (
                  <button
                    type="button"
                    onClick={() => store.deleteCustom(t.id)}
                    className="p-1 rounded opacity-50 hover:opacity-100 text-micro"
                    title={`删除 ${t.name}`}
                  >
                    <svg className="w-3 h-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M4 4l8 8M12 4l-8 8" />
                    </svg>
                  </button>
                )}
              </div>
            );
          })}
          {customCount < 2 && (
            <div className="border-t border-[var(--console-border-soft)] pt-1">
              <button
                type="button"
                onClick={() => {
                  const id = store.createCustom(`自定义 ${customCount + 1}`, store.activeId);
                  if (id) {
                    onEditTheme();
                    setOpen(false);
                  }
                }}
                className="w-full text-left px-2.5 py-1.5 text-cafe-muted hover:text-cafe rounded-md hover:bg-[var(--console-hover-bg)]"
              >
                + 新建主题
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
