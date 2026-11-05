import type { RequestGenerationGapV1, RequestGenerationProjectionV1 } from '@cat-cafe/shared';
import { deploymentDefaults } from '@cat-cafe/shared';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import { TrajectoryId } from './TrajectoryId';
import { trajectoryInputCopy } from './trajectory-input.shell-copy';
import { useTrajectoryCopy } from './use-trajectory-copy';

const STATE_LABEL = {
  available: '可展开',
  redacted: '默认遮蔽',
  deleted: '来源已删除',
  unknown: '来源未能核验',
  unsupported: 'Provider 不支持',
} as const;

function shortDigest(value: string | undefined): string {
  if (!value) return '未报告';
  const [, digest = value] = value.split(':', 2);
  return `${digest.slice(0, 10)}…`;
}

function channelLabel(channel: RequestGenerationProjectionV1['envelope']['channels'][number]['channel']): string {
  if (channel === 'message') return '提交消息';
  if (channel === 'native_instruction') return '原生系统指令';
  return 'Provider 内部视野';
}

function Generation({ generation }: { generation: RequestGenerationProjectionV1 }) {
  const isV2 = useShellPresentation() === 'v2';
  const t = useTrajectoryCopy(trajectoryInputCopy);
  const { envelope } = generation;
  const runtime = envelope.runtime.requested;
  return (
    <article
      className={
        isV2
          ? 'min-w-0 break-words rounded-xl border border-cafe-subtle bg-cafe-surface p-3'
          : 'rounded-xl border border-cafe-subtle bg-cafe-surface p-3'
      }
      data-generation-ordinal={envelope.generationOrdinal}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className={isV2 ? 'min-w-0 flex-1' : undefined}>
          <h4 className="text-xs font-semibold text-cafe-primary">
            {isV2 ? t.submission(envelope.generationOrdinal) : `Generation #${envelope.generationOrdinal}`}
          </h4>
          {isV2 ? (
            <TrajectoryId kind="会话" value={envelope.sessionId} />
          ) : (
            <p className="mt-0.5 font-mono text-micro text-cafe-muted">Session {envelope.sessionId}</p>
          )}
        </div>
        <span className="rounded-full border border-cafe px-2 py-0.5 text-micro text-cafe-secondary">
          {generation.terminal
            ? isV2
              ? t.terminal(generation.terminal.outcome)
              : generation.terminal.outcome
            : generation.observed
              ? isV2
                ? t.observed
                : 'observed'
              : isV2
                ? t.assembled
                : 'assembled'}
        </span>
      </div>

      <dl
        className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-micro sm:grid-cols-4"
        style={isV2 ? { gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 120px), 1fr))' } : undefined}
      >
        <div>
          <dt className="text-cafe-muted">{isV2 ? t.provider : 'Provider / carrier'}</dt>
          <dd className="text-cafe-secondary">
            {runtime.provider} / {runtime.carrier}
          </dd>
        </div>
        <div>
          <dt className="text-cafe-muted">{isV2 ? t.model : 'Model'}</dt>
          <dd className="text-cafe-secondary">
            {generation.observed?.evidence.model ?? runtime.model ?? t.unknownModel}
          </dd>
        </div>
        <div>
          <dt className="text-cafe-muted">{isV2 ? t.continuity : 'Continuity'}</dt>
          <dd className="text-cafe-secondary">
            {isV2 ? (
              t.contextValue(
                envelope.continuity.mode ?? envelope.continuity.capability,
                envelope.continuity.contextEpoch,
              )
            ) : (
              <>
                {envelope.continuity.mode ?? envelope.continuity.capability}
                {envelope.continuity.contextEpoch === undefined ? '' : ` · epoch ${envelope.continuity.contextEpoch}`}
              </>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-cafe-muted">{isV2 ? t.boundary : 'Boundary'}</dt>
          <dd className="text-cafe-secondary">
            {envelope.retryBoundary.reason
              ? isV2
                ? t.retryReasons[envelope.retryBoundary.reason]
                : envelope.retryBoundary.reason
              : isV2
                ? t.initial
                : 'initial'}
          </dd>
        </div>
      </dl>

      <div className="mt-3 space-y-2">
        {envelope.channels.map((channel, index) => (
          <div
            key={`${channel.channel}-${index}`}
            className="rounded-lg border border-cafe-subtle bg-cafe-surface-canvas px-2.5 py-2"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 text-micro">
              <span className="font-semibold text-cafe-secondary">
                {isV2
                  ? { message: t.message, native_instruction: t.instruction, provider_native_hidden: t.hidden }[
                      channel.channel
                    ]
                  : channelLabel(channel.channel)}
              </span>
              <span className="text-cafe-muted">{isV2 ? t[channel.state] : STATE_LABEL[channel.state]}</span>
            </div>
            <p className="mt-1 text-micro text-cafe-muted">
              {isV2 ? (
                t.channelSummary(
                  channel.byteLength,
                  channel.keyedContentDigest ? shortDigest(channel.keyedContentDigest) : t.unreported,
                  channel.injectionDecision,
                )
              ) : (
                <>
                  {channel.byteLength === undefined
                    ? isV2
                      ? t.byteUnknown
                      : 'bytes 未报告'
                    : isV2
                      ? t.bytes(channel.byteLength)
                      : `${channel.byteLength} bytes`}{' '}
                  · {isV2 ? t.digest : 'digest'}{' '}
                  <span className="font-mono">
                    {channel.keyedContentDigest ? shortDigest(channel.keyedContentDigest) : t.unreported}
                  </span>
                  {channel.injectionDecision ? ` · ${channel.injectionDecision}` : ''}
                </>
              )}
            </p>
            {channel.state === 'available' && channel.body !== undefined && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs font-semibold text-cafe-accent">{t.expand}</summary>
                <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-cafe-surface p-2 text-micro text-cafe-secondary">
                  {channel.body}
                </pre>
              </details>
            )}
            {channel.state === 'unknown' && (
              <p className="mt-2 text-micro text-cafe-muted">
                {isV2 ? t.sourceUnknown : 'Source owner 或版本当前无法核验；没有猜成可见、已删除或 Provider 未支持。'}
              </p>
            )}
          </div>
        ))}
      </div>

      <p className="mt-2 text-micro text-cafe-muted">
        {isV2 ? (
          t.toolsSummary(
            t.toolStates[envelope.tools.finalSurface],
            envelope.tools.catCafeSchemaSetHash ? shortDigest(envelope.tools.catCafeSchemaSetHash) : t.unreported,
            envelope.tools.declaredServerSetHash ? shortDigest(envelope.tools.declaredServerSetHash) : t.unreported,
            envelope.tools.providerObservedSchemaSetHash
              ? shortDigest(envelope.tools.providerObservedSchemaSetHash)
              : t.unreported,
          )
        ) : (
          <>
            {'Tools'}: {envelope.tools.finalSurface} · {`${deploymentDefaults.brand.displayName} schemas`}:{' '}
            <span className="font-mono">
              {envelope.tools.catCafeSchemaSetHash ? shortDigest(envelope.tools.catCafeSchemaSetHash) : t.unreported}
            </span>{' '}
            · Declared servers:{' '}
            <span className="font-mono">
              {envelope.tools.declaredServerSetHash ? shortDigest(envelope.tools.declaredServerSetHash) : t.unreported}
            </span>{' '}
            · Provider observed:{' '}
            <span className="font-mono">
              {envelope.tools.providerObservedSchemaSetHash
                ? shortDigest(envelope.tools.providerObservedSchemaSetHash)
                : t.unreported}
            </span>
          </>
        )}
      </p>
      <p className="mt-1 text-micro text-cafe-muted">
        {isV2 ? (
          t.materialCounts(
            envelope.continuity.compactionRefs.length,
            envelope.presentations.filter((item) => item.decision === 'admitted').length,
            envelope.presentations.filter((item) => item.decision === 'omitted').length,
          )
        ) : (
          <>
            {'Compactions'}: {envelope.continuity.compactionRefs.length} · Presentations:{' '}
            {envelope.presentations.filter((item) => item.decision === 'admitted').length} admitted /{' '}
            {envelope.presentations.filter((item) => item.decision === 'omitted').length} {'omitted'}
          </>
        )}
      </p>
    </article>
  );
}

