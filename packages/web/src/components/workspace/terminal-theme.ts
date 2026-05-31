/**
 * Shared xterm.js terminal theme — single source of truth.
 *
 * xterm.js canvas renderer requires resolved hex color values;
 * CSS variables cannot be used here. Tokyo Night palette.
 */
export const TERMINAL_THEME = {
  background: '#1a1b26',
  foreground: '#a9b1d6',
  cursor: '#c0caf5',
} as const;
