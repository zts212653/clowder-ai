/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}', '../shared/src/**/*.{js,ts}'],
  theme: {
    extend: {
      colors: {
        opus: {
          primary: 'var(--color-opus-primary)',
          light: 'var(--color-opus-light)',
          dark: 'var(--color-opus-dark)',
          bg: 'var(--color-opus-bg)',
        },
        codex: {
          primary: 'var(--color-codex-primary)',
          light: 'var(--color-codex-light)',
          dark: 'var(--color-codex-dark)',
          bg: 'var(--color-codex-bg)',
        },
        gemini: {
          primary: 'var(--color-gemini-primary)',
          light: 'var(--color-gemini-light)',
          dark: 'var(--color-gemini-dark)',
          bg: 'var(--color-gemini-bg)',
        },
        dare: {
          primary: 'var(--color-dare-primary)',
          light: 'var(--color-dare-light)',
          dark: 'var(--color-dare-dark)',
          bg: 'var(--color-dare-bg)',
        },
        cocreator: {
          primary: 'var(--color-cocreator-primary)',
          light: 'var(--color-cocreator-light)',
          dark: 'var(--color-cocreator-dark)',
          bg: 'var(--color-cocreator-bg)',
        },
        cafe: {
          white: 'var(--color-base-white)',
          black: 'var(--color-base-black)',
          surface: 'var(--cafe-surface)',
          'surface-elevated': 'var(--cafe-surface-elevated)',
          'surface-sunken': 'var(--cafe-surface-sunken)',
          accent: 'var(--cafe-accent)',
          'accent-hover': 'var(--cafe-accent-hover)',
          crosspost: 'var(--cafe-crosspost)',
          interactive: 'var(--cafe-interactive)',
        },
        /* F101 AC-D5: Werewolf Cute theme tokens */
        ww: {
          base: 'var(--ww-bg-base)',
          card: 'var(--ww-bg-card)',
          surface: 'var(--ww-bg-surface)',
          topbar: 'var(--ww-bg-topbar)',
          danger: 'var(--ww-accent-danger)',
          cute: 'var(--ww-accent-cute)',
          success: 'var(--ww-accent-success)',
          info: 'var(--ww-accent-info)',
          wolf: 'var(--ww-role-wolf)',
          seer: 'var(--ww-role-seer)',
          witch: 'var(--ww-role-witch)',
          guard: 'var(--ww-role-guard)',
          'danger-soft': 'var(--ww-danger-soft)',
          'info-soft': 'var(--ww-info-soft)',
          'subtle-soft': 'var(--ww-subtle-soft)',
          'cute-soft': 'var(--ww-cute-soft)',
          'base-overlay': 'var(--ww-base-overlay)',
        },
      },
      textColor: {
        cafe: {
          DEFAULT: 'var(--cafe-text)',
          secondary: 'var(--cafe-text-secondary)',
          muted: 'var(--cafe-text-muted)',
        },
        ww: {
          main: 'var(--ww-text-main)',
          muted: 'var(--ww-text-muted)',
          dim: 'var(--ww-text-dim)',
        },
      },
      borderColor: {
        cafe: {
          DEFAULT: 'var(--cafe-border)',
          subtle: 'var(--cafe-border-subtle)',
        },
        ww: {
          subtle: 'var(--ww-border-subtle)',
          active: 'var(--ww-border-active)',
          'info-soft': 'var(--ww-info-soft)',
          'subtle-soft': 'var(--ww-subtle-soft)',
        },
      },
      boxShadowColor: {
        ww: {
          glow: 'var(--ww-shadow-glow)',
        },
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'cat-bounce': {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-3px)' },
        },
        'cat-shake': {
          '0%, 100%': { transform: 'translateX(0)' },
          '20%': { transform: 'translateX(-2px)' },
          '40%': { transform: 'translateX(2px)' },
          '60%': { transform: 'translateX(-1px)' },
          '80%': { transform: 'translateX(1px)' },
        },
        'toast-in': {
          '0%': { opacity: '0', transform: 'translateX(20px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        'toast-out': {
          '0%': { opacity: '1', transform: 'translateX(0)' },
          '100%': { opacity: '0', transform: 'translateX(20px)' },
        },
        'token-pulse': {
          '0%': { transform: 'scale(1)', opacity: '1' },
          '50%': { transform: 'scale(1.05)', opacity: '0.8' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
        'cost-glow': {
          '0%': { opacity: '0', filter: 'brightness(1)' },
          '50%': { opacity: '1', filter: 'brightness(1.3)' },
          '100%': { opacity: '1', filter: 'brightness(1)' },
        },
        'slide-in-right': {
          '0%': { opacity: '0', transform: 'translateX(12px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        'tree-expand': {
          '0%': { opacity: '0', height: '0' },
          '100%': { opacity: '1', height: 'var(--radix-collapsible-content-height, auto)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.3s ease-out',
        'cat-bounce': 'cat-bounce 0.8s ease-in-out infinite',
        'cat-shake': 'cat-shake 0.4s ease-in-out',
        'toast-in': 'toast-in 0.3s ease-out',
        'toast-out': 'toast-out 0.3s ease-in forwards',
        'token-pulse': 'token-pulse 0.3s ease-out',
        'cost-glow': 'cost-glow 0.4s ease-out',
        'slide-in-right': 'slide-in-right 0.2s ease-out',
        'tree-expand': 'tree-expand 0.15s ease-out',
        shimmer: 'shimmer 1.5s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
