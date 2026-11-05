import { createRoot } from 'react-dom/client';
import { INIT_LIGHT } from '@/components/dev/oklch-tuner-engine';
import { SettingsShell } from '@/components/settings/SettingsShell';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { ConfirmProvider } from '@/components/useConfirm';
import { applyThemeCSS } from '@/stores/themeStore';
import '@/app/globals.css';
import '@/app/theme-tokens.css';
import '@/app/console-tokens.css';
import '@/app/connector-tokens.css';
import '@/app/shell-v2.css';

const classic = new URL(location.href).searchParams.get('classic') === '1';
// Test-only commands call the real preference writer and selected-theme renderer.
Object.assign(window, {
  f322MemberFixture: {
    writeLanguage: writeShellLanguage,
    selectCustomTheme: () => {
      const theme = structuredClone(INIT_LIGHT);
      theme.surfaceHue = 245;
      theme.surfaceChroma = 2;
      theme.accentHue = 215;
      theme.neutralHue = 245;
      applyThemeCSS(theme);
    },
  },
});
writeShellPresentation(classic ? 'classic' : 'v2');
document.documentElement.dataset.shell = classic ? 'classic' : 'v2';
document.body.style.cssText = 'margin:0;height:100vh;background:var(--cafe-surface-elevated)';
const root = document.getElementById('root');
if (!root) throw Error('Missing fixture root');
root.style.height = '100vh';
createRoot(root).render(
  <ConfirmProvider>
    <SettingsShell />
  </ConfirmProvider>,
);
