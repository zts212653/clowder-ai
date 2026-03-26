/**
 * MediaHub — Core Service
 * F139: Orchestrates provider selection, job lifecycle, and storage.
 */

import { randomUUID } from 'node:crypto';
import type { JobStore } from './job-store.js';
import type { CleanupResult } from './media-lifecycle.js';
import { cleanupExpiredMedia } from './media-lifecycle.js';
import type { MediaStorage } from './media-storage.js';
import type { ProviderRegistry } from './provider.js';
import type { GenerationRequest, JobRecord, JobStatus, MediaCapability, ProviderInfo, StatusResult } from './types.js';

export interface JobFilters {
  status?: JobStatus;
  provider?: string;
  capability?: MediaCapability;
}

export class MediaHubService {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly jobStore: JobStore,
    private readonly storage: MediaStorage,
  ) {}

  /** List all registered providers */
  listProviders(): ProviderInfo[] {
    return this.registry.list();
  }

  /** Submit a new generation job */
  async generateVideo(request: GenerationRequest): Promise<JobRecord> {
    const provider = this.registry.get(request.providerId);
    if (!provider) {
      throw new Error(`Unknown provider: ${request.providerId}`);
    }
    if (!provider.supports(request.capability)) {
      throw new Error(`Provider ${request.providerId} does not support ${request.capability}`);
    }

    const jobId = randomUUID();
    const model = request.model ?? provider.info.models[0] ?? 'default';
    const now = Date.now();

    // Create initial job record
    const job: JobRecord = {
      jobId,
      providerId: request.providerId,
      capability: request.capability,
      model,
      prompt: request.prompt,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
    };
    await this.jobStore.save(job);

    // Submit to provider
    try {
      const result = await provider.submit({ ...request, model });
      await this.jobStore.updateStatus(jobId, result.status, {
        providerTaskId: result.providerTaskId,
      });
      job.status = result.status;
      job.providerTaskId = result.providerTaskId;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.jobStore.updateStatus(jobId, 'failed', { error: errMsg });
      job.status = 'failed';
      job.error = errMsg;
    }

    return job;
  }

  /** Query job status, polling provider if still in progress */
  async getJobStatus(jobId: string): Promise<StatusResult> {
    const job = await this.jobStore.get(jobId);
    if (!job) {
      return { jobId, status: 'failed', error: 'Job not found' };
    }

    // If already terminal, return cached state
    if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'timeout') {
      return {
        jobId,
        status: job.status,
        outputPath: job.outputPath,
        providerResultUrl: job.providerResultUrl,
        error: job.error,
      };
    }

    // Poll provider for latest status
    if (!job.providerTaskId) {
      return { jobId, status: job.status };
    }

    const provider = this.registry.get(job.providerId);
    if (!provider) {
      return { jobId, status: job.status, error: 'Provider not found' };
    }

    try {
      const providerStatus = await provider.queryStatus(job.providerTaskId);

      // If completed, download media
      if (providerStatus.status === 'succeeded' && providerStatus.providerResultUrl) {
        let outputPath: string | undefined;
        try {
          outputPath = await this.storage.download(job.providerId, jobId, providerStatus.providerResultUrl);
        } catch {
          // Download failure is non-fatal; URL is still available
        }
        await this.jobStore.updateStatus(jobId, 'succeeded', {
          outputPath,
          providerResultUrl: providerStatus.providerResultUrl,
        });
        return {
          jobId,
          status: 'succeeded',
          outputPath,
          providerResultUrl: providerStatus.providerResultUrl,
        };
      }

      // Update status in store
      if (providerStatus.status !== job.status) {
        await this.jobStore.updateStatus(jobId, providerStatus.status, {
          error: providerStatus.error,
        });
      }

      return {
        jobId,
        status: providerStatus.status,
        progress: providerStatus.progress,
        error: providerStatus.error,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { jobId, status: job.status, error: `Poll failed: ${errMsg}` };
    }
  }

  /** Get a job record without polling the provider */
  async getJob(jobId: string): Promise<JobRecord | null> {
    return this.jobStore.get(jobId);
  }

  /** Run cleanup of expired media files whose jobs no longer exist */
  async runCleanup(): Promise<CleanupResult> {
    return cleanupExpiredMedia(this.storage.getBaseDir(), async (jobId) => {
      const job = await this.jobStore.get(jobId);
      return job !== null;
    });
  }

  /** List recent jobs with optional filtering */
  async listJobs(limit = 20, filters?: JobFilters): Promise<JobRecord[]> {
    const fetchLimit = filters ? limit * 5 : limit;
    const all = await this.jobStore.listRecent(fetchLimit);
    if (!filters) return all.slice(0, limit);

    return all
      .filter((job) => {
        if (filters.status && job.status !== filters.status) return false;
        if (filters.provider && job.providerId !== filters.provider) return false;
        if (filters.capability && job.capability !== filters.capability) return false;
        return true;
      })
      .slice(0, limit);
  }
}
