import { useState } from 'react';
import type {
  CollectiveMemberDirectory,
  CollectiveParticipant,
  CollectiveRoadmapRecord,
  CollectiveWorkProjection,
} from './client-types.js';
import type { SharedArtifact } from './collective-artifact-client.js';
import { useCollectiveLanguage } from './collective-copy.js';
import { type ProjectArtifactStatus, ProjectArtifactSummary } from './ProjectArtifactSurface.js';
import { AgentIdentityChip, HumanIdentityChip } from './ProjectIdentityChip.js';
import { formatWorkDate } from './project-time.js';
import { projectBoardColumn, worksForRoadmap } from './roadmap-view-model.js';
import { workBlockingPresentation } from './work-blocking-presentation.js';

type ProjectListFilter = 'active' | 'mine' | 'blocked';

export function ProjectList({
  roadmaps,
  works,
  artifacts = [],
  artifactStatus = 'ready',
  currentHumanId,
  humans,
  participants,
  humanNames,
  onOpen,
  onOpenArtifact,
}: {
  readonly roadmaps: readonly CollectiveRoadmapRecord[];
  readonly works: readonly CollectiveWorkProjection[];
  readonly artifacts?: readonly SharedArtifact[];
  readonly artifactStatus?: ProjectArtifactStatus;
  readonly currentHumanId: string;
  readonly humans: CollectiveMemberDirectory['humans'];
  readonly participants: readonly CollectiveParticipant[];
  readonly humanNames: Readonly<Record<string, string>>;
  readonly onOpen: (roadmap: CollectiveRoadmapRecord) => void;
  readonly onOpenArtifact?: (artifact: SharedArtifact) => void;
}) {
  const [filter, setFilter] = useState<ProjectListFilter>('active');
  const [owner, setOwner] = useState('all');
  const [showCompleted, setShowCompleted] = useState(false);
  const owned = roadmaps.filter((roadmap) => owner === 'all' || roadmap.accountableHumanId === owner);
  const active = owned.filter((roadmap) => roadmap.status === 'active');
  const mine = active.filter((roadmap) => projectRelatesToHuman(roadmap, works, currentHumanId));
  const blocked = active.filter((roadmap) => worksForRoadmap(roadmap, works).some((work) => work.status === 'blocked'));
  const displayed = filter === 'mine' ? mine : filter === 'blocked' ? blocked : active;
  const completed = owned.filter((roadmap) => roadmap.status === 'completed');
  return (
    <section className="project-list" aria-label="项目列表">
      <div className="project-list-toolbar">
        <nav aria-label="项目列表筛选">
          <FilterButton active={filter === 'active'} onClick={() => setFilter('active')}>
            {`进行中 ${active.length}`}
          </FilterButton>
          <FilterButton active={filter === 'mine'} onClick={() => setFilter('mine')}>
            {`与我相关 ${mine.length}`}
          </FilterButton>
          <FilterButton active={filter === 'blocked'} onClick={() => setFilter('blocked')}>
            {`有阻塞 ${blocked.length}`}
          </FilterButton>
        </nav>
        <div>
          <label className="project-list-owner-filter">
            <span>负责人</span>
            <select aria-label="按负责人筛选" value={owner} onChange={(event) => setOwner(event.currentTarget.value)}>
              <option value="all">所有人</option>
              {humans.map((human) => (
                <option key={human.humanId} value={human.humanId}>
                  {human.displayName}
                </option>
              ))}
            </select>
          </label>
          <details className="project-list-display-settings" aria-label="项目列表显示设置">
            <summary>显示设置</summary>
            <label>
              <input
                type="checkbox"
                aria-label="显示已完成项目"
                checked={showCompleted}
                onChange={(event) => setShowCompleted(event.currentTarget.checked)}
              />
              显示已完成项目
            </label>
          </details>
        </div>
      </div>
      <ProjectListColumns />
      {displayed.length === 0 && (
        <p className="project-list-empty">
          {roadmaps.length === 0 ? '还没有项目。用右上角“新建项目”留下第一项目标与完成标准。' : '当前筛选下没有项目。'}
        </p>
      )}
      {displayed.map((roadmap) => (
        <ProjectListRow
          key={roadmap.roadmapId}
          roadmap={roadmap}
          works={works}
          artifacts={artifacts}
          artifactStatus={artifactStatus}
          humans={humans}
          participants={participants}
          humanNames={humanNames}
          onOpen={onOpen}
          onOpenArtifact={onOpenArtifact}
        />
      ))}
      {showCompleted && completed.length > 0 && (
        <details className="project-list-completed" aria-label="已完成项目">
          <summary>已完成项目 {completed.length}</summary>
          <ProjectListColumns />
          {completed.map((roadmap) => (
            <ProjectListRow
              key={roadmap.roadmapId}
              roadmap={roadmap}
              works={works}
              artifacts={artifacts}
              artifactStatus={artifactStatus}
              humans={humans}
              participants={participants}
              humanNames={humanNames}
              onOpen={onOpen}
              onOpenArtifact={onOpenArtifact}
            />
          ))}
        </details>
      )}
    </section>
  );
}

