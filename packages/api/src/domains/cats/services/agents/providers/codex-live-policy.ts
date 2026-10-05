/** Live's native process has only the Host-selected MCP surface. Auth/login remains the existing account's. */
export const CODEX_LIVE_DISABLED_FEATURES = [
  'shell_tool',
  'unified_exec',
  'shell_snapshot',
  'apply_patch_freeform',
  'multi_agent',
  'apps',
  'plugins',
  'remote_plugin',
  'memories',
  'external_agent_memory_import',
  'skill_search',
  'skill_mcp_dependency_install',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'image_generation',
  'in_app_browser',
  'in_app_local_automation',
  'goals',
  'tool_suggest',
  'view_image',
] as const;

export const CODEX_LIVE_POLICY_ARGS = [
  ...CODEX_LIVE_DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]),
  // Astra uses code-mode to invoke the selected MCP tools. This is the isolated
  // tool dispatcher, not shell/Node access; those capabilities stay disabled above.
  '--enable',
  'code_mode_host',
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
] as const;
