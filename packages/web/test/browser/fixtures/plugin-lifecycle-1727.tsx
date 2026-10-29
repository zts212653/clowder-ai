import { createRoot } from 'react-dom/client';
import { PluginManagerLiveContent } from '@/components/settings/plugin-manager/PluginManagerLiveContent';
import { ConfirmProvider } from '@/components/useConfirm';
import '@/app/theme-tokens.css';
import '@/app/console-tokens.css';
import '@/app/console-controls.css';
import '@/app/connector-tokens.css';
import '@/app/globals.css';

createRoot(document.getElementById('root')!).render(
  <ConfirmProvider>
    <main className="flex h-screen flex-col gap-3 p-4">
      <p className="text-sm text-cafe-muted">#1727 隔离验收 · 使用真实插件管理接口与临时数据，不连接运行实例</p>
      <div className="min-h-0 flex-1">
        <PluginManagerLiveContent presentation="v2" />
      </div>
    </main>
  </ConfirmProvider>,
);
