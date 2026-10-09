import { createRoot } from 'react-dom/client';
import { PluginManagerContent } from '@/components/settings/plugin-manager/PluginManagerContent';
import { PLUGIN_MANAGER_DESIGN_FIXTURES } from '@/components/settings/plugin-manager/plugin-manager-fixtures';
import '@/app/theme-tokens.css';
import '@/app/console-tokens.css';
import '@/app/console-controls.css';
import '@/app/connector-tokens.css';
import '@/app/globals.css';

const ready = {
  ...PLUGIN_MANAGER_DESIGN_FIXTURES[0],
  steps: ['Log in with the GitHub CLI (`gh auth login`) on the machine running Clowder AI'],
  contributions: [
    { id: 'cicd-check', kind: 'schedule' as const, name: 'cicd-check' },
    { id: 'review-feedback', kind: 'events' as const, name: 'review-feedback' },
  ],
  configFields: [
    {
      kind: 'secret' as const,
      key: 'GITHUB_TOKEN',
      label: 'Personal Access Token',
      required: false,
      sensitive: true,
      currentValue: '••••••',
    },
    {
      kind: 'string' as const,
      key: 'GITHUB_SETUP_NOISE_BOT_LOGINS',
      label: 'Noise Bot Login List',
      required: false,
      sensitive: false,
      currentValue: 'one[bot],two[bot]',
    },
    {
      kind: 'list' as const,
      key: 'demoNames',
      label: '演示字符串数组',
      required: false,
      sensitive: false,
      currentValue: '["一项","另一项"]',
    },
  ],
};
const fixtures = [
  ready,
  {
    ...ready,
    id: 'failed',
    displayName: '连接失败的插件',
    intent: 'disabled' as const,
    live: 'stopped' as const,
    activationFailed: true,
    diagnostic: '连接被拒绝，请检查插件连接配置。',
    configFields: [
      { key: 'account', kind: 'string' as const, label: '账号', currentValue: null, required: false, sensitive: false },
      {
        key: 'connection',
        kind: 'operation' as const,
        label: '检查连接',
        currentValue: null,
        required: false,
        sensitive: false,
        actions: [{ id: 'check', label: '检查连接', render: 'button' as const }],
      },
    ],
  },
  { ...PLUGIN_MANAGER_DESIGN_FIXTURES[2], icon: 'blocks' as const },
];

const root = document.getElementById('root');
if (!root) throw new Error('Missing fixture root');
createRoot(root).render(
  <main className="h-screen p-4">
    <PluginManagerContent
      presentation="v2"
      fixtures={fixtures}
      onOperationChange={(id) => document.documentElement.setAttribute('data-operation-refreshed', id)}
      onUninstall={(id) => document.documentElement.setAttribute('data-uninstalled', id)}
      onConfigure={(id, updates) =>
        document.documentElement.setAttribute('data-saved-config', JSON.stringify({ id, updates }))
      }
    />
  </main>,
);
