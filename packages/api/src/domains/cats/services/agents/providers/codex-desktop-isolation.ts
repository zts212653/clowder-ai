/** Desktop plugins require their host; native Apps retain the selected account's own enablement and permissions. */
export const CODEX_DESKTOP_ISOLATION_ARGS = ['--config', 'features.plugins=false'] as const;

/** Scoped/read-only/Live sessions expose only their policy-selected tools. */
export const CODEX_RESTRICTED_APPS_ARGS = ['--config', 'features.apps=false'] as const;
