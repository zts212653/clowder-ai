import { randomUUID } from 'node:crypto';
import type { RebuildResult } from './interfaces.js';

export interface RebuildJob {
  id: string;
  status: 'pending' | 'running' | 'done' | 'error';
  phase: string;
  percent: number;
  error?: string;
  result?: RebuildResult;
  startedAt: number;
  completedAt?: number;
}

export class RebuildJobTracker {
  private jobs = new Map<string, RebuildJob>();

  create(): string {
    for (const job of this.jobs.values()) {
      if (job.status === 'pending' || job.status === 'running') {
        throw new Error('Rebuild already running');
      }
    }
    const id = randomUUID();
    this.jobs.set(id, {
      id,
      status: 'pending',
      phase: '',
      percent: 0,
      startedAt: Date.now(),
    });
    return id;
  }

  get(id: string): RebuildJob | null {
    return this.jobs.get(id) ?? null;
  }

  updateProgress(id: string, phase: string, percent: number): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = 'running';
    job.phase = phase;
    job.percent = Math.min(100, Math.max(0, percent));
  }

  complete(id: string, result: RebuildResult): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = 'done';
    job.percent = 100;
    job.result = result;
    job.completedAt = Date.now();
  }

  fail(id: string, error: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = 'error';
    job.error = error;
    job.completedAt = Date.now();
  }
}
