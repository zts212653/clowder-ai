import { CODEX_LIVE_DISABLED_FEATURES } from './codex-live-policy.js';

/** Shared native effect restrictions; ordinary watcher reads use the named MCP file reader. */
export function codexWatcherPolicyArgs(bounded: boolean): string[] {
  return [
    ...CODEX_LIVE_DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]),
    '--disable',
    'multi_agent',
    ...(!bounded
      ? [
          '--disable',
          'hooks',
          '--config',
          'features.default_mode_request_user_input=false',
          '--config',
          'tools.experimental_request_user_input.enabled=false',
        ]
      : []),
    '--enable',
    'code_mode_host',
    '--config',
    'agents.enabled=false',
    '--config',
    'features.multi_agent_v2={enabled=false,disable_native_tools=true}',
    '--config',
    'web_search="disabled"',
    '--config',
    'project_doc_max_bytes=0',
    '--config',
    'skills.include_instructions=false',
    '--config',
    'orchestrator.skills.enabled=false',
    '--config',
    'orchestrator.mcp.enabled=false',
    '--config',
    'features.enable_request_compression=false',
  ];
}
