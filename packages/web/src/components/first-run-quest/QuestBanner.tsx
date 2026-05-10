'use client';

const QUEST_STEP_LABELS: Record<string, string> = {
  'quest-0-welcome': '欢迎',
  'quest-1-create-first-cat': '创建猫猫',
  'quest-2-cat-intro': '猫猫自我介绍',
  'quest-3-task-select': '选择任务',
  'quest-4-task-running': '执行任务中',
  'quest-5-error-encountered': '发现问题',
  'quest-6-second-cat-prompt': '添加监督猫',
  'quest-7-second-cat-created': '第二只猫就位',
  'quest-8-collaboration-demo': '多猫协作',
  'quest-9-completion': '教程完成',
};

const TOTAL_STEPS = 10;

interface QuestBannerProps {
  phase: string;
  firstCatName?: string;
  onAddSecondCat?: () => void;
  onStartBootcamp?: () => void;
  onComplete?: () => void;
}

export function QuestBanner({ phase, firstCatName, onAddSecondCat, onStartBootcamp, onComplete }: QuestBannerProps) {
  const stepIndex = parseInt(phase.split('-')[1] ?? '0', 10);
  const progress = Math.min(((stepIndex + 1) / TOTAL_STEPS) * 100, 100);
  const label = QUEST_STEP_LABELS[phase] ?? phase;
  const isErrorPhase = phase === 'quest-5-error-encountered' || phase === 'quest-6-second-cat-prompt';
  const isComplete = phase === 'quest-9-completion';

  return (
    <div className="mx-4 mb-3 rounded-xl border border-conn-amber-ring bg-conn-amber-bg/80 px-4 py-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-conn-amber-text">新手教程</span>
        <span className="text-xs text-conn-amber-text">{label}</span>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-conn-amber-bg">
        <div
          className="h-full rounded-full bg-conn-amber-bg transition-all duration-500"
          style={{ width: `${progress}%` }}
        />
      </div>

      {phase === 'quest-2-cat-intro' && (
        <div className="mt-2 space-y-2">
          <p className="text-xs text-conn-amber-text">
            在下方输入框 @{firstCatName ?? '猫猫'} 打个招呼，让它自我介绍一下吧！
          </p>
          <p className="text-xs text-conn-amber-text">
            打完招呼后，可以开始新手训练营，跟着 {firstCatName ?? '猫猫'} 完成第一个协作任务。
          </p>
          {onStartBootcamp && (
            <button
              type="button"
              onClick={onStartBootcamp}
              className="rounded-lg bg-conn-amber-text px-3 py-1.5 text-sm font-medium text-[var(--cafe-surface)] transition hover:opacity-90"
            >
              开始新手训练营
            </button>
          )}
        </div>
      )}

      {phase === 'quest-3-task-select' && (
        <p className="mt-2 text-xs text-conn-amber-text">
          {'试着给 '}
          {firstCatName ?? '猫猫'}
          {' 派一个简单任务，比如「帮我写一个 hello world」。'}
        </p>
      )}

      {phase === 'quest-4-task-running' && (
        <p className="mt-2 text-xs text-conn-amber-text">{firstCatName ?? '猫猫'} 正在执行任务，请耐心等待...</p>
      )}

      {isErrorPhase && (
        <div className="mt-3 rounded-lg border border-conn-amber-ring bg-conn-amber-bg p-3">
          <p className="text-sm text-conn-amber-text">
            {firstCatName ?? '猫猫'} 遇到了一些问题！在真实团队中，我们会让另一只猫猫来帮忙 review。
          </p>
          {onAddSecondCat && (
            <button
              type="button"
              onClick={onAddSecondCat}
              className="mt-2 rounded-lg bg-conn-amber-text px-3 py-1.5 text-sm font-medium text-[var(--cafe-surface)] transition hover:opacity-90"
            >
              再来一只猫猫！
            </button>
          )}
        </div>
      )}

      {isComplete && (
        <div className="mt-3 rounded-lg border border-conn-emerald-ring bg-conn-emerald-bg p-3">
          <p className="text-sm text-conn-emerald-text">恭喜！你已掌握了多猫协作的基本技能。</p>
          {onComplete && (
            <button
              type="button"
              onClick={onComplete}
              className="mt-2 rounded-lg bg-conn-emerald-text px-3 py-1.5 text-sm font-medium text-[var(--cafe-surface)] transition hover:bg-conn-emerald-text"
            >
              前往 Console 管理更多猫猫
            </button>
          )}
        </div>
      )}
    </div>
  );
}
