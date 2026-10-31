import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';
import { currentOwnerOperationRequest } from '../../carrier/plugin-owner-operation-context.js';
import { type ExternalPluginLifecycleService, PluginLifecycleError } from '../../external-plugin-lifecycle.js';
import type { VerifiedPluginPackageLocator } from '../../external-runtime/types.js';
import type { PluginInventoryStore } from '../../host-inventory/ports.js';
import type { PluginInstanceRecord } from '../../host-inventory/types.js';
import type { InstalledPluginOperationResult } from '../../operations/plugin-operation-routes.js';
import type { BuiltinPluginPackageMaterializer } from '../package-assets/builtin-package-materializer-types.js';
import { chromeSetupPolicy, isChromeSetupRequest } from './personal-chrome-setup-policy.js';
import { runChromeSetupProcess } from './personal-chrome-setup-process.js';

const actionSchema = z.enum(['inspect', 'install', 'uninstall']);
const success = z
  .object({
    protocolVersion: z.literal(1),
    ok: z.literal(true),
    action: actionSchema,
    installed: z.boolean(),
    extensionPath: z.string().nullable(),
    extensionId: z.string().regex(/^[a-p]{32}$/),
    browserAction: z.enum(['load-unpacked', 'none']),
    restartRequired: z.boolean(),
  })
  .strict();
const failure = z
  .object({
    protocolVersion: z.literal(1),
    ok: z.literal(false),
    action: actionSchema,
    code: z.enum([
      'INVALID_REQUEST',
      'UNSUPPORTED_PLATFORM',
      'INSTALLATION_BUSY',
      'PERMISSION_DENIED',
      'REGISTRATION_CONFLICT',
      'HELPER_ACTIVE',
      'INVALID_INSTALLATION',
      'DELIVERY_IO',
    ]),
  })
  .strict();
const protocol = z.union([success, failure]);
const response = (status: number, body: Record<string, unknown>): InstalledPluginOperationResult => ({
  matched: true,
  status,
  body,
});

export interface PersonalChromeSetupOptions {
  readonly inventory: Pick<PluginInventoryStore, 'snapshot'>;
  readonly packages: VerifiedPluginPackageLocator;
  readonly materializer?: BuiltinPluginPackageMaterializer;
  readonly lifecycle: Pick<ExternalPluginLifecycleService, 'runWithRuntimeSuspended'>;
  readonly projectRoot: string;
  /** Host startup coordinate, never supplied by a plugin or an HTTP request. */
  readonly home?: string;
  readonly run?: typeof runChromeSetupProcess;
}

/** Browser-owned setup only. This object is never passed to a plugin module or SDK. */
export class PersonalChromeSetup {
  constructor(private readonly options: PersonalChromeSetupOptions) {}

