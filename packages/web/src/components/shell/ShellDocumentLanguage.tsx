'use client';

import { useEffect } from 'react';
import { useShellLanguage } from './shell-language';

/**
 * F322 AC-B6–B8 — the document says which language the new shell is in.
 *
 * `app/layout.tsx` declares `<html lang="zh-CN">` for every page, so with an English v2 shell a screen reader would announce
 * English words as Chinese. This is the second thing the shell projects onto <html> (the first is `data-shell="v2"`, in
 * `AppShell`): it follows the one language preference — a write in this tab and a storage change from another tab both arrive
 * through `useShellLanguage` — and every run of the effect gives back what it found, so ending v2 (or unmounting the shell)
 * leaves the layout's value in place.
 *
 * It is mounted only while the shell is v2. Classic never reads the language, so classic keeps the layout's `zh-CN` and never
 * subscribes here. Export and chromeless routes do not mount it either: they render no shell words.
 */
export function ShellDocumentLanguage(): null {
  const language = useShellLanguage();
  useEffect(() => {
    const root = document.documentElement;
    const found = root.lang;
    root.lang = language === 'en' ? 'en' : 'zh-CN';
    return () => {
      root.lang = found;
    };
  }, [language]);
  return null;
}