export function RequestGenerationSection({
  generations,
  gaps,
  loading,
  error,
  revealing,
  onReveal,
}: {
  generations: readonly RequestGenerationProjectionV1[] | null;
  gaps: readonly RequestGenerationGapV1[];
  loading: boolean;
  error: boolean;
  revealing: boolean;
  onReveal: () => void;
}) {
  const isV2 = useShellPresentation() === 'v2';
  const t = useTrajectoryCopy(trajectoryInputCopy);
  const hasRevealable = generations?.some(({ envelope }) =>
    envelope.channels.some((channel) => channel.state === 'redacted' || channel.state === 'unknown'),
  );
  return (
    <section className="rounded-xl border border-cafe-subtle p-3" data-testid="request-generation-section">
      <div
        className={
          isV2 ? 'flex flex-wrap items-center justify-between gap-3' : 'flex items-center justify-between gap-3'
        }
      >
        <div>
          <h3 className="text-sm font-semibold text-cafe-primary">{isV2 ? t.title : 'Input generations'}</h3>
          <p className="mt-0.5 text-micro text-cafe-muted">
            {isV2
              ? t.description
              : `${deploymentDefaults.brand.displayName} 实际组装并提交的每一代输入；默认只显示摘要。`}
          </p>
        </div>
        {hasRevealable && (
          <button
            type="button"
            onClick={onReveal}
            disabled={revealing}
            className="shrink-0 rounded-lg border border-cafe px-2.5 py-1.5 text-xs font-semibold text-cafe-secondary disabled:opacity-60"
          >
            {revealing ? t.revealing : t.reveal}
          </button>
        )}
      </div>
      {loading ? (
        <p className="mt-3 text-xs text-cafe-muted">{isV2 ? t.loading : '读取 request envelope…'}</p>
      ) : error ? (
        <p className="mt-3 text-xs text-cafe-muted">{isV2 ? t.error : 'Request envelope 当前不可用。'}</p>
      ) : (!generations || generations.length === 0) && gaps.length === 0 ? (
        <p className="mt-3 text-xs text-cafe-muted">
          {isV2 ? t.empty : '这轮没有 canonical request-generation 证据。'}
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          {gaps.map((gap) => (
            <article
              key={`${gap.fromOrdinal}-${gap.toOrdinal}`}
              className="rounded-xl border border-cafe-subtle bg-cafe-surface p-3"
              data-testid="request-generation-gap"
            >
              <h4 className="text-xs font-semibold text-cafe-primary">
                {isV2 ? (
                  t.gap(gap.fromOrdinal, gap.toOrdinal)
                ) : (
                  <>
                    {'Generation evidence gap #'}
                    {gap.fromOrdinal}
                    {gap.toOrdinal === gap.fromOrdinal ? '' : `–${gap.toOrdinal}`}
                  </>
                )}
              </h4>
              <p className="mt-1 text-micro text-cafe-muted">
                {isV2 ? (
                  t.gapHint
                ) : (
                  <>
                    可见 Session chain 中缺少这段 generation 证据；其余 generations
                    仍按各自证据展示，未把缺口猜成“没有发生”。
                  </>
                )}
              </p>
            </article>
          ))}
          {(generations ?? []).map((generation) => (
            <Generation key={generation.envelope.requestGenerationId} generation={generation} />
          ))}
        </div>
      )}
    </section>
  );
}
