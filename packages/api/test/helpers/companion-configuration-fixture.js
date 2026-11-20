import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMPANION_PLUGIN_ID, readCompanionSettings } from '../../dist/domains/concierge/companion-settings.js';
import { validateValue } from '../../dist/domains/plugin/manager/plugin-configuration-write.js';
import { HostPluginConfigurationService } from '../../dist/domains/plugin/manager/plugin-manager-configuration.js';
import { writePluginConfig } from '../../dist/domains/plugin/plugin-config-store.js';

/** official.companion's declared configuration (plugin.yaml), as the installed package carries it. */
export const COMPANION_CONFIGURATION = [
  { key: 'dutyCatProfileId', label: '回复的成员', kind: 'member', required: false },
  { key: 'displayName', label: '名称', kind: 'string', required: false, default: '猫猫球' },
  { key: 'personaTone', label: '人设基调', kind: 'string', required: false, default: '温暖、简短、不啰嗦' },
  {
    key: 'proactivePolicy',
    label: '主动性策略',
    kind: 'select',
    required: false,
    default: 'quiet-badge',
    options: [
      { value: 'ambient', label: '仅环境感知' },
      { value: 'quiet-badge', label: '安静徽章' },
    ],
  },
  { key: 'behaviorEnabled', label: '猫猫自主活动', kind: 'boolean', required: false, default: true },
  {
    key: 'skin',
    label: '皮肤',
    kind: 'select',
    required: false,
    default: 'xianxian-codex',
    options: ['xianxian-codex', 'yanyan-codex', 'ragdoll-v1', 'yarn-ball'].map((value) => ({ value, label: value })),
  },
  { key: 'ballSize', label: '大小', kind: 'number', required: false, default: 72 },
];

/** The companion settings the manifest defaults produce, for fixtures that serve the Host's settings view. */
export const COMPANION_DEFAULTS = Object.fromEntries(
  COMPANION_CONFIGURATION.filter((field) => field.default !== undefined).map((field) => [field.key, field.default]),
);

/** The real Host configuration service over an installed official.companion with its declared fields. */
export function companionConfigurationFixture(initial = {}) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'companion-configuration-'));
  const record = { packageDigest: 'digest', manifest: { configuration: COMPANION_CONFIGURATION } };
  const configuration = new HostPluginConfigurationService({
    projectRoot,
    threads: { get: async () => null },
    inventory: {
      readCurrentAuthority: async (pluginId) =>
        pluginId === COMPANION_PLUGIN_ID
          ? {
              instance: {
                pluginId,
                pluginInstanceId: 'companion-instance',
                lifecycleState: 'installed',
                packageDigest: 'digest',
              },
              packageRecord: record,
            }
          : undefined,
    },
  });
  const set = (values) =>
    writePluginConfig(
      projectRoot,
      COMPANION_PLUGIN_ID,
      Object.entries(values).map(([name, value]) => ({ name, value: value == null ? null : String(value) })),
    );
  set(initial);
  return {
    projectRoot,
    configuration,
    set,
    read: () => readCompanionSettings(configuration),
    /** The plugin manager detail and configuration save the config page uses, validated per declared field. */
    register(app) {
      const path = `/api/plugin-manager/plugins/${COMPANION_PLUGIN_ID}`;
      app.get(path, async () => ({
        plugin: { lifecycleRevision: 1, configFields: COMPANION_CONFIGURATION.map(({ key }) => ({ key })) },
      }));
      app.post(`${path}/contributions/configuration`, async (request, reply) => {
        const { updates } = request.body;
        try {
          for (const update of updates)
            validateValue(
              COMPANION_CONFIGURATION.find((field) => field.key === update.key),
              update.value,
            );
        } catch (error) {
          return reply.code(400).send({ error: error.message, code: 'INVALID_CONFIGURATION' });
        }
        writePluginConfig(
          projectRoot,
          COMPANION_PLUGIN_ID,
          updates.map(({ key, value }) => ({ name: key, value })),
        );
        return { pluginId: COMPANION_PLUGIN_ID, pluginInstanceId: 'companion-instance' };
      });
    },
  };
}
