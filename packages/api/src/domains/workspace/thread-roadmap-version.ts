import { roadmapGit } from './thread-roadmap-project.js';
export type RoadmapVersion =
  | { status: 'available'; commit: string | null; committedAt: number | null; branch: string | null; dirty: boolean }
  | { status: 'unavailable'; reason: 'git_timeout' | 'git_error' };

export async function readRoadmapVersion(root: string, path: string, signal: AbortSignal): Promise<RoadmapVersion> {
  try {
    const [log, branch, dirty] = await Promise.all([
      roadmapGit(root, ['log', '-1', '--format=%H%x00%cI', '--', path], signal),
      roadmapGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'], signal),
      roadmapGit(root, ['status', '--porcelain=v1', '--untracked-files=normal', '--', path], signal),
    ]);
    const [commit, time] = log.split('\0');
    const committedAt = time ? Date.parse(time) : NaN;
    return {
      status: 'available',
      commit: commit || null,
      committedAt: Number.isFinite(committedAt) ? committedAt : null,
      branch: branch.slice(0, 200),
      dirty: Boolean(dirty),
    };
  } catch (error) {
    if (
      error instanceof Error &&
      'stderr' in error &&
      /not a git repository|does not have any commits yet|unknown revision|bad default revision/i.test(
        String(error.stderr),
      )
    )
      return { status: 'available', commit: null, committedAt: null, branch: null, dirty: true };
    const timeout = signal.aborted || Boolean(error && typeof error === 'object' && 'killed' in error && error.killed);
    return { status: 'unavailable', reason: timeout ? 'git_timeout' : 'git_error' };
  }
}
