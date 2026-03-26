/**
 * MediaHub — Kling (可灵) Provider
 * F139 Phase B: Video generation via Kling AI API.
 *
 * API docs: https://klingapi.com/docs
 * Auth: JWT with AK/SK (HS256, 30-min token lifetime)
 * Models: kling-v2.6-pro (default), kling-v1.6-pro, etc.
 * Pattern: async task — submit → poll → download
 * Free tier: 66 credits/day (5s standard = 10 credits)
 */

import { createHmac } from 'node:crypto';

import type { MediaProvider } from '../provider.js';
import type { GenerationRequest, MediaCapability, ProviderInfo, StatusResult, SubmitResult } from '../types.js';

const API_BASE = 'https://api.klingapi.com';
const DEFAULT_MODEL = 'kling-v2.6-pro';
const JWT_LIFETIME_S = 1800; // 30 min

// ============ JWT Generation (HS256) ============

function base64url(data: string | Buffer): string {
  const buf = typeof data === 'string' ? Buffer.from(data) : data;
  return buf.toString('base64url');
}

function createJwt(accessKey: string, secretKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      iss: accessKey,
      iat: now,
      nbf: now - 5,
      exp: now + JWT_LIFETIME_S,
    }),
  );
  const sig = createHmac('sha256', secretKey).update(`${header}.${payload}`).digest();
  return `${header}.${payload}.${base64url(sig)}`;
}

// ============ API Response Types ============

interface KlingTaskData {
  task_id: string;
  task_status: 'submitted' | 'processing' | 'succeed' | 'failed';
  task_status_msg?: string;
  task_result?: {
    videos?: Array<{ url: string; duration?: string }>;
    images?: Array<{ url: string }>;
  };
}

interface KlingResponse {
  code: number;
  message: string;
  data: KlingTaskData;
}

// ============ Provider ============

export class KlingProvider implements MediaProvider {
  readonly info: ProviderInfo = {
    id: 'kling',
    displayName: '可灵 (Kling AI)',
    capabilities: ['text2video', 'image2video'],
    authMode: 'api_key',
    models: [DEFAULT_MODEL, 'kling-v1.6-pro'],
    notes: 'Free 66 credits/day. 5s std=10cr, 5s pro=35cr.',
  };

  constructor(
    private readonly accessKey: string,
    private readonly secretKey: string,
  ) {}

  supports(capability: MediaCapability): boolean {
    return this.info.capabilities.includes(capability);
  }

  private authHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${createJwt(this.accessKey, this.secretKey)}`,
    };
  }

  async submit(request: GenerationRequest): Promise<SubmitResult> {
    const model = request.model ?? DEFAULT_MODEL;
    const endpoint =
      request.capability === 'image2video' ? `${API_BASE}/v1/videos/image2video` : `${API_BASE}/v1/videos/text2video`;

    const body: Record<string, unknown> = {
      model,
      prompt: request.prompt,
    };

    if (request.duration) body['duration'] = String(request.duration);
    if (request.aspectRatio) body['aspect_ratio'] = request.aspectRatio;
    if (request.negativePrompt) body['negative_prompt'] = request.negativePrompt;
    if (request.capability === 'image2video' && request.imageUrl) {
      body['image_url'] = request.imageUrl;
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Kling submit failed (${response.status}): ${text}`);
    }

    const result = (await response.json()) as KlingResponse;
    if (result.code !== 0 && result.code !== 200) {
      throw new Error(`Kling API error (${result.code}): ${result.message}`);
    }

    const typeTag = request.capability === 'image2video' ? 'i2v' : 't2v';
    return {
      jobId: '',
      providerTaskId: `${typeTag}::${result.data.task_id}`,
      status: mapKlingStatus(result.data.task_status),
    };
  }

  async queryStatus(providerTaskId: string): Promise<StatusResult> {
    const sep = providerTaskId.indexOf('::');
    const type = sep >= 0 ? providerTaskId.slice(0, sep) : 't2v';
    const taskId = sep >= 0 ? providerTaskId.slice(sep + 2) : providerTaskId;
    const endpoint = type === 'i2v' ? 'image2video' : 'text2video';

    const response = await fetch(`${API_BASE}/v1/videos/${endpoint}/${taskId}`, { headers: this.authHeaders() });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Kling query failed (${response.status}): ${text}`);
    }

    const result = (await response.json()) as KlingResponse;
    const data = result.data;
    const status = mapKlingStatus(data.task_status);

    if (status === 'succeeded' && data.task_result?.videos?.length) {
      return {
        jobId: '',
        status: 'succeeded',
        providerResultUrl: data.task_result.videos[0].url,
      };
    }

    if (status === 'failed') {
      return {
        jobId: '',
        status: 'failed',
        error: data.task_status_msg ?? 'Kling generation failed',
      };
    }

    return { jobId: '', status };
  }
}

function mapKlingStatus(s: string): 'queued' | 'running' | 'succeeded' | 'failed' {
  switch (s) {
    case 'submitted':
      return 'queued';
    case 'processing':
      return 'running';
    case 'succeed':
      return 'succeeded';
    case 'failed':
      return 'failed';
    default:
      return 'running';
  }
}

/** Factory: creates provider if AK/SK are available */
export function createKlingProvider(): KlingProvider | null {
  const ak = process.env['KLING_ACCESS_KEY'];
  const sk = process.env['KLING_SECRET_KEY'];
  if (!ak || !sk) return null;
  return new KlingProvider(ak, sk);
}
