import type { ReactNode } from 'react';
import type {
  LeaveReadinessArtifact,
  LeaveReadinessProject,
  LeaveReadinessWork,
  MembershipLeaveReadiness,
} from './leave-readiness.js';

export function LeaveResponsibilityGroups({
  readiness,
  onOpenWork,
  onOpenProject,
  onOpenArtifact,
  onOpenMembers,
}: {
  readonly readiness: MembershipLeaveReadiness;
  readonly onOpenWork: (work: LeaveReadinessWork) => void;
  readonly onOpenProject: (project: LeaveReadinessProject) => void;
  readonly onOpenArtifact: (artifact: Extract<LeaveReadinessArtifact, { kind: 'artifact' }>) => void;
  readonly onOpenMembers: () => void;
}) {
  const { works, roadmaps, artifacts } = readiness.responsibilities;
  const knownCount =
    Number(readiness.governanceHandoffRequired) +
    works.length +
    roadmaps.length +
    artifacts.items.length +
    artifacts.inaccessibleCount;
  return (
    <div className="leave-responsibility-groups">
      {readiness.governanceHandoffRequired && (
        <ResponsibilityGroup title="管理员">
          <div className="leave-responsibility-static">
            <strong>你是这个共同体的管理员</strong>
            <small>要先把管理员交给别人才能离开。交接管理员现在还没有入口。</small>
          </div>
        </ResponsibilityGroup>
      )}
      {works.length > 0 && (
        <ResponsibilityGroup
          title={`你负责的任务 ${works.length}`}
          description="可以完成、取消，或在那里请别人接手负责。"
        >
          {works.map((work) => (
            <div className="leave-responsibility-row" key={work.workId}>
              <span className="leave-status-dot" data-tone={workStatusTone(work.status)} aria-hidden="true" />
              <span className="leave-responsibility-copy">
                <strong title={work.title}>{work.title}</strong>
                <small>
                  {workProjectLabel(work)} · # {work.source.location.channelId} · {workStatusLabel(work.status)}
                </small>
              </span>
              <button type="button" onClick={() => onOpenWork(work)}>
                去处理 ›
              </button>
            </div>
          ))}
        </ResponsibilityGroup>
      )}
      {roadmaps.length > 0 && (
        <ResponsibilityGroup title={`你负责的项目 ${roadmaps.length}`}>
          {roadmaps.map((project) => (
            <div className="leave-responsibility-row" key={project.roadmapId}>
              <span className="leave-status-dot" data-tone="info" aria-hidden="true" />
              <span className="leave-responsibility-copy">
                <strong title={project.title}>{project.title}</strong>
                <small># {project.source.location.channelId} · 进行中</small>
              </span>
              <button type="button" onClick={() => onOpenProject(project)}>
                去项目 ›
              </button>
            </div>
          ))}
        </ResponsibilityGroup>
      )}
      {(artifacts.items.length > 0 || artifacts.inaccessibleCount > 0) && (
        <ResponsibilityGroup
          title={`你家保管的作品 ${artifacts.items.length + artifacts.inaccessibleCount}`}
          description={
            artifacts.items.some((item) => item.kind === 'artifact')
              ? '打开作品后，可在「权限与保管」里交接给别人的 Café。'
              : undefined
          }
        >
          {artifacts.items.map((item) =>
            item.kind === 'artifact' ? (
              <div className="leave-responsibility-row leave-responsibility-row-no-status" key={item.artifactId}>
                <span className="leave-responsibility-copy">
                  <strong title={item.title}>
                    {item.title} · 第 {item.ownerRevision} 版
                  </strong>
                  <small>在 # {item.source.location.channelId} · 原件在你的 Café</small>
                </span>
                <button type="button" onClick={() => onOpenArtifact(item)}>
                  去作品 ›
                </button>
              </div>
            ) : (
              <div className="leave-responsibility-static" key={item.publicationId}>
                <strong>《{item.title}》正在发布</strong>
                <small>发布结束后重新检查；若原件仍在你的 Café，还需处理保管责任。</small>
              </div>
            ),
          )}
          {artifacts.inaccessibleCount > 0 && (
            <div className="leave-responsibility-hidden">
              <LockIcon />
              <span>
                <strong>还有 {artifacts.inaccessibleCount} 件你现在打不开</strong>
                <small>它们也要先处理；可以请管理员看看。</small>
              </span>
              <button type="button" onClick={onOpenMembers}>
                查看管理员
              </button>
            </div>
          )}
        </ResponsibilityGroup>
      )}
      {knownCount === 0 && (
        <output className="leave-dialog-unknown">还有责任没有完整显示。请重新检查，确认完整结果后才能离开。</output>
      )}
    </div>
  );
}

function ResponsibilityGroup({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="leave-responsibility-group">
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      <div>{children}</div>
    </section>
  );
}

function workProjectLabel(work: LeaveReadinessWork): string {
  if (work.projects.length === 0) return '未归入项目';
  if (work.projects.length === 1) return work.projects[0]?.title ?? '未归入项目';
  return `${work.projects.length} 个项目`;
}

const workLabels: Record<LeaveReadinessWork['status'], string> = {
  proposed: '等待确认',
  unassigned: '待指派',
  ready: '可以开始',
  blocked: '等待前置任务',
  in_progress: '进行中',
  result_ready: '结果待确认',
  completed: '已完成',
  declined: '不跟踪',
  cancelled: '已取消',
};

function workStatusLabel(status: LeaveReadinessWork['status']): string {
  return workLabels[status];
}

function workStatusTone(status: LeaveReadinessWork['status']): 'info' | 'warning' | 'critical' | 'success' {
  if (status === 'blocked') return 'critical';
  if (status === 'proposed' || status === 'unassigned' || status === 'result_ready') return 'warning';
  if (status === 'completed') return 'success';
  return 'info';
}

function LockIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}