  async runAction(actionId: string, body: unknown): Promise<InstalledPluginOperationResult> {
    const request = currentOwnerOperationRequest();
    if (!request || !isChromeSetupRequest(request.pluginId, request.operationKey) || request.actionId !== actionId)
      return response(403, { error: 'Chrome setup requires a current local owner request' });
    const action = actionSchema.safeParse(actionId);
    if (!action.success || (body != null && !z.object({}).strict().safeParse(body).success))
      return response(400, { error: 'Chrome setup accepts only a fixed action and an empty body' });
    request.assertCurrent();
    request.signal.throwIfAborted();
    const snapshot = await this.options.inventory.snapshot();
    const initial = snapshot.instances.find((x) => x.pluginId === request.pluginId && x.lifecycleState === 'installed');
    const record = snapshot.packages.find((x) => x.packageDigest === initial?.packageDigest);
    const policy = record && chromeSetupPolicy(record);
    const declaration = policy?.actions.find((x) => x.id === actionId);
    if (!initial || !record || !policy || !declaration)
      return response(403, { error: 'Chrome setup requires the exact Host-trusted package and action' });
    if (declaration.confirm !== undefined && request.confirmed !== true)
      return response(400, { error: 'Confirm this Chrome setup change first' });
    const assertCurrent = async (expected: PluginInstanceRecord) => {
      request.assertCurrent();
      request.signal.throwIfAborted();
      const latest = await this.options.inventory.snapshot();
      const instance = latest.instances.find((x) => x.pluginInstanceId === initial.pluginInstanceId);
      const pkg = latest.packages.find((x) => x.packageDigest === instance?.packageDigest);
      if (
        !instance ||
        !pkg ||
        instance.lifecycleState !== 'installed' ||
        instance.lifecycleRevision !== expected.lifecycleRevision ||
        instance.runtimeState !== expected.runtimeState ||
        instance.activationState !== initial.activationState ||
        instance.packageDigest !== initial.packageDigest ||
        JSON.stringify(pkg.manifest) !== JSON.stringify(record.manifest) ||
        JSON.stringify(chromeSetupPolicy(pkg)) !== JSON.stringify(policy)
      )
        throw new Error('SETUP_SOURCE_CHANGED');
      request.assertCurrent();
      request.signal.throwIfAborted();
    };
    let started = false;
    let completedResult: InstalledPluginOperationResult | undefined;
    const perform = async (expected: PluginInstanceRecord) => {
      const current = () => assertCurrent(expected);
      await current();
      const verified = this.options.materializer
        ? await this.options.materializer.resolve({
            pluginInstanceId: initial.pluginInstanceId,
            pluginId: record.pluginId,
            packageDigest: initial.packageDigest,
            ...(record.provenance?.packageName ? { packageName: record.provenance.packageName } : {}),
            sourceKind: record.provenance?.kind ?? 'local-archive',
          })
        : await this.options.packages.resolveInstalledPackage(initial.packageDigest);
      try {
        await verified.verifyIntegrity();
        if (JSON.stringify(verified.manifest) !== JSON.stringify(record.manifest))
          throw new Error('SETUP_PACKAGE_MISMATCH');
        const projectRoot = await realpath(this.options.projectRoot);
        const home = await realpath(this.options.home ?? homedir());
        const manifest = JSON.parse(await readFile(resolve(verified.rootDir, 'extension/manifest.json'), 'utf8'));
        if (typeof manifest.key !== 'string' || manifest.key.length < 100) throw new Error('SETUP_EXTENSION_INVALID');
        const extensionId = createHash('sha256')
          .update(Buffer.from(manifest.key, 'base64'))
          .digest('hex')
          .slice(0, 32)
          .replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)));
        await current();
        started = true;
        const raw = await (this.options.run ?? runChromeSetupProcess)({
          entrypoint: resolve(verified.rootDir, 'native-host/setup-host.mjs'),
          projectRoot,
          home,
          action: action.data,
          signal: request.signal,
          assertCurrent: current,
        });
        const result = protocol.parse(raw);
        if (result.action !== action.data) throw new Error('SETUP_PROTOCOL_INVALID');
        if (!result.ok) {
          completedResult = response(409, {
            error: `Chrome setup: ${result.code}`,
            code: result.code,
            effect: 'inspect_required',
          });
        } else {
          const expectedPath = resolve(projectRoot, '.cat-cafe/plugin-host/personal-chrome-host/extension');
          if (
            result.extensionId !== extensionId ||
            result.extensionPath !== (result.installed ? expectedPath : null) ||
            result.restartRequired !== (result.browserAction === 'load-unpacked') ||
            (!result.installed && result.restartRequired)
          )
            throw new Error('SETUP_PROTOCOL_INVALID');
          const detail = !result.installed
            ? '尚未安装本机连接。选择安装，再在 Chrome 中加载扩展。'
            : `扩展目录：${expectedPath}\n${
                result.restartRequired
                  ? '打开 chrome://extensions，首次选择“加载已解压的扩展”；已加载时点击重新加载。'
                  : '扩展文件已就绪。'
              }\n安装不代表已连接。请运行测试连接，再授权指定对话。无需重启 Host。`;
          completedResult = response(200, {
            ok: true,
            render: 'rows',
            data: {
              rows: [{ key: 'installation', label: result.installed ? '本机连接已安装' : '本机连接未安装', detail }],
            },
          });
        }
        await current();
        await verified.verifyIntegrity();
        return completedResult;
      } finally {
        await verified.release();
      }
    };
    try {
      if (action.data === 'inspect') return await perform(initial);
      return (
        await this.options.lifecycle.runWithRuntimeSuspended({
          instanceId: initial.pluginInstanceId,
          expectedRevision: initial.lifecycleRevision,
          stopReason: 'host_setup',
          resumeFailureCode: 'CONFIGURATION_RESUME_FAILED',
          preflight: () => assertCurrent(initial),
          operation: async (stopped) => {
            // Only this queue's stop revision is adopted; package and activation stay fenced.
            await assertCurrent(stopped);
            return perform(stopped);
          },
        })
      ).result;
    } catch (error) {
      const recoveryFailed = error instanceof PluginLifecycleError && error.code === 'CONFIGURATION_RESUME_FAILED';
      return response(409, {
        error: completedResult
          ? recoveryFailed
            ? '设置操作已返回结果，但插件运行恢复失败。请先检查连接状态，再从插件卡恢复运行；不要重复安装或卸载。'
            : '设置操作已返回结果，但请求或安装状态随后变化。请刷新并先检查连接状态；不要重复安装或卸载。'
          : started
            ? '设置结果尚未确认。请刷新后先检查连接状态，不要直接重复安装或卸载。'
            : '设置未开始：请求、安装或权限已变化。请刷新后重试。',
        code: recoveryFailed ? 'SETUP_RUNTIME_RECOVERY_FAILED' : 'CHROME_SETUP_FAILED',
        effect: completedResult ? 'reported' : started ? 'unknown' : 'not_started',
        ...(completedResult ? { setupResult: completedResult.body } : {}),
      });
    }
  }
}
