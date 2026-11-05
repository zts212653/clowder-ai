import { HubIcon } from '../../hub-icons';
import { SettingsText } from '../primitives/SettingsText';

export function PluginManagerNotices({
  catalogStatus,
  catalogMessage,
  error,
  warning,
}: {
  catalogStatus: 'loading' | 'fresh' | 'stale' | 'degraded' | 'unavailable';
  catalogMessage?: string;
  error?: string | null;
  warning?: string | null;
}) {
  return (
    <>
      {catalogStatus !== 'fresh' && catalogStatus !== 'loading' && (
        <div className="flex items-start gap-2 rounded-xl bg-conn-amber-bg px-3 py-2.5">
          <HubIcon name="alert-triangle" className="mt-0.5 h-4 w-4 shrink-0 text-conn-amber-text" />
          <SettingsText as="p" variant="sm" tone="amber">
            {catalogMessage ?? '目录暂时不可用；已安装插件仍可管理，未安装列表会在连接恢复后刷新。'}
          </SettingsText>
        </div>
      )}
      {error && (
        <div role="alert" className="rounded-xl bg-conn-red-bg px-3 py-2.5 text-sm text-conn-red-text">
          {error}
        </div>
      )}
      {warning && (
        <p role="status" className="rounded-xl bg-conn-amber-bg px-3 py-2.5 text-sm text-conn-amber-text">
          {warning}
        </p>
      )}
    </>
  );
}
