'use client';

import { useState } from 'react';
import { useOptionalConfirm } from '@/components/useConfirm';
import { apiFetch } from '@/utils/api-client';
import type { PluginManagerDesignFixture } from './plugin-manager-fixtures';
import { responseError } from './plugin-manager-live-api';

export function PluginSkillConflicts({
  plugin,
  locale,
  onResolved,
}: {
  plugin: PluginManagerDesignFixture;
  locale: string;
  onResolved?: (() => void) | undefined;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const confirm = useOptionalConfirm();
  const en = locale.startsWith('en');
  const conflicts = plugin.skillConflicts ?? [];
  if (!conflicts.length && !notice) return null;
  return (
    <section data-plugin-skill-conflicts className="space-y-3 rounded-lg border border-cafe-border p-3 text-sm">
      {conflicts.length > 0 && (
        <>
          <h4 className="font-medium text-cafe">{en ? 'Skill conflicts' : '技能冲突'}</h4>
          <p className="text-cafe-secondary">
            {en
              ? 'These skill mounts are unavailable. Other plugin capabilities can continue running. Existing content stays in place until you choose a source.'
              : '以下位置的技能暂未挂载，插件其他能力可继续运行。未选择前保留现有内容。'}
          </p>
        </>
      )}
      {conflicts.map((conflict) => (
        <div
          key={`${conflict.skillName}:${conflict.mountPointId}`}
          className="space-y-2 border-t border-cafe-border pt-2"
        >
          <p className="font-medium text-cafe">
            {conflict.skillName} ·{' '}
            {conflict.mountPointId === 'registration' ? (en ? 'Skill source' : '技能来源') : conflict.mountPointId}
          </p>
          <p className="break-all text-cafe-muted">
            {en ? 'Existing source' : '现有来源'}：
            {conflict.sourcePluginId ??
              (en
                ? conflict.source
                : conflict.source === 'Local file or directory'
                  ? '本地文件或目录'
                  : conflict.source === 'Built-in skill'
                    ? '应用内置技能'
                    : conflict.source.replace('Existing link: ', '现有软链接：'))}
          </p>
          <p className="break-all text-cafe-muted">{conflict.path}</p>
          {conflict.canResolve && (
            <button
              type="button"
              className="console-button-secondary !font-medium disabled:opacity-50"
              disabled={busy || !confirm || plugin.intent !== 'enabled' || plugin.lifecycleRevision == null}
              onClick={async () => {
                const confirmation = en
                  ? `Use the ${conflict.skillName} skill from ${plugin.displayName}? The previous source files will be preserved; a conflicting local mount will be moved to a backup. The previous source will no longer supply this skill here.`
                  : `使用 ${plugin.displayName} 提供的 ${conflict.skillName} 技能？原来源文件会保留；冲突的本地挂载会先移到备份。本项目将改用插件提供的这项技能。`;
                if (!confirm) return;
                setBusy(true);
                setError('');
                try {
                  if (
                    !(await confirm({
                      title: en ? 'Choose skill source' : '选择技能来源',
                      message: confirmation,
                      confirmLabel: en ? 'Use plugin skill' : '使用插件技能',
                    }))
                  )
                    return;
                  const response = await apiFetch(
                    `/api/plugin-manager/plugins/${encodeURIComponent(plugin.id)}/skills/resolve`,
                    {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        skillName: conflict.skillName,
                        mountPointId: conflict.mountPointId,
                        revision: conflict.revision,
                        expectedRevision: plugin.lifecycleRevision,
                        confirmed: true,
                      }),
                    },
                  );
                  if (!response.ok)
                    throw new Error(
                      (
                        await responseError(
                          response,
                          en ? 'Could not resolve the skill conflict.' : '未能处理技能冲突，请刷新后重试。',
                        )
                      ).message,
                    );
                  const result = (await response.json()) as { backupPath: string };
                  setNotice(
                    conflict.mountPointId === 'registration'
                      ? en
                        ? 'Skill source changed. Original source files were left untouched.'
                        : '技能来源已切换，原来源文件未改动。'
                      : `${en ? 'Previous content preserved at' : '原内容已保留于'}：${result.backupPath}`,
                  );
                  onResolved?.();
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : String(cause));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? (en ? 'Applying…' : '处理中…') : en ? 'Use this plugin’s skill…' : '使用此插件技能…'}
            </button>
          )}
        </div>
      ))}
      {error && (
        <p role="alert" className="text-cafe-secondary">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="break-all text-cafe-secondary">
          {notice}
        </p>
      )}
      {conflicts.length > 0 && (
        <a className="text-cafe-interactive" href="/settings?s=skills">
          {en ? 'Manage skills' : '打开技能管理'}
        </a>
      )}
    </section>
  );
}
