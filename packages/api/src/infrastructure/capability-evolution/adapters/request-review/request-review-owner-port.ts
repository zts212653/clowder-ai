/**
 * Production Git port for the request-review owner adapter.
 *
 * All reads are pinned to a specific commit — no working-tree reads.
 * This prevents dirty-worktree drift where blob OIDs come from HEAD
 * but content comes from an uncommitted working copy.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { RequestReviewGitVersion, RequestReviewOwnerPort } from './request-review-owner-adapter.js';
import { requestReviewAssetVersionRef } from './request-review-owner-identity.js';

export interface RequestReviewOwnerPortOptions {
  /** Absolute path to the repository root */
  repoRoot: string;
}

const PACKET_SHAPES = [
  ['Review-Subject-Ref:', 'Accepted-Source-Ref:', 'Accepted-Revision:'],
  ['Review-Subject-Ref:', 'Request-Review-Consumption-Handle:', 'Accepted-Source-Ref:', 'Accepted-Revision:'],
  [
    'Review-Subject-Ref:',
    'Reviewed-Head-Sha:',
    'Request-Review-Consumption-Handle:',
    'Accepted-Source-Ref:',
    'Accepted-Revision:',
  ],
] as const;

function hasAllowedPacketShape(lines: readonly string[]): boolean {
  return PACKET_SHAPES.some(
    (shape) => shape.length === lines.length && shape.every((prefix, index) => lines[index]?.startsWith(prefix)),
  );
}

function locateRequestReviewMutableAnchor(content: string) {
  const lines = content.split('\n');
  const packetStart = lines.findIndex((line) => line.startsWith('Review-Subject-Ref:'));
  const packetEnd = lines.findIndex((line, index) => index >= packetStart && line.startsWith('Accepted-Revision:'));
  const explanationStart = lines.findIndex((line, index) => index > packetEnd && line.startsWith('Feature 以'));
  let explanationEnd = explanationStart;
  while (explanationEnd >= 0 && explanationEnd + 1 < lines.length && lines[explanationEnd + 1].trim()) {
    explanationEnd += 1;
  }
  const packet = lines.slice(packetStart, packetEnd + 1);
  if (packetStart < 0 || packetEnd < packetStart || explanationStart < 0 || !hasAllowedPacketShape(packet)) {
    throw new Error('request-review accepted-source anchor is missing or malformed');
  }
  return { lines, packetStart, packetEnd, explanationStart, explanationEnd };
}

export function extractRequestReviewMutableAnchor(content: string): string {
  const located = locateRequestReviewMutableAnchor(content);
  return [
    ...located.lines.slice(located.packetStart, located.packetEnd + 1),
    ...located.lines.slice(located.explanationStart, located.explanationEnd + 1),
  ].join('\n');
}

export function requestReviewSemanticVersion(content: string): string {
  return requestReviewSemanticVersionFromAnchor(extractRequestReviewMutableAnchor(content));
}

export function requestReviewSemanticVersionFromAnchor(anchor: string): string {
  return createHash('sha256').update(anchor, 'utf8').digest('hex');
}

export function requestReviewImmutableEnvelope(content: string): string {
  const located = locateRequestReviewMutableAnchor(content);
  return [
    ...located.lines.slice(0, located.packetStart),
    '<REQUEST_REVIEW_PACKET>',
    ...located.lines.slice(located.packetEnd + 1, located.explanationStart),
    '<REQUEST_REVIEW_EXPLANATION>',
    ...located.lines.slice(located.explanationEnd + 1),
  ].join('\n');
}

export function createRequestReviewCurrentVersionReader(port: RequestReviewOwnerPort) {
  return {
    async currentVersionRef() {
      const headOid = await port.gitHeadOid();
      return requestReviewAssetVersionRef(
        requestReviewSemanticVersion(await port.readSkillFileAt(headOid, 'cat-cafe-skills/request-review/SKILL.md')),
      );
    },
  };
}

export function createRequestReviewOwnerPort(options: RequestReviewOwnerPortOptions): RequestReviewOwnerPort {
  const { repoRoot } = options;

  const git = (args: string[]): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile('git', args, { cwd: repoRoot, timeout: 10_000 }, (error, stdout, stderr) => {
        if (error) reject(new Error(`git ${args[0]} failed: ${stderr.trim() || error.message}`));
        else resolve(stdout.trim());
      });
    });

  return {
    async gitHeadOid(): Promise<string> {
      return git(['rev-parse', 'HEAD']);
    },

    async gitBlobOidAt(commitOid: string, filePath: string): Promise<string> {
      return git(['rev-parse', `${commitOid}:${filePath}`]);
    },

    async readMutableAcceptedSourceAt(commitOid: string, filePath: string): Promise<string> {
      return extractRequestReviewMutableAnchor(await this.readSkillFileAt(commitOid, filePath));
    },

    async readSkillFileAt(commitOid: string, filePath: string): Promise<string> {
      return git(['show', `${commitOid}:${filePath}`]);
    },

    async listFileHistoryAt(commitOid: string, filePath: string, limit: number): Promise<RequestReviewGitVersion[]> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 512) {
        throw new RangeError('request-review Git history limit must be between 1 and 512');
      }
      const encoded = await git([
        'log',
        `--max-count=${limit}`,
        '--format=%H%x00%aI%x00%s',
        '--follow',
        commitOid,
        '--',
        filePath,
      ]);
      const versions: RequestReviewGitVersion[] = [];
      for (const line of encoded.split('\n').filter(Boolean)) {
        const [historyCommitOid, committedAt, ...subjectParts] = line.split('\0');
        if (!historyCommitOid || !committedAt) continue;
        const blobOid = await git(['rev-parse', `${historyCommitOid}:${filePath}`]);
        versions.push({
          commitOid: historyCommitOid,
          blobOid,
          committedAt,
          subject: subjectParts.join('\0') || 'request-review skill revision',
        });
      }
      return versions;
    },
  };
}
