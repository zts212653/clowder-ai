import { type FormEvent, useState } from 'react';
import type { CollectiveMemberDirectory, CollectiveRoadmapRecord } from './client-types.js';
import type { ProjectTaskResponsibility } from './use-collective-collaboration.js';

type CreateProjectTask = (
  roadmap: CollectiveRoadmapRecord,
  channelId: string,
  title: string,
  intendedOutcome: string,
  responsibility: ProjectTaskResponsibility,
) => Promise<void>;

export function NewProjectTaskControl({
  roadmap,
  channelId,
  currentHumanId,
  humans,
  onCreate,
}: {
  readonly roadmap: CollectiveRoadmapRecord;
  readonly channelId: string;
  readonly currentHumanId: string;
  readonly humans: CollectiveMemberDirectory['humans'];
  readonly onCreate?: CreateProjectTask;
}) {
  return (
    <ProjectTaskControl
      roadmaps={[roadmap]}
      channelId={channelId}
      currentHumanId={currentHumanId}
      humans={humans}
      onCreate={onCreate}
      showProjectPicker={false}
    />
  );
}

export function NewWorkspaceTaskControl({
  roadmaps,
  channelId,
  currentHumanId,
  humans,
  onCreate,
}: {
  readonly roadmaps: readonly CollectiveRoadmapRecord[];
  readonly channelId: string;
  readonly currentHumanId: string;
  readonly humans: CollectiveMemberDirectory['humans'];
  readonly onCreate?: CreateProjectTask;
}) {
  return (
    <ProjectTaskControl
      roadmaps={roadmaps}
      channelId={channelId}
      currentHumanId={currentHumanId}
      humans={humans}
      onCreate={onCreate}
      showProjectPicker
    />
  );
}

function ProjectTaskControl({
  roadmaps,
  channelId,
  currentHumanId,
  humans,
  onCreate,
  showProjectPicker,
}: {
  readonly roadmaps: readonly CollectiveRoadmapRecord[];
  readonly channelId: string;
  readonly currentHumanId: string;
  readonly humans: CollectiveMemberDirectory['humans'];
  readonly onCreate?: CreateProjectTask;
  readonly showProjectPicker: boolean;
}) {
  const eligible = roadmaps.filter(
    (roadmap) => roadmap.status === 'active' && roadmap.accountableHumanId === currentHumanId,
  );
  const [open, setOpen] = useState(false);
  const [roadmapId, setRoadmapId] = useState(eligible[0]?.roadmapId ?? '');
  const [title, setTitle] = useState('');
  const [outcome, setOutcome] = useState('');
  const [responsibility, setResponsibility] = useState('unassigned');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const roadmap = eligible.find((candidate) => candidate.roadmapId === roadmapId) ?? eligible[0];
  if (!onCreate || !roadmap) return null;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const nextTitle = title.trim();
    const nextOutcome = outcome.trim();
    if (!nextTitle || !nextOutcome || submitting) return;
    const selection: ProjectTaskResponsibility =
      responsibility === 'self'
        ? { accountability: 'self' }
        : responsibility === 'unassigned'
          ? { accountability: 'unassigned' }
          : { accountability: 'unassigned', requestedAccountableHumanId: responsibility };
    setSubmitting(true);
    setError(undefined);
    try {
      await onCreate(roadmap, channelId, nextTitle, nextOutcome, selection);
      setTitle('');
      setOutcome('');
      setResponsibility('unassigned');
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作尚未确认，请重试。');
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <div className="project-authoring-control project-task-authoring-control">
      <button type="button" className="project-primary-action" aria-expanded={open} onClick={() => setOpen(!open)}>
        新建任务
      </button>
      {open && (
        <form className="project-authoring-form project-task-authoring-form" onSubmit={(event) => void submit(event)}>
          {showProjectPicker && eligible.length > 1 && (
            <label>
              <span>项目</span>
              <select
                aria-label="任务所属项目"
                value={roadmap.roadmapId}
                onChange={(event) => setRoadmapId(event.currentTarget.value)}
              >
                {eligible.map((candidate) => (
                  <option key={candidate.roadmapId} value={candidate.roadmapId}>
                    {candidate.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            <span>任务名称</span>
            <input
              aria-label="任务名称"
              value={title}
              maxLength={200}
              onChange={(event) => setTitle(event.currentTarget.value)}
            />
          </label>
          <label>
            <span>完成标准</span>
            <textarea
              aria-label="任务完成标准"
              value={outcome}
              maxLength={32_000}
              rows={3}
              onChange={(event) => setOutcome(event.currentTarget.value)}
            />
          </label>
          <label>
            <span>负责人</span>
            <select
              aria-label="任务负责人"
              value={responsibility}
              onChange={(event) => setResponsibility(event.currentTarget.value)}
            >
              <option value="unassigned">待指派</option>
              <option value="self">我负责</option>
              {humans
                .filter((human) => human.humanId !== currentHumanId)
                .map((human) => (
                  <option key={human.humanId} value={human.humanId}>
                    邀请 {human.displayName} 负责
                  </option>
                ))}
            </select>
          </label>
          {responsibility !== 'self' && responsibility !== 'unassigned' && (
            <p className="project-authoring-note">任务先保持待指派；对方接受邀请后才会成为负责人。</p>
          )}
          {error && <p role="alert">{error}</p>}
          <div className="project-authoring-actions">
            <button type="button" onClick={() => setOpen(false)}>
              取消
            </button>
            <button type="submit" className="project-primary-action" disabled={submitting}>
              {submitting ? '正在创建…' : '创建任务'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
