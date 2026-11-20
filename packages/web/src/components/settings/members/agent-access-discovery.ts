import type { AgentAccessDetection, AgentAccessReadiness } from '@clowder-ai/agent-contract';
import { apiFetch } from '@/utils/api-client';

export async function readAgentAccessDetection(
  refresh: boolean,
): Promise<AgentAccessDetection & { readiness: AgentAccessReadiness & { reason?: string } }> {
  try {
    const response = await apiFetch('/api/agent-access/v1/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh }),
    });
    if (response.ok) return await response.json();
    return {
      readiness: { state: 'failed', action: 'retry', reason: `HTTP ${response.status}` },
      candidates: [],
    };
  } catch (error) {
    return {
      readiness: {
        state: 'failed',
        action: 'retry',
        reason: error instanceof Error ? error.message : 'detect failed',
      },
      candidates: [],
    };
  }
}
