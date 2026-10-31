import { CODEX_LIVE_DISABLED_FEATURES } from '../../../domains/cats/services/agents/providers/codex-live-policy.js';
import type { CliSpawnOptions } from '../../../utils/cli-types.js';

export function restrictWatcherLaunch(
  provider: 'openai' | 'anthropic',
  original: CliSpawnOptions,
  schemaPath?: string,
  schema?: string,
): CliSpawnOptions {
  if (provider === 'anthropic') {
    if (
      !original.args.includes('--tools') ||
      original.args[original.args.indexOf('--tools') + 1] !== '' ||
      !original.args.includes('--strict-mcp-config')
    )
      throw new Error('watcher_requires_zero_native_tools');
    return {
      ...original,
      args: [...original.args, '--safe-mode', ...(schema ? ['--json-schema', schema] : [])],
      bindExecutionOwner: false,
    };
  }
  const boundary = original.args.indexOf('--');
  if (boundary < 0 || original.args[boundary + 1] !== '-') throw new Error('watcher_requires_stdin_prompt');
  const args = original.args.slice(0, boundary);
  const legacySandbox = args.indexOf('--sandbox');
  if (legacySandbox >= 0) {
    if (args[legacySandbox + 1] !== 'read-only') throw new Error('watcher_requires_read_only_base');
    args.splice(legacySandbox, 2);
  }
  const configs = [
    ...CODEX_LIVE_DISABLED_FEATURES.map((feature) => `features.${feature}=false`),
    'features.code_mode_host=false',
    'features.multi_agent=false',
    'features.skip_host_skill_discovery=true',
    'web_search="disabled"',
    'project_doc_max_bytes=0',
    'skills.include_instructions=false',
    'orchestrator.skills.enabled=false',
    'orchestrator.mcp.enabled=false',
    'mcp_servers={}',
    'apps._default.enabled=false',
    'default_permissions="watcher_offline"',
    'permissions.watcher_offline.filesystem={"/"="deny",":minimal"="read",":tmpdir"="deny",":slash_tmp"="deny"}',
    'permissions.watcher_offline.network={enabled=false}',
    'approval_policy="never"',
  ];
  return {
    ...original,
    args: [
      ...args,
      ...['--ignore-user-config', '--ephemeral'].filter((flag) => !args.includes(flag)),
      ...(schemaPath ? ['--output-schema', schemaPath] : []),
      ...configs.flatMap((value) => ['--config', value]),
      ...original.args.slice(boundary),
    ],
    bindExecutionOwner: false,
  };
}
