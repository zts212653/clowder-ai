import { createRoot } from 'react-dom/client';
import { CollectiveLaunchSurface } from '../../../src/components/collective/CollectiveLaunchSurface';
import { useCollectiveWorldDirectoryRecovery } from '../../../src/components/collective/use-collective-world-directory-recovery';
import { CollectiveWorldRailEntries } from '../../../src/components/shell/CollectiveWorldRailEntries';
import { writeShellLanguage } from '../../../src/components/shell/shell-language';
import { ThemeProvider } from '../../../src/components/ThemeProvider';
import { useCafeTheme } from '../../../src/hooks/useCafeTheme';
import '../../../src/app/theme-tokens.css';
import '../../../src/app/cat-persona-derived.css';
import '../../../src/app/cat-persona-tokens.css';
import '../../../src/app/console-tokens.css';
import '../../../src/app/globals.css';
import '../../../src/app/shell-v2.css';

// Actual product launch component; only its Host API responses are explicit fixture state.
const configElement = document.getElementById('fixture-config');
const rootElement = document.getElementById('root');
if (!configElement?.textContent || !rootElement) throw new Error('F290 Host fixture shell is incomplete');
const config = JSON.parse(configElement.textContent) as {
  serviceUrl: string;
  appearanceControls?: boolean;
  worldRail?: boolean;
};
function AppearanceControls() {
  const { setTheme } = useCafeTheme();
  return (
    <nav className="fixture-controls" aria-label="Declared test controls">
      <button type="button" onClick={() => setTheme('light')}>
        Light
      </button>
      <button type="button" onClick={() => setTheme('dark')}>
        Dark
      </button>
      <button type="button" onClick={() => writeShellLanguage('zh')}>
        中文
      </button>
      <button type="button" onClick={() => writeShellLanguage('en')}>
        English
      </button>
    </nav>
  );
}
function WorldRail() {
  useCollectiveWorldDirectoryRecovery();
  const open = (href: string) => {
    window.history.pushState(window.history.state, '', href);
    window.dispatchEvent(new PopStateEvent('popstate'));
  };
  return (
    <nav className="fixture-world-rail" aria-label="Fixture world rail">
      <CollectiveWorldRailEntries
        inCollective={location.pathname === '/collective'}
        onOpenWorld={open}
        onOpenDirectory={() => open('/collective')}
      />
    </nav>
  );
}
createRoot(rootElement).render(
  <ThemeProvider>
    {config.appearanceControls && <AppearanceControls />}
    <div className={config.worldRail ? 'f290-host-shell' : 'f290-host-room'}>
      {config.worldRail && <WorldRail />}
      <div className="f290-host-room">
        <CollectiveLaunchSurface initialServiceUrl={config.serviceUrl} />
      </div>
    </div>
  </ThemeProvider>,
);
