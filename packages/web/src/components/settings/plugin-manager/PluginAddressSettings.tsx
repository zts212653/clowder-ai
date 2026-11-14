'use client';

import { useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { uploadAvatarAsset } from '../../hub-cat-editor.client';
import { PluginTargetIcon } from '../../PluginTargetIcon';
import { SettingsSecondaryButton } from '../primitives/SettingsSecondaryButton';
import type { PluginManagerDesignFixture } from './plugin-manager-fixtures';

const errors: Record<string, string> = {
  alias_invalid: '只能用字母、数字、汉字、- 和 _，并以字母、数字或汉字开头',
  alias_reserved: '这个别名是已有群组或共创者的称呼，请换一个',
  alias_taken: '这个别名已被成员或插件使用，请换一个',
  stale_revision: '别名刚在别处修改。你的修改还在，请重新打开详情核对后再保存',
  not_addressable: '这个插件当前无法修改对话别名',
  icon_invalid: '请上传 PNG、JPG 或 WebP 图片',
};
const normalize = (value: string) => value.normalize('NFKC').trim().replace(/^@/, '').toLowerCase();

export function PluginAddressSettings({
  plugin,
  onSaved,
}: {
  plugin: PluginManagerDesignFixture;
  onSaved?: () => void | Promise<void>;
}) {
  const [saved, setSaved] = useState(plugin.address!);
  const [alias, setAlias] = useState(saved.alias);
  const [icon, setIcon] = useState<string | null>(saved.icon ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const dirty = normalize(alias) !== saved.alias || icon !== (saved.icon ?? null);
  const save = async () => {
    if (!normalize(alias)) {
      setError('别名不能为空');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await apiFetch(
        `/api/plugin-manager/instances/${encodeURIComponent(plugin.pluginInstanceId!)}/address`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ alias: normalize(alias), icon, expectedRevision: saved.revision }),
        },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(
          response.status === 403
            ? '你没有修改插件设置的权限'
            : (errors[body.code] ?? '插件服务暂时无法保存，请稍后重试'),
        );
      }
      const next = { alias: normalize(alias), revision: saved.revision + 1, ...(icon ? { icon } : {}) };
      setSaved(next);
      setAlias(next.alias);
      setNotice(`已保存 · 现在就能用 @${next.alias}，插件不用重启`);
      window.dispatchEvent(new Event('plugin-targets-changed'));
      await onSaved?.();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-3" data-plugin-detail-section="address">
      <h4 className="text-xs font-semibold text-cafe-muted">在对话中</h4>
      <label className="block space-y-1 text-sm text-cafe-secondary">
        <span>别名</span>
        <span
          className={`flex h-8 items-center gap-1 rounded-lg border bg-cafe-surface-canvas px-2 ${error ? 'border-conn-red-text' : 'border-cafe'}`}
        >
          <span aria-hidden="true">@</span>
          <input
            aria-label="插件别名"
            value={alias}
            maxLength={64}
            disabled={busy}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
            onChange={(event) => {
              setAlias(event.target.value);
              setError('');
              setNotice('');
            }}
            onBlur={() => setAlias(normalize(alias))}
          />
        </span>
      </label>
      {normalize(alias) !== saved.alias && (
        <p className="text-xs text-cafe-muted">
          保存后用 @{normalize(alias)} 找它，@{saved.alias} 不再指向它；已发出和排队中的消息照旧送到它。
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <PluginTargetIcon icon={icon ? { type: 'png', src: icon } : plugin.icon} size={32} />
        <label className="cursor-pointer text-xs text-cafe-secondary underline">
          上传图片
          <input
            className="sr-only"
            type="file"
            aria-label="上传插件图标"
            accept="image/png,image/jpeg,image/webp"
            disabled={busy}
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              setBusy(true);
              setError('');
              try {
                setIcon(await uploadAvatarAsset(file));
                setNotice('');
              } catch (failure) {
                setError(failure instanceof Error ? failure.message : '上传失败');
              } finally {
                setBusy(false);
              }
            }}
          />
        </label>
        {icon && (
          <button
            type="button"
            className="text-xs text-cafe-secondary underline"
            disabled={busy}
            onClick={() => setIcon(null)}
          >
            恢复插件图标
          </button>
        )}
      </div>
      {plugin.intent !== 'enabled' && (
        <p className="text-xs text-cafe-muted">插件已停用。@{saved.alias} 仍保留给它，启用后才能收到消息。</p>
      )}
      {error && (
        <p role="alert" className="text-xs text-cafe-secondary">
          没保存上：{error}。修改还在。
        </p>
      )}
      {notice && (
        <p role="status" className="text-xs text-cafe-muted">
          {notice}
        </p>
      )}
      {dirty && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-cafe-muted">{busy ? '正在保存…' : '有修改还没保存'}</span>
          <div className="flex gap-2">
            <SettingsSecondaryButton
              disabled={busy}
              onClick={() => {
                setAlias(saved.alias);
                setIcon(saved.icon ?? null);
                setError('');
              }}
            >
              放弃修改
            </SettingsSecondaryButton>
            <SettingsSecondaryButton disabled={busy} onClick={() => void save()}>
              {error ? '重新保存' : '保存'}
            </SettingsSecondaryButton>
          </div>
        </div>
      )}
    </section>
  );
}
