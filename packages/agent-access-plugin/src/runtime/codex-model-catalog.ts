import type {
  AgentAccessCodexModelCatalogRequest,
  AgentAccessModelCatalog,
} from '@clowder-ai/agent-contract';

type LaunchResult = { stdout: string; stderr?: string; code?: number | string | null };

/**
 * Codex owns the command shape (`debug models`); the Host owns the trusted
 * executable, environment and process execution. Only selectable metadata
 * crosses back.
 */
export async function discoverCodexModelCatalog(
  input: AgentAccessCodexModelCatalogRequest['input'],
  launch: (request: { args: string[]; cwd?: string }) => Promise<LaunchResult>,
): Promise<AgentAccessModelCatalog> {
  const result = await launch({ args: ['debug', 'models'], ...(input.cwd ? { cwd: input.cwd } : {}) });
  if (result.code !== undefined && result.code !== 0) throw new Error('catalog_unavailable');
  const raw: unknown = JSON.parse(result.stdout);
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const rows = Array.isArray(record.models) ? record.models : [];
  const models = rows.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    if (row.visibility !== 'list') return [];
    const value = typeof row.slug === 'string' ? row.slug : undefined;
    if (!value) return [];
    const levels = Array.isArray(row.supported_reasoning_levels) ? row.supported_reasoning_levels : [];
    const efforts = levels.flatMap((level) => {
      if (!level || typeof level !== 'object') return [];
      const entry = level as Record<string, unknown>;
      return typeof entry.effort === 'string'
        ? [
            {
              value: entry.effort,
              label: entry.effort,
              ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
            },
          ]
        : [];
    });
    return [
      {
        value,
        label: typeof row.display_name === 'string' ? row.display_name : value,
        ...(typeof row.description === 'string' ? { description: row.description } : {}),
        ...(efforts.length ? { efforts } : {}),
      },
    ];
  });
  return { status: models.length ? 'live' : 'unavailable', models };
}