function ProjectListColumns() {
  return (
    <header className="project-list-columns">
      <span>项目与完成标准</span>
      <span>负责人 · 执行</span>
      <span>任务</span>
      <span>阻塞 / 下一步</span>
      <span>最新作品</span>
    </header>
  );
}

function FilterButton({
  active,
  onClick,
  children,
}: {
  readonly active: boolean;
  readonly onClick: () => void;
  readonly children: string;
}) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick}>
      {children}
    </button>
  );
}

function ProjectListRow({
  roadmap,
  works,
  artifacts,
  artifactStatus,
  humans,
  participants,
  humanNames,
  onOpen,
  onOpenArtifact,
}: {
  readonly roadmap: CollectiveRoadmapRecord;
  readonly works: readonly CollectiveWorkProjection[];
  readonly artifacts: readonly SharedArtifact[];
  readonly artifactStatus: ProjectArtifactStatus;
  readonly humans: CollectiveMemberDirectory['humans'];
  readonly participants: readonly CollectiveParticipant[];
  readonly humanNames: Readonly<Record<string, string>>;
  readonly onOpen: (roadmap: CollectiveRoadmapRecord) => void;
  readonly onOpenArtifact?: (artifact: SharedArtifact) => void;
}) {
  const language = useCollectiveLanguage();
  const projectWorks = worksForRoadmap(roadmap, works);
  const blocked = projectWorks.filter((work) => work.status === 'blocked').length;
  const unassigned = projectWorks.filter((work) => work.status === 'unassigned').length;
  const next = projectNextCopy(roadmap, projectWorks, works, humanNames);
  const humanExecutors = uniqueHumanExecutors(projectWorks);
  const assignments = uniqueAssignments(projectWorks);
  const hasExecutors = humanExecutors.length > 0 || assignments.length > 0;
  return (
    <article className="project-list-row" data-project-id={roadmap.roadmapId}>
      <button
        type="button"
        className="project-list-open"
        aria-label={`打开项目 · ${roadmap.title}`}
        onClick={() => onOpen(roadmap)}
      >
        <span className="project-list-identity">
          <strong>{roadmap.title}</strong>
          <small>{roadmap.purpose}</small>
          {roadmap.targetDate && (
            <small>
              {language === 'en' ? 'Target' : '目标'} {formatWorkDate(roadmap.targetDate, language)} ·{' '}
              {roadmap.targetDate.actor.displayName}
              {language === 'en' ? '' : '定'}
            </small>
          )}
        </span>
        <span className="project-list-people">
          <HumanIdentityChip
            humanId={roadmap.accountableHumanId}
            humans={humans}
            fallbackName={humanNames[roadmap.accountableHumanId] ?? '共同体成员'}
            suffix="负责"
          />
          {humanExecutors.map((humanId) => (
            <HumanIdentityChip
              key={`executor:${humanId}`}
              humanId={humanId}
              humans={humans}
              fallbackName={humanNames[humanId] ?? '共同体成员'}
              suffix="执行"
            />
          ))}
          {assignments.map((assignment) => (
            <AgentIdentityChip
              key={`${assignment.connectionId}:${assignment.catId}`}
              assignment={assignment}
              participants={participants}
              suffix="执行"
            />
          ))}
          {!hasExecutors && <small>{projectWorks.length ? '由负责人推进或尚未分配' : '还没有任务'}</small>}
        </span>
        <span className="project-list-progress">
          <span className="project-progress-segments" aria-hidden="true">
            {projectWorks.map((work) => (
              <i key={work.workId} data-project-progress={projectBoardColumn(work)} />
            ))}
          </span>
          <strong>{projectWorks.length} 项</strong>
          <small>
            {projectWorks.filter((work) => work.lifecycle === 'completed').length} 完成
            {blocked ? ` · ${blocked} 阻塞` : ''}
            {unassigned ? ` · ${unassigned} 未分配` : ''}
          </small>
        </span>
        <span className="project-list-next" data-critical={next.critical || undefined}>
          <strong>{next.title}</strong>
          <small>{next.detail}</small>
        </span>
      </button>
      <div className="project-list-artifact-cell">
        <ProjectArtifactSummary
          works={projectWorks}
          artifacts={artifacts}
          status={artifactStatus}
          onOpen={onOpenArtifact}
        />
      </div>
    </article>
  );
}

