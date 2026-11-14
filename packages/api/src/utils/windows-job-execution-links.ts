/**
 * #1838: which executions a Windows API job owned.
 *
 * Written at provider entry, before the provider is marked started, so an execution whose API was
 * killed mid-turn is still joinable to its job's stop verdict after a restart. Keyed by job name,
 * never by API pid: a dead API's pid can be reused, and a pid-keyed link could let one job's absence
 * release another instance's execution. The link carries the full execution identity so recovery
 * can check it against the ledger before releasing anything.
 */

import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type CliExecutionOwnerRef, resolveCatCafeDataRoot } from './cli-process-ownership.js';
import { isClowderJobName } from './windows-job-native.js';

const WINDOWS_JOB_LINKS_DIRECTORY = 'windows-job-execution-links';

export interface WindowsJobExecutionLink {
  v: 1;
  jobName: string;
  execution: CliExecutionOwnerRef;
  linkedAt: number;
}

export type WindowsJobExecutionLinkEntry = WindowsJobExecutionLink & { path: string };

export function resolveWindowsJobLinksDirectory(dataDir?: string): string {
  return join(resolveCatCafeDataRoot(dataDir), WINDOWS_JOB_LINKS_DIRECTORY);
}

function linkFileName(jobName: string, invocationId: string): string {
  // Encoded so both parts stay inside one file-name segment.
  return `${encodeURIComponent(jobName)}.${encodeURIComponent(invocationId)}.json`;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function parseWindowsJobExecutionLink(value: unknown): WindowsJobExecutionLink | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const execution = record.execution as Record<string, unknown> | null | undefined;
  if (record.v !== 1 || typeof execution !== 'object' || execution === null) return null;
  if (!nonEmpty(record.jobName) || !isClowderJobName(record.jobName)) return null;
  const { executionId, invocationId, threadId, catId, userId } = execution;
  if (!nonEmpty(executionId) || !nonEmpty(invocationId) || !nonEmpty(threadId)) return null;
  if (!nonEmpty(catId) || !nonEmpty(userId)) return null;
  if (typeof record.linkedAt !== 'number' || !Number.isSafeInteger(record.linkedAt) || record.linkedAt <= 0)
    return null;
  return {
    v: 1,
    jobName: record.jobName,
    execution: { executionId, invocationId, threadId, catId, userId },
    linkedAt: record.linkedAt,
  };
}

/**
 * Durably link one execution to the job that owns its provider. Atomic, because this record exists
 * for the case where the API is killed at an arbitrary moment: a torn link would leave its
 * execution protected forever.
 */
export function recordWindowsJobExecutionLink(options: {
  dataDir?: string;
  jobName: string;
  execution: CliExecutionOwnerRef;
}): WindowsJobExecutionLinkEntry {
  const directory = resolveWindowsJobLinksDirectory(options.dataDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const link: WindowsJobExecutionLink = {
    v: 1,
    jobName: options.jobName,
    execution: { ...options.execution },
    linkedAt: Date.now(),
  };
  const path = join(directory, linkFileName(options.jobName, options.execution.invocationId));
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(link)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
  return { ...link, path };
}

/** Executions linked to one job. A link that cannot be read is reported, never silently dropped. */
export function readWindowsJobExecutionLinks(
  jobName: string,
  dataDir?: string,
): { links: WindowsJobExecutionLinkEntry[]; invalidPaths: string[] } {
  const directory = resolveWindowsJobLinksDirectory(dataDir);
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { links: [], invalidPaths: [] };
    return { links: [], invalidPaths: [directory] };
  }
  const prefix = `${encodeURIComponent(jobName)}.`;
  const entries = names
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .map((name) => {
      const path = join(directory, name);
      let link: WindowsJobExecutionLink | null = null;
      try {
        link = parseWindowsJobExecutionLink(JSON.parse(readFileSync(path, 'utf8')));
      } catch {
        link = null;
      }
      // The file name must agree with the content, or the link cannot be trusted for this job.
      const consistent = link?.jobName === jobName && name === linkFileName(jobName, link.execution.invocationId);
      return { path, link: consistent ? link : null };
    });
  return {
    links: entries.flatMap(({ path, link }) => (link ? [{ ...link, path }] : [])),
    invalidPaths: entries.filter(({ link }) => !link).map(({ path }) => path),
  };
}

/**
 * The job of every link that names this invocation, read from file names alone so that a link whose
 * content cannot be read still counts. A stop needs every one of these jobs closed. Null when the
 * links cannot be listed, since then no set of jobs is known to be complete.
 */
export function readWindowsJobNamesLinkedTo(invocationId: string, dataDir?: string): string[] | null {
  let names: string[];
  try {
    names = readdirSync(resolveWindowsJobLinksDirectory(dataDir));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null;
  }
  const suffix = `.${encodeURIComponent(invocationId)}.json`;
  // A foreign name that merely ends like this one decodes to a job no closed job matches, so it keeps
  // the protection instead of releasing anything.
  return names.filter((name) => name.endsWith(suffix)).map((name) => decodeURIComponent(name.slice(0, -suffix.length)));
}

export function clearWindowsJobExecutionLink(path: string): void {
  rmSync(path, { force: true });
}
