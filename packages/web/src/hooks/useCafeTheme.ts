'use client';

import { useTheme } from 'next-themes';

export function useCafeTheme() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  return {
    theme: (theme ?? 'light') as 'light' | 'dark' | 'system',
    resolvedTheme: (resolvedTheme ?? 'light') as 'light' | 'dark',
    setTheme,
    toggleTheme: () => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark'),
  };
}