function projectRelatesToHuman(
  roadmap: CollectiveRoadmapRecord,
  works: readonly CollectiveWorkProjection[],
  humanId: string,
) {
  if (roadmap.accountableHumanId === humanId) return true;
  return worksForRoadmap(roadmap, works).some(
    (work) => work.accountableHumanId === humanId || work.assignment?.humanId === humanId,
  );
}

function uniqueHumanExecutors(works: readonly CollectiveWorkProjection[]) {
  return [
    ...new Set(works.flatMap((work) => (!work.assignment && work.accountableHumanId ? [work.accountableHumanId] : []))),
  ];
}

function uniqueAssignments(works: readonly CollectiveWorkProjection[]) {
  const assignments = works.flatMap((work) => (work.assignment ? [work.assignment] : []));
  return [
    ...new Map(
      assignments.map((assignment) => [`${assignment.connectionId}:${assignment.catId}`, assignment]),
    ).values(),
  ];
}

function projectNextCopy(
  roadmap: CollectiveRoadmapRecord,
  projectWorks: readonly CollectiveWorkProjection[],
  availableWorks: readonly CollectiveWorkProjection[],
  humanNames: Readonly<Record<string, string>>,
) {
  if (roadmap.status === 'completed') {
    return { title: '项目已完成', detail: '查看已完成任务与动态', critical: false };
  }
  const blocked = projectWorks.find((work) => work.status === 'blocked');
  if (blocked) {
    const blocking = workBlockingPresentation(blocked, availableWorks);
    if (blocking?.kind === 'dependencies') {
      return {
        title: blocking.label,
        detail: `${blocked.title} 暂时不能继续`,
        critical: true,
      };
    }
    if (blocking?.kind === 'execution') {
      return {
        title: blocking.label,
        detail: `${blocked.title} · ${blocking.detail}`,
        critical: true,
      };
    }
    return {
      title: blocked.title,
      detail: blocking?.detail ?? '阻塞原因未填写',
      critical: true,
    };
  }
  const review = projectWorks.find((work) => work.lifecycle === 'result_ready');
  if (review) {
    const owner = review.accountableHumanId ? (humanNames[review.accountableHumanId] ?? '负责人') : '负责人';
    return { title: `等待 ${owner} 验收`, detail: review.title, critical: false };
  }
  const unassigned = projectWorks.find((work) => work.status === 'unassigned');
  if (unassigned) return { title: `${unassigned.title} 待指派`, detail: '还没有负责人', critical: true };
  const next = projectWorks.find((work) => work.lifecycle !== 'completed');
  if (next) return { title: next.title, detail: `下一次交付：${next.intendedOutcome}`, critical: false };
  return { title: '下一步未填写', detail: '这个项目还没有未完成任务', critical: false };
}
