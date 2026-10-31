import {
  CONTENT_MODIFICATION_CLOSURES,
  type ContentModificationCompletionRule,
  type ContentModificationRequest,
  REVIEW_IMAGE_RATIOS,
} from '@cat-cafe/shared';
import { ModificationScopeRecovery } from './ModificationScopeRecovery';
import type { ContentModificationModel } from './useContentModification';

export function ContentModificationForm({
  model,
  mediaType,
  rule,
}: {
  model: ContentModificationModel;
  mediaType?: string;
  rule: ContentModificationCompletionRule;
}) {
  const { draft, target, thread, busy } = model;
  const frozen = Boolean(draft.operation);
  const hasInstruction = Boolean(draft.body.trim() || draft.intent?.imageEdit);
  const canSubmit =
    model.ready &&
    !busy &&
    (frozen || Boolean(target && thread && !model.blocked && !model.sourceChanged && hasInstruction));
  const label = frozen ? '重试原修改请求' : `交给${target?.name ?? '所选猫'}修改`;
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        void model.submit();
      }}
    >
      <ModificationDestination model={model} frozen={frozen} />
      {mediaType?.startsWith('image/') ? <ModificationImageSettings model={model} disabled={frozen || busy} /> : null}
      {draft.intent?.selection ? (
        <p className="text-xs text-cafe-muted">
          {draft.intent.selection.kind === 'text_quote'
            ? `选中文本：${draft.intent.selection.quote.slice(0, 100)}`
            : '将按作品中选定的位置或视频范围修改。'}
        </p>
      ) : null}
      <label className="block text-xs text-cafe-muted">
        修改说明
        <textarea
          aria-label="修改说明"
          value={draft.body}
          maxLength={4000}
          rows={3}
          disabled={frozen || busy}
          onChange={(event) => model.edit({ body: event.target.value })}
          placeholder="说明希望保留什么、改变什么…"
          className="mt-1 w-full rounded border border-cafe-subtle bg-transparent p-2 text-sm text-cafe"
        />
      </label>
      <p className="text-xs leading-5 text-cafe-muted">{CONTENT_MODIFICATION_CLOSURES[rule]}。</p>
      <ModificationScopeRecovery model={model} />
      <button
        type="submit"
        data-testid="content-modification-submit"
        className="rounded-md bg-cafe-accent px-3 py-2 text-sm text-white"
        disabled={!canSubmit}
      >
        {busy ? '正在核对请求…' : label}
      </button>
    </form>
  );
}

function ModificationDestination({ model, frozen }: { model: ContentModificationModel; frozen: boolean }) {
  const { draft, choices, target, busy } = model;
  const disabled = frozen || busy || !choices || model.destinationLocked;
  return (
    <>
      <div className="grid grid-cols-1 gap-3 @[380px]:grid-cols-2">
        <label className="block text-xs text-cafe-muted">
          交给哪只猫
          <select
            aria-label="修改目标猫"
            value={draft.targetCatId}
            disabled={disabled}
            onChange={(event) => model.edit({ targetCatId: event.target.value })}
            className="mt-1 w-full rounded border border-cafe-subtle bg-transparent p-2 text-sm text-cafe"
          >
            <option value="">请选择一只猫</option>
            {draft.targetCatId && !target ? (
              <option value={draft.targetCatId} disabled>
                @{draft.targetCatId}（{choices ? '当前不可用' : '正在核对'}）
              </option>
            ) : null}
            {choices?.cats.map((cat) => {
              const unavailable = !cat.mcpSupport || cat.preflight?.disposition === 'rejected';
              return (
                <option key={cat.catId} value={cat.catId} disabled={unavailable}>
                  {cat.name}
                  {unavailable ? '（暂不可接收）' : ''}
                </option>
              );
            })}
          </select>
        </label>
        <label className="block text-xs text-cafe-muted">
          执行对话
          <select
            aria-label="修改执行对话"
            value={draft.threadId}
            disabled={disabled}
            onChange={(event) => model.edit({ threadId: event.target.value })}
            className="mt-1 w-full rounded border border-cafe-subtle bg-transparent p-2 text-sm text-cafe"
          >
            <option value="">请选择已有对话</option>
            {draft.threadId && !model.thread ? (
              <option value={draft.threadId} disabled>
                原执行对话（{choices ? '当前不可用' : '正在核对'}）
              </option>
            ) : null}
            {choices?.threads.map((item) => (
              <option key={item.threadId} value={item.threadId}>
                {item.title || '未命名对话'}
              </option>
            ))}
          </select>
        </label>
      </div>
      {target?.restrictions.length ? (
        <p className="text-xs text-cafe-muted">
          {target.name}的工作限制：{target.restrictions.join('；')}
        </p>
      ) : null}
      {choices && draft.threadId && !model.thread ? (
        <p role="alert" className="text-xs text-cafe-error">
          原执行对话当前不可用，选择与说明已保留。
        </p>
      ) : null}
      {target?.preflight?.disposition === 'warned' ? (
        <p className="text-xs text-cafe-muted">{target.name}的可用信息尚未确认；提交时会重新核对并保留这个目标。</p>
      ) : null}
      {model.blocked ? (
        <p role="alert" className="text-sm text-cafe-error">
          所选猫当前不能接收这个请求，尚未改派。
        </p>
      ) : null}
    </>
  );
}

function ModificationImageSettings({ model, disabled }: { model: ContentModificationModel; disabled: boolean }) {
  const { draft } = model,
    imageEdit = draft.intent?.imageEdit,
    selection = draft.intent?.selection;
  const setEdit = (edit: ContentModificationRequest['intent']['imageEdit']) => {
    const intent = { ...draft.intent };
    if (edit) intent.imageEdit = edit;
    else delete intent.imageEdit;
    model.edit({ intent });
  };
  const erase = () => {
    if (selection?.kind !== 'image-region') return;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- drops the selection kind; region keeps the box
    const { kind: _kind, ...region } = selection;
    setEdit({ kind: 'erase-region', region });
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <label>
        输出比例{' '}
        <select
          aria-label="请求图片比例"
          disabled={disabled}
          value={imageEdit?.kind === 'aspect-ratio' ? imageEdit.ratio : ''}
          className="rounded border border-cafe-subtle bg-transparent p-1"
          onChange={(event) => {
            const ratio = REVIEW_IMAGE_RATIOS.find((value) => value === event.target.value);
            setEdit(ratio ? { kind: 'aspect-ratio', ratio } : undefined);
          }}
        >
          <option value="">保持原比例</option>
          {REVIEW_IMAGE_RATIOS.map((ratio) => (
            <option key={ratio}>{ratio}</option>
          ))}
        </select>
      </label>
      {selection?.kind === 'image-region' ? (
        <button
          type="button"
          disabled={disabled}
          className="rounded border border-cafe-subtle px-2 py-1"
          onClick={erase}
        >
          移除圈选内容
        </button>
      ) : null}
      {imageEdit?.kind === 'erase-region' ? <span>将移除圈选区域并补全背景</span> : null}
    </div>
  );
}
