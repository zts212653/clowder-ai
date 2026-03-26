/**
 * MediaHub — CogVideoX Provider (Zhipu AI)
 * F139: Free unlimited video generation via CogVideoX-Flash.
 *
 * API docs: https://bigmodel.cn/dev/api/videoGeneration/cogvideox
 * Auth: API key via COGVIDEO_API_KEY env var
 * Model: cogvideox-flash (free, 1440x960, ~6s)
 * Pattern: async task — submit → poll → download
 */

import type { MediaProvider } from '../provider.js';
import type { GenerationRequest, MediaCapability, ProviderInfo, StatusResult, SubmitResult } from '../types.js';

const API_BASE = 'https://open.bigmodel.cn/api/paas/v4';
const DEFAULT_MODEL = 'cogvideox-flash';

interface CogVideoTaskResponse {
  id: string;
  task_status: 'PROCESSING' | 'SUCCESS' | 'FAIL';
  video_result?: Array<{ url: string; cover_image_url: string }>;
  request_id?: string;
}

export class CogVideoXProvider implements MediaProvider {
  readonly info: ProviderInfo = {
    id: 'cogvideox',
    displayName: 'CogVideoX (Zhipu)',
    capabilities: ['text2video', 'image2video'],
    authMode: 'api_key',
    models: [DEFAULT_MODEL],
    notes: 'Free unlimited. Output: 1440x960 ~6s. May throttle during peak hours.',
  };

  constructor(private readonly apiKey: string) {}

  supports(capability: MediaCapability): boolean {
    return this.info.capabilities.includes(capability);
  }

  async submit(request: GenerationRequest): Promise<SubmitResult> {
    const model = request.model ?? DEFAULT_MODEL;

    const body: Record<string, unknown> = {
      model,
      prompt: request.prompt,
    };

    if (request.capability === 'image2video' && request.imageUrl) {
      body['image_url'] = request.imageUrl;
    }

    const response = await fetch(`${API_BASE}/videos/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`CogVideoX submit failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as { id: string; task_status: string };

    return {
      jobId: '', // filled by MediaHubService
      providerTaskId: data.id,
      status: data.task_status === 'SUCCESS' ? 'succeeded' : 'running',
    };
  }

  async queryStatus(providerTaskId: string): Promise<StatusResult> {
    const response = await fetch(`${API_BASE}/async-result/${providerTaskId}`, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`CogVideoX query failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as CogVideoTaskResponse;

    if (data.task_status === 'SUCCESS' && data.video_result?.length) {
      return {
        jobId: '',
        status: 'succeeded',
        providerResultUrl: data.video_result[0].url,
      };
    }

    if (data.task_status === 'FAIL') {
      return {
        jobId: '',
        status: 'failed',
        error: 'CogVideoX generation failed',
      };
    }

    return {
      jobId: '',
      status: 'running',
    };
  }
}

/** Factory: creates provider if API key is available */
export function createCogVideoXProvider(): CogVideoXProvider | null {
  const apiKey = process.env['COGVIDEO_API_KEY'];
  if (!apiKey) return null;
  return new CogVideoXProvider(apiKey);
}
