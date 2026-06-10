import { loadDomains } from '../hub/eval-hub-read-model.js';
import { generateTaskOutcomeLiveVerdict } from '../task-outcome/eval-task-outcome-live-verdict.js';
import { TERMINAL_DONE_STATES } from '../task-outcome/task-outcome-episode.js';
import { resolveTaskOutcomeSourceWindow } from '../task-outcome/task-outcome-source-resolver.js';
import { type StoredEpisode, TaskOutcomeEpisodeStore } from '../task-outcome/task-outcome-store.js';
import type { TaskOutcomeSnapshotSourceRefs, VerdictGenerator } from './types.js';
import { isTaskOutcomeSourceRefs } from './validation.js';

const VERDICTABLE_TERMINAL_STATES = new Set<string>(TERMINAL_DONE_STATES);

export function createTaskOutcomeGeneratorAdapter(): VerdictGenerator {
  return async (packet, sourceRefs, deps) => {
    if (!isTaskOutcomeSourceRefs(sourceRefs)) {
      const kind = (sourceRefs as { kind?: string }).kind;
      throw new Error(
        `task_outcome_adapter_wrong_kind: received sourceRefs with kind='${kind ?? '(omitted)'}'; expected 'task-outcome-snapshot'`,
      );
    }

    const domains = loadDomains(deps.harnessFeedbackRoot);
    const domain = domains.get(packet.domainId);
    if (!domain) {
      throw new Error(`unknown_domain: ${packet.domainId} not in registry`);
    }

    const sourceWindow = resolveTaskOutcomeSourceWindow(sourceRefs, deps.liveHarnessFeedbackRoot, {
      ownerUserId: deps.ownerUserId,
      defaultTaskOutcomeDbPath: deps.taskOutcomeDbPath,
      defaultEventMemoryDbPath: deps.eventMemoryDbPath,
    });
    const artifact = generateTaskOutcomeLiveVerdict({
      verdictId: packet.id,
      harnessFeedbackRoot: deps.harnessFeedbackRoot,
      domain,
      sourceWindow,
      submittedPacket: packet,
    });
    const afterPublish = buildEpisodeVerdictWriteback(
      sourceRefs,
      sourceWindow.taskOutcomeDbPath,
      sourceWindow.episodes,
    );

    return {
      verdictPath: artifact.path,
      bundleDir: artifact.bundleDir,
      afterPublish,
    };
  };
}

function buildEpisodeVerdictWriteback(
  sourceRefs: TaskOutcomeSnapshotSourceRefs,
  taskOutcomeDbPath: string,
  episodes: StoredEpisode[],
): (() => void) | undefined {
  const episodeVerdicts = sourceRefs.episodeVerdicts;
  if (!episodeVerdicts || episodeVerdicts.length === 0) return undefined;

  const episodesById = new Map(episodes.map((episode) => [episode.episodeId, episode]));
  for (const writeback of episodeVerdicts) {
    const episode = episodesById.get(writeback.episodeId);
    if (!episode) {
      throw new Error(
        `invalid_episode_verdict_writeback: episodeId '${writeback.episodeId}' is not in the selected task-outcome window`,
      );
    }
    if (!VERDICTABLE_TERMINAL_STATES.has(episode.terminalState)) {
      throw new Error(
        `invalid_episode_verdict_writeback: episodeId '${writeback.episodeId}' is terminalState='${episode.terminalState}', expected one of ${[...VERDICTABLE_TERMINAL_STATES].join(', ')}`,
      );
    }
    if (episode.verdict !== null) {
      throw new Error(
        `invalid_episode_verdict_writeback: episodeId '${writeback.episodeId}' already has verdict='${episode.verdict}'; refusing to overwrite task-outcome audit history`,
      );
    }
  }

  return () => {
    const store = new TaskOutcomeEpisodeStore(taskOutcomeDbPath);
    const result = store.updateVerdictsIfPending(episodeVerdicts);
    if (!result.ok) {
      const reason =
        result.failure.current && result.failure.current.verdict !== null
          ? `already has verdict='${result.failure.current.verdict}'`
          : 'is no longer terminal and unverdicted';
      throw new Error(
        `invalid_episode_verdict_writeback: episodeId '${result.failure.episodeId}' ${reason}; refusing to overwrite task-outcome audit history`,
      );
    }
  };
}
