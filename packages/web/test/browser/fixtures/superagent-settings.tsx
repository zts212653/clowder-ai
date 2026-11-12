import { createRoot } from 'react-dom/client';
import { PluginManagerConfigurationSection } from '@/components/settings/plugin-manager/PluginManagerConfigurationSection';
import type { PluginManagerDesignFixture } from '@/components/settings/plugin-manager/plugin-manager-fixtures';
import { ThemeApplier } from '@/components/ThemeApplier';
import { ThemeProvider } from '@/components/ThemeProvider';
import { useThemeStore } from '@/stores/themeStore';
import '@/app/globals.css';
import '@/app/theme-tokens.css';
import '@/app/console-tokens.css';
import '@/app/cat-persona-tokens.css';
import '@/app/connector-tokens.css';
import '@/app/theme-extras.css';
import '@/app/console-controls.css';
import '@/app/shell-v2.css';

declare global {
  interface Window {
    __superagentSettingsPlugin: PluginManagerDesignFixture;
    __superagentTheme: (base: 'light' | 'dark') => void;
  }
}

window.__superagentTheme = (base) => useThemeStore.getState().setActive(base);
createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <ThemeApplier />
    <main className="cafe-presentation min-h-screen bg-cafe-surface p-6 text-cafe">
      <div className="mx-auto max-w-3xl">
        <PluginManagerConfigurationSection
          plugin={window.__superagentSettingsPlugin}
          busy={false}
          saved={false}
          validationRequest={0}
          presentation="v2"
        />
      </div>
    </main>
  </ThemeProvider>,
);
