/**
 * MediaHub — Jimeng (即梦) Provider
 * F139 Phase B: Video & image generation via Volcengine Visual API.
 *
 * Auth: Volcengine AK/SK with V4 signature (HMAC-SHA256)
 * req_keys: jimeng_t2v_v30, jimeng_i2v_v20, jimeng_high_aes_general_v21
 * Pattern: async task — submit → poll → download
 */

import { createHash, createHmac } from 'node:crypto';

import type { MediaProvider } from '../provider.js';
import type { GenerationRequest, MediaCapability, ProviderInfo, StatusResult, SubmitResult } from '../types.js';

const API_HOST = 'visual.volcengineapi.com';
const API_BASE = `https://${API_HOST}`;
const SERVICE = 'cv';
const REGION = 'cn-north-1';
const API_VERSION = '2022-08-31';

const REQ_KEYS: Record<string, string> = {
  text2video: 'jimeng_t2v_v30',
  image2video: 'jimeng_i2v_v20',
  text2image: 'jimeng_high_aes_general_v21',
};

// ============ Volcengine V4 Signature ============

function sha256hex(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function deriveSigningKey(secret: string, date: string): Buffer {
  let key = hmac(secret, date);
  key = hmac(key, REGION);
  key = hmac(key, SERVICE);
  return hmac(key, 'request');
}

function signRequest(ak: string, sk: string, action: string, body: string): Record<string, string> {
  const now = new Date();
  const xDate = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  const dateStamp = xDate.slice(0, 8);
  const scope = `${dateStamp}/${REGION}/${SERVICE}/request`;

  const qs = `Action=${encodeURIComponent(action)}&Version=${encodeURIComponent(API_VERSION)}`;
  const payloadHash = sha256hex(body);
  const signed = 'content-type;host;x-content-sha256;x-date';
  const canonical = [
    'POST',
    '/',
    qs,
    `content-type:application/json\nhost:${API_HOST}\nx-content-sha256:${payloadHash}\nx-date:${xDate}\n`,
    signed,
    payloadHash,
  ].join('\n');

  const stringToSign = `HMAC-SHA256\n${xDate}\n${scope}\n${sha256hex(canonical)}`;
  const sig = createHmac('sha256', deriveSigningKey(sk, dateStamp)).update(stringToSign).digest('hex');

  return {
    'Content-Type': 'application/json',
    Host: API_HOST,
    'X-Date': xDate,
    'X-Content-Sha256': payloadHash,
    Authorization: `HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=${signed}, Signature=${sig}`,
  };
}

// ============ Response Types ============

interface JimengResponse<T> {
  code: number;
  message: string;
  data: T;
}

interface JimengResultData {
  status: string;
  resp_data?: string;
  image_urls?: string[];
  video_url?: string;
}

// ============ Provider ============

export class JimengProvider implements MediaProvider {
  readonly info: ProviderInfo = {
    id: 'jimeng',
    displayName: '即梦 (Jimeng)',
    capabilities: ['text2video', 'image2video', 'text2image'],
    authMode: 'api_key',
    models: ['jimeng_t2v_v30', 'jimeng_i2v_v20', 'jimeng_high_aes_general_v21'],
    notes: 'Volcengine Visual API. Pay-per-use.',
  };

  constructor(
    private readonly accessKey: string,
    private readonly secretKey: string,
  ) {}

  supports(capability: MediaCapability): boolean {
    return this.info.capabilities.includes(capability);
  }

  private async apiCall<T>(action: string, body: Record<string, unknown>): Promise<T> {
    const bodyStr = JSON.stringify(body);
    const headers = signRequest(this.accessKey, this.secretKey, action, bodyStr);
    const url = `${API_BASE}/?Action=${encodeURIComponent(action)}&Version=${encodeURIComponent(API_VERSION)}`;

    const res = await fetch(url, { method: 'POST', headers, body: bodyStr });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Jimeng API failed (${res.status}): ${text}`);
    }

    const result = (await res.json()) as JimengResponse<T>;
    if (result.code !== 10000) {
      throw new Error(`Jimeng error (${result.code}): ${result.message}`);
    }
    return result.data;
  }

  async submit(request: GenerationRequest): Promise<SubmitResult> {
    const reqKey = request.model ?? REQ_KEYS[request.capability] ?? REQ_KEYS['text2video'];
    const body: Record<string, unknown> = { req_key: reqKey, prompt: request.prompt };

    if (request.duration) body['duration'] = request.duration;
    if (request.aspectRatio) body['aspect_ratio'] = request.aspectRatio;
    if (request.negativePrompt) body['negative_prompt'] = request.negativePrompt;
    if (request.imageUrl) body['image_urls'] = [request.imageUrl];

    const data = await this.apiCall<{ task_id: string }>('CVSync2AsyncSubmitTask', body);
    return { jobId: '', providerTaskId: `${reqKey}::${data.task_id}`, status: 'running' };
  }

  async queryStatus(providerTaskId: string): Promise<StatusResult> {
    const sep = providerTaskId.indexOf('::');
    const reqKey = sep >= 0 ? providerTaskId.slice(0, sep) : 'jimeng_t2v_v30';
    const taskId = sep >= 0 ? providerTaskId.slice(sep + 2) : providerTaskId;

    const data = await this.apiCall<JimengResultData>('CVSync2AsyncGetResult', {
      req_key: reqKey,
      task_id: taskId,
    });

    if (data.status === 'done') {
      const url = this.extractResultUrl(data);
      if (url) {
        return { jobId: '', status: 'succeeded', providerResultUrl: url };
      }
    }

    if (data.status === 'failed' || data.status === 'not_found') {
      return { jobId: '', status: 'failed', error: `Jimeng task ${data.status}` };
    }

    return { jobId: '', status: 'running' };
  }

  /** Extract result URL from various Jimeng response formats */
  private extractResultUrl(data: JimengResultData): string | null {
    // Format 1: image_urls array (text2image)
    if (data.image_urls && data.image_urls.length > 0) return data.image_urls[0];
    // Format 2: video_url string (video tasks)
    if (data.video_url) return data.video_url;
    // Format 3: resp_data JSON string
    if (data.resp_data) {
      try {
        const parsed = JSON.parse(data.resp_data) as unknown;
        if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].url) return parsed[0].url;
        if (parsed && typeof parsed === 'object' && 'urls' in parsed) {
          const urls = (parsed as { urls: string[] }).urls;
          if (Array.isArray(urls) && urls.length > 0) return urls[0];
        }
      } catch {
        // parse failure — no URL extractable
      }
    }
    return null;
  }
}

/** Factory: creates provider if Volcengine AK/SK are available */
export function createJimengProvider(): JimengProvider | null {
  const ak = process.env['VOLC_ACCESSKEY'];
  const sk = process.env['VOLC_SECRETKEY'];
  if (!ak || !sk) return null;
  return new JimengProvider(ak, sk);
}
