import { RepairPanel } from './candidate-card';
import { outputs, SOURCE_HANDLE } from './preview-data';

export function CurrentMeetingCard({ repair }: { repair: boolean }) {
  return (
    <article
      className="mx-auto max-w-3xl space-y-3 rounded-xl border border-cafe bg-cafe-surface p-4"
      data-testid="f305-current-card"
    >
      <header className="flex items-center gap-2">
        <span className="rounded-md bg-[var(--semantic-info)] px-1.5 py-0.5 text-micro font-medium text-[var(--cafe-accent-foreground)]">
          会议
        </span>
        <span className="text-micro font-medium text-cafe-secondary">等你确认</span>
        <span className="ml-auto text-micro text-cafe-secondary">rev 1</span>
      </header>
      <div>
        <h2 className="text-sm font-semibold">整理会议：模型质量周会</h2>
        <p className="mt-1 truncate text-micro text-cafe-secondary">{SOURCE_HANDLE}</p>
      </div>
      {repair && <RepairPanel />}
      {!repair && (
        <div className="space-y-3">
          <label className="block text-micro font-medium">
            说话人映射
            <textarea
              defaultValue={'1=You\n2=砚砚\n3=宪宪'}
              rows={3}
              className="mt-1 w-full rounded-md border border-cafe bg-cafe-surface p-2 text-sm"
              data-testid="meeting-speakers"
            />
          </label>
          <label className="block text-micro font-medium">
            会议背景
            <textarea
              defaultValue="复盘本周模型质量变化，确认需要继续观察的问题和负责人。"
              rows={3}
              className="mt-1 w-full rounded-md border border-cafe bg-cafe-surface p-2 text-sm"
            />
          </label>
          <label className="block text-micro font-medium">
            保存位置
            <input
              defaultValue="模型质量专项"
              className="mt-1 w-full rounded-md border border-cafe bg-cafe-surface p-2 text-sm"
            />
          </label>
          <fieldset className="flex flex-wrap gap-2">
            <legend className="mb-1 text-micro font-medium">要生成的内容</legend>
            {outputs.map((output, index) => (
              <label key={output} className="flex items-center gap-1.5 text-micro">
                <input type="checkbox" defaultChecked={index !== 2} />
                {output}
              </label>
            ))}
          </fieldset>
          <button
            type="button"
            className="rounded-md bg-[var(--semantic-success)] px-3 py-1.5 text-micro font-medium text-[var(--cafe-accent-foreground)]"
          >
            投递给猫猫整理
          </button>
        </div>
      )}
      <div className="flex justify-between gap-2">
        <button type="button" className="rounded-md border border-cafe px-3 py-1.5 text-micro">
          这次不用整理
        </button>
      </div>
    </article>
  );
}
