/**
 * MediaHub — MCP Tool Definitions
 * F139: Exposes MediaHub capabilities as MCP tools.
 */

import { z } from 'zod';
import type { ToolResult } from '../tools/file-tools.js';
import { errorResult, successResult } from '../tools/file-tools.js';
import type { MediaHubService } from './mediahub-service.js';
import type { GenerationRequest, MediaCapability } from './types.js';

// ============ Lazy service reference ============
// Set by bootstrap; tools use this reference at call time.
let serviceRef: MediaHubService | null = null;

export function setMediaHubService(service: MediaHubService): void {
  serviceRef = service;
}

function getService(): MediaHubService {
  if (!serviceRef) {
    throw new Error('MediaHub service not initialized');
  }
  return serviceRef;
}

// ============ Tool: list_providers ============

export const listProvidersInputSchema = {};

export async function handleListProviders(): Promise<ToolResult> {
  try {
    const providers = getService().listProviders();
    if (providers.length === 0) {
      return successResult(
        'No providers registered. Configure at least one provider API key ' +
          '(e.g. COGVIDEO_API_KEY) and restart the MCP server.',
      );
    }
    return successResult(JSON.stringify(providers, null, 2));
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

// ============ Tool: generate_video ============

export const generateVideoInputSchema = {
  provider: z
    .string()
    .describe('Provider ID (e.g. "cogvideox", "kling"). Use mediahub_list_providers to see available providers.'),
  prompt: z.string().min(1).describe('Text prompt describing the video to generate'),
  capability: z
    .enum(['text2video', 'image2video', 'text2image', 'image2image'])
    .default('text2video')
    .describe('Generation type. Default: text2video'),
  model: z.string().optional().describe('Model name override. If omitted, uses provider default.'),
  image_url: z.string().optional().describe('Reference image URL for image2video / image2image'),
  duration: z.number().optional().describe('Video duration in seconds (provider-dependent)'),
  aspect_ratio: z.string().optional().describe('Aspect ratio e.g. "16:9", "9:16", "1:1"'),
  negative_prompt: z.string().optional().describe('What to avoid in the generation'),
};

export async function handleGenerateVideo(args: {
  provider: string;
  prompt: string;
  capability?: string;
  model?: string;
  image_url?: string;
  duration?: number;
  aspect_ratio?: string;
  negative_prompt?: string;
}): Promise<ToolResult> {
  try {
    const request: GenerationRequest = {
      providerId: args.provider,
      prompt: args.prompt,
      capability: (args.capability ?? 'text2video') as MediaCapability,
      model: args.model,
      imageUrl: args.image_url,
      duration: args.duration,
      aspectRatio: args.aspect_ratio,
      negativePrompt: args.negative_prompt,
    };

    const job = await getService().generateVideo(request);
    return successResult(
      JSON.stringify(
        {
          jobId: job.jobId,
          status: job.status,
          provider: job.providerId,
          model: job.model,
          error: job.error,
          message:
            job.status === 'failed'
              ? `Generation failed: ${job.error}`
              : `Job submitted. Use mediahub_get_job_status with jobId="${job.jobId}" to check progress.`,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

// ============ Tool: generate_image ============

export const generateImageInputSchema = {
  provider: z.string().describe('Provider ID (e.g. "jimeng"). Use mediahub_list_providers to see available providers.'),
  prompt: z.string().min(1).describe('Text prompt describing the image to generate'),
  capability: z
    .enum(['text2image', 'image2image'])
    .default('text2image')
    .describe('Generation type. Default: text2image'),
  model: z.string().optional().describe('Model name override'),
  image_url: z.string().optional().describe('Reference image URL for image2image'),
  aspect_ratio: z.string().optional().describe('Aspect ratio e.g. "16:9", "1:1"'),
  negative_prompt: z.string().optional().describe('What to avoid in the generation'),
};

// ============ Tool: get_job_status ============

export const getJobStatusInputSchema = {
  job_id: z.string().describe('Job ID returned by mediahub_generate_video'),
};

export async function handleGetJobStatus(args: { job_id: string }): Promise<ToolResult> {
  try {
    const result = await getService().getJobStatus(args.job_id);
    return successResult(JSON.stringify(result, null, 2));
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

// ============ Tool: list_jobs ============

export const listJobsInputSchema = {
  limit: z.number().default(10).describe('Max number of recent jobs to return (default: 10)'),
};

export async function handleListJobs(args: { limit?: number }): Promise<ToolResult> {
  try {
    const jobs = await getService().listJobs(args.limit ?? 10);
    if (jobs.length === 0) {
      return successResult('No jobs found. Use mediahub_generate_video to create one.');
    }
    const summary = jobs.map((j) => ({
      jobId: j.jobId,
      provider: j.providerId,
      status: j.status,
      prompt: j.prompt.slice(0, 80),
      createdAt: new Date(j.createdAt).toISOString(),
    }));
    return successResult(JSON.stringify(summary, null, 2));
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

// ============ Tool Definitions Array ============

export const mediahubTools = [
  {
    name: 'mediahub_list_providers',
    description:
      'List all available MediaHub providers and their capabilities (video/image generation models). ' +
      'Shows provider ID, supported models, auth mode, and notes.',
    inputSchema: listProvidersInputSchema,
    handler: handleListProviders,
  },
  {
    name: 'mediahub_generate_video',
    description:
      'Submit a video or image generation job to a MediaHub provider. ' +
      'Returns a job ID for tracking. Use mediahub_get_job_status to poll for completion. ' +
      'Video generation is async and typically takes 30s-5min depending on the model.',
    inputSchema: generateVideoInputSchema,
    handler: handleGenerateVideo,
  },
  {
    name: 'mediahub_generate_image',
    description:
      'Submit an image generation job to a MediaHub provider. ' +
      'Returns a job ID for tracking. Use mediahub_get_job_status to poll for completion.',
    inputSchema: generateImageInputSchema,
    handler: handleGenerateVideo, // same lifecycle as video — capability drives the difference
  },
  {
    name: 'mediahub_get_job_status',
    description:
      'Check the status of a MediaHub generation job. Polls the provider for progress. ' +
      'When status is "succeeded", outputPath contains the local file path. ' +
      'Call this periodically until status is terminal (succeeded/failed/timeout).',
    inputSchema: getJobStatusInputSchema,
    handler: handleGetJobStatus,
  },
  {
    name: 'mediahub_list_jobs',
    description: 'List recent MediaHub generation jobs with their status and prompts.',
    inputSchema: listJobsInputSchema,
    handler: handleListJobs,
  },
] as const;
