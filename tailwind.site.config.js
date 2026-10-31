/** @type {import('tailwindcss').Config} */
const path = require('path');
// When copied to a temp dir for isolated builds, resolve content relative
// to the original repo root (passed via SITE_ROOT env or inferred from CWD)
const root = process.env.SITE_ROOT || process.cwd();
module.exports = {
  content: [path.join(root, 'site/**/*.{html,js}')],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        terracotta: { DEFAULT: '#C06B4E', light: '#D4896F' },
        cream: '#FAF6F1',
        'warm-gray': '#F5F0EB',
        'space-gray': '#0F172A',
        opus: '#60A5FA',
        codex: '#34D399',
        gemini: '#FBBF24',
        bengal: '#FB923C',
      },
      fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] },
    },
  },
  plugins: [require('@tailwindcss/typography')],
};
