import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DshNativeAccount } from '../../../../../../../config/native-accounts/dsh-account.js';
import type { DshNativeLaunch } from '../../../../../../../config/native-accounts/dsh-installation.js';
import { findMonorepoRoot } from '../../../../../../../utils/monorepo-root.js';
import type { AgentServiceOptions } from '../../../../types.js';
import { prepareDshSecretPatch } from '../../dsh-secret-patch.js';
import { captureProviderMcpConfig, materializeProviderMcpConfig } from '../../provider-mcp-config.js';
import { watcherMcpToolMap, watcherNativeMcpPlan } from '../../watcher-mcp-input.js';

/** Public installed DSH extension: remove native tools before registering the exact observer readers. */
export const DSH_WATCHER_PLUGIN = `
import {createHash} from 'node:crypto';
export const name='cat-cafe-watcher';
export const inject=['tools','systemPrompt','agents','credentials'];
export async function apply(ctx,config){
 const hit=await ctx.credentials.resolve(config.credentialRef);
 if(!hit||createHash('sha256').update(hit.value).digest('hex')!==config.keyDigest) throw new Error('dsh_watcher_account_changed');
 const allowed=new Set(Object.entries(config.tools).flatMap(([server,names])=>names.map(name=>'mcp__'+server+'__'+name)));
 ctx.tools.guard(call=>allowed.has(call.name)?undefined:'watcher_tool_not_allowed');
 const mcp=await import(config.mcpModule);
 ctx.on('agent/created',async({agent})=>{
  agent.ctx.tools.restrict({allow:[]});
  agent.ctx.systemPrompt.section({name:'cat-cafe-watcher',order:0,text:config.identity,complete:true,interpolate:false});
  agent.ctx.systemPrompt.suppressRuntimeContext();
  for(const [serverName,server] of Object.entries(config.servers))
   await agent.ctx.plugin(mcp,{transport:'stdio',serverName,command:server.command,args:server.args,env:server.env,cwd:server.cwd,failOnStartupError:true});
 });
 ctx.provide('catCafeWatcher',{ready:true});
}
`;

/** Per-launch parameters are temporary; native watcher history is durable and scoped to its Host session. */
export async function prepareDshWatcherLaunch(input: {
  native: DshNativeLaunch;
  account: DshNativeAccount;
  identity: string;
  options: AgentServiceOptions;
}) {
  const { native, account, options } = input;
  if (!options.hostSessionId || !options.workingDirectory) throw new Error('dsh_watcher_session_required');
  if (options.toolExecutionPolicy?.mode !== 'watcher_panel') throw new Error('dsh_watcher_policy_required');
  const names = options.toolExecutionPolicy.allowedToolNames ?? [];
  const callbackEnv: Record<string, string> = {
    ...options.callbackEnv,
    CAT_CAFE_MCP_TRANSPORT: 'stdio',
    CAT_CAFE_ALLOWED_TOOL_NAMES: JSON.stringify(names),
  };
  const plan = watcherNativeMcpPlan(
    options.frozenNativeMcpConfig ??
      (await captureProviderMcpConfig({
        callbackEnv,
        workingDirectory: options.workingDirectory,
        provider: 'acp',
        mcpServerPath: join(findMonorepoRoot(process.cwd()), 'packages/mcp-server/dist/index.js'),
      })),
    names,
  );
  const servers = materializeProviderMcpConfig(plan, { callbackEnv }).servers;
  const root = await mkdtemp(join(tmpdir(), 'cat-cafe-dsh-watcher-'));
  const dispose = () => rm(root, { recursive: true, force: true });
  try {
    const namespace = createHash('sha256')
      .update(JSON.stringify([options.hostSessionId, account.profile.id, account.keyDigest, account.model]))
      .digest('hex');
    const home = join(
      callbackEnv.CAT_CAFE_DATA_DIR ?? join(native.projectRoot, '.cat-cafe'),
      'watcher-native/dsh',
      namespace,
    );
    await mkdir(home, { recursive: true, mode: 0o700 });
    const plugin = join(root, 'watcher.mjs'),
      patch = join(root, 'watcher.patch.json');
    await writeFile(plugin, DSH_WATCHER_PLUGIN, { mode: 0o600, flag: 'wx' });
    const require = createRequire(native.packagePath);
    const disabled = [
      'agent-instructions',
      'skill',
      'skill-filesystem',
      'tool-skill',
      'mcp-resources',
      'plugin-manager',
      'config-editor',
      'settings',
    ];
    await writeFile(
      patch,
      JSON.stringify([
        ...disabled.map((id) => ({ id, disabled: true })),
        { id: 'credentials', config: { path: account.credentialPath, watch: false } },
        { id: 'llm-deepseek', config: account.providerConfig },
        { id: 'tools', config: { mode: 'native' } },
        {
          insert: [
            {
              id: 'cat-cafe-watcher',
              name: pathToFileURL(plugin).href,
              config: {
                credentialRef: account.credentialRef,
                keyDigest: account.keyDigest,
                identity: input.identity,
                mcpModule: pathToFileURL(require.resolve('@deepseek-ai/dsh-mcp-client')).href,
                tools: watcherMcpToolMap(names),
                servers,
              },
            },
          ],
        },
        {
          id: 'acp',
          inject: ['acpAppStartup', 'catCafeSecretContent', 'catCafeWatcher'],
          config: { provider: account.provider, model: account.model },
        },
      ]),
      { mode: 0o600, flag: 'wx' },
    );
    const secretArgs = await prepareDshSecretPatch('dsh', [...native.args], root);
    const env: Record<string, string> = {
      DSH_HOME: home,
      DSH_AGENTS_HOME: join(home, 'agents'),
      DSH_TELEMETRY_DISABLED: '1',
    };
    for (const key of [
      'PATH',
      'LANG',
      'LC_ALL',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'NO_PROXY',
      'SSL_CERT_FILE',
      'SSL_CERT_DIR',
      'NODE_EXTRA_CA_CERTS',
    ]) {
      const value = native.env[key] ?? process.env[key];
      if (value) env[key] = value;
    }
    return {
      command: native.command,
      args: [...secretArgs, '--patch', patch],
      cwd: options.workingDirectory,
      env,
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
