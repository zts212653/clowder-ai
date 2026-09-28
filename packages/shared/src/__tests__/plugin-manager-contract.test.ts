import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  PLUGIN_MANAGER_PUBLIC_OPERATIONS,
  type PluginManagerConfigureRequest,
  type PluginManagerDetail,
  type PluginManagerInstallRequest,
  type PluginManagerListItem,
  type PluginManagerPackageSource,
  type PluginManagerSetEnabledRequest,
  type PluginManagerUninstallRequest,
  pluginDescriptionVariants,
  resolvePluginDescription,
} from '../types/plugin.js';

describe('F202 terminal Plugin Manager contract', () => {
  it('freezes the public management operations without update or repair', () => {
    expect(PLUGIN_MANAGER_PUBLIC_OPERATIONS).toEqual(['list', 'search', 'get', 'install', 'set-enabled', 'uninstall']);
    expect(PLUGIN_MANAGER_PUBLIC_OPERATIONS).not.toContain('update');
    expect(PLUGIN_MANAGER_PUBLIC_OPERATIONS).not.toContain('repair');
  });

  it('keeps package, config, auth, intent, and runtime as separate axes', () => {
    expectTypeOf<PluginManagerListItem['artifact']>().toEqualTypeOf<
      'absent' | 'staged' | 'verified' | 'installed' | 'quarantined'
    >();
    expectTypeOf<PluginManagerListItem['config']>().toEqualTypeOf<'incomplete' | 'ready' | 'invalid'>();
    expectTypeOf<PluginManagerListItem['auth']>().toEqualTypeOf<
      'not-required' | 'disconnected' | 'pending' | 'connected' | 'expired' | 'error'
    >();
    expectTypeOf<PluginManagerListItem['intent']>().toEqualTypeOf<'disabled' | 'enabled'>();
    expectTypeOf<PluginManagerListItem['live']>().toEqualTypeOf<
      'stopped' | 'starting' | 'handshaking' | 'running' | 'degraded' | 'crashed'
    >();
  });

  it('uses exact package/revision fences for every mutation', () => {
    expectTypeOf<PluginManagerInstallRequest>().toMatchTypeOf<
      | { source: { kind: 'catalog'; catalogId: string }; expectedVersion: string; expectedDigest: string }
      | { source: { kind: 'local-directory' | 'local-archive'; path: string } }
    >();
    expectTypeOf<PluginManagerSetEnabledRequest>().toEqualTypeOf<{
      enabled: boolean;
      expectedRevision: number;
    }>();
    expectTypeOf<PluginManagerUninstallRequest>().toEqualTypeOf<{
      expectedRevision: number;
    }>();
    expectTypeOf<PluginManagerConfigureRequest>().toEqualTypeOf<{
      expectedRevision: number;
      updates: Array<{ key: string; value: string | null }>;
    }>();
  });

  it('projects typed configuration contributions without leaking secret values', () => {
    expectTypeOf<PluginManagerDetail['configFields'][number]['key']>().toEqualTypeOf<string>();
    expectTypeOf<PluginManagerDetail['configFields'][number]['kind']>().toEqualTypeOf<
      'string' | 'secret' | 'select' | 'boolean' | 'number' | 'url' | 'list'
    >();
    expectTypeOf<PluginManagerDetail['configFields'][number]['currentValue']>().toEqualTypeOf<string | null>();
  });

  it('represents provenance-less legacy inventory without inventing trust', () => {
    expectTypeOf<Extract<PluginManagerPackageSource, { kind: 'legacy' }>>().toEqualTypeOf<{
      kind: 'legacy';
      packageName: string | null;
      trust: 'unknown';
    }>();
  });

  it('keeps compatibility trust coupled to its source adapter', () => {
    expectTypeOf<
      Extract<PluginManagerPackageSource, { kind: 'compatibility'; adapter: 'repository-local' }>
    >().toEqualTypeOf<{
      kind: 'compatibility';
      adapter: 'repository-local';
      packageName: string;
      trust: 'first-party';
    }>();
    expectTypeOf<Extract<PluginManagerPackageSource, { kind: 'compatibility'; adapter: 'connector' }>>().toEqualTypeOf<{
      kind: 'compatibility';
      adapter: 'connector';
      packageName: string;
      trust: 'local-trusted';
    }>();
  });

  it('lists capabilities on the detail without granting authority from labels', () => {
    expectTypeOf<PluginManagerDetail['capabilities'][number]['kind']>().toEqualTypeOf<
      | 'mcp'
      | 'skill'
      | 'limb'
      | 'schedule'
      | 'direct-tool'
      | 'webhook'
      | 'messaging'
      | 'events'
      | 'identity'
      | 'connector'
      | 'service'
      | 'ui'
      | 'content-editor-provider'
    >();
    expectTypeOf<PluginManagerDetail['capabilities'][number]['active']>().toEqualTypeOf<boolean>();
  });

  it('keeps one multilingual manifest description truth for Agent and Console consumers', () => {
    const description = {
      default: 'Track pull requests, CI, reviews, and repository health.',
      translations: {
        'zh-CN': '跟踪拉取请求、CI、代码审查和仓库健康状态。',
        ja: 'プルリクエスト、CI、レビュー、リポジトリの状態を追跡します。',
      },
    } as const;

    expect(resolvePluginDescription(description, 'zh-CN')).toBe('跟踪拉取请求、CI、代码审查和仓库健康状态。');
    expect(resolvePluginDescription(description, 'fr-FR')).toBe(description.default);
    expect(pluginDescriptionVariants(description)).toEqual([
      description.default,
      description.translations['zh-CN'],
      description.translations.ja,
    ]);
    expectTypeOf<PluginManagerDetail['description']>().toMatchTypeOf<
      | string
      | {
          default: string;
          translations: Readonly<Record<string, string>>;
        }
      | undefined
    >();
  });
});
