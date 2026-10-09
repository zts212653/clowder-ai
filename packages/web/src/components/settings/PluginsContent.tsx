'use client';

import { useEffect, useState } from 'react';
import { useShellPresentation } from '../shell/shell-presentation';
import { PluginManagerContent } from './plugin-manager/PluginManagerContent';
import { PluginManagerLiveContent } from './plugin-manager/PluginManagerLiveContent';
import { resolvePluginManagerDesignGate } from './plugin-manager/plugin-manager-design-gate';
import { PLUGIN_MANAGER_DESIGN_FIXTURES } from './plugin-manager/plugin-manager-fixtures';
import { SettingsText } from './primitives/SettingsText';

export { resolvePluginManagerDesignGate } from './plugin-manager/plugin-manager-design-gate';

export function PluginsContent() {
  const presentation = useShellPresentation() === 'v2' ? 'v2' : 'v1';
  const [designGate, setDesignGate] = useState({
    resolved: false,
    enabled: false,
    live: false,
    degradedCatalog: false,
  });
  useEffect(() => {
    setDesignGate(resolvePluginManagerDesignGate(window.location.search));
  }, []);

  if (!designGate.resolved) {
    return (
      <SettingsText as="p" variant="sm" tone="muted">
        加载插件中...
      </SettingsText>
    );
  }
  if (designGate.enabled) {
    return (
      <PluginManagerContent
        presentation={presentation}
        fixtures={PLUGIN_MANAGER_DESIGN_FIXTURES}
        catalogStatus={designGate.degradedCatalog ? 'degraded' : 'fresh'}
      />
    );
  }
  return <PluginManagerLiveContent presentation={presentation} />;
}
