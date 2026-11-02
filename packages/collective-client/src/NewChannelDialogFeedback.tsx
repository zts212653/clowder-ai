import { COLLECTIVE_CHANNEL_NAME_MAX, collectiveChannelNameIssue } from '@cat-cafe/shared';
import { CollectiveClientRequestError } from './client-request.js';
import { useCollectiveLanguage, useCollectiveText } from './collective-copy.js';

export type SubmissionPhase = 'idle' | 'submitting' | 'failed' | 'forbidden' | 'limit' | 'signed-out';

export function ChannelNameFeedback({
  existing,
  issue,
  onSelect,
  onClose,
}: {
  readonly existing?: string;
  readonly issue: ReturnType<typeof collectiveChannelNameIssue>;
  readonly onSelect: (channelId: string) => void;
  readonly onClose: () => void;
}) {
  const t = useCollectiveText();
  const language = useCollectiveLanguage();
  if (existing) {
    return (
      <p className="new-channel-field-error">
        {language === 'en' ? `#${existing} already exists · ` : `已经有 # ${existing} 了 · `}
        <button
          type="button"
          onClick={() => {
            onSelect(existing);
            onClose();
          }}
        >
          {t('去这个频道')}
        </button>
      </p>
    );
  }
  if (issue === 'too_long') {
    return (
      <p className="new-channel-field-error">
        {language === 'en'
          ? `Use ${COLLECTIVE_CHANNEL_NAME_MAX} characters or fewer.`
          : `频道名最多 ${COLLECTIVE_CHANNEL_NAME_MAX} 个字。`}
      </p>
    );
  }
  if (issue === 'invalid_characters') {
    return <p className="new-channel-field-error">{t('频道名不能包含 #、斜杠或换行')}</p>;
  }
  return null;
}

export function SubmissionFeedback({
  phase,
  language,
  collectiveName,
}: {
  readonly phase: SubmissionPhase;
  readonly language: 'zh' | 'en';
  readonly collectiveName: string;
}) {
  if (phase === 'idle' || phase === 'submitting') return null;
  return (
    <p className="new-channel-submit-error" role="alert">
      {channelFailureMessage(phase, language, collectiveName)}
    </p>
  );
}

export function ChannelDialogFooter({
  phase,
  createDisabled,
  onClose,
}: {
  readonly phase: SubmissionPhase;
  readonly createDisabled: boolean;
  readonly onClose: () => void;
}) {
  const t = useCollectiveText();
  if (isTerminalSubmissionPhase(phase)) {
    return (
      <footer>
        <button type="button" className="primary" onClick={onClose}>
          {t('关闭')}
        </button>
      </footer>
    );
  }
  const submitting = phase === 'submitting';
  return (
    <footer>
      <button type="button" disabled={submitting} onClick={onClose}>
        {t('取消')}
      </button>
      <button type="submit" className="primary" disabled={createDisabled || submitting}>
        {submitting ? t('正在新建…') : phase === 'failed' ? t('重试') : t('新建')}
      </button>
    </footer>
  );
}

export function isTerminalSubmissionPhase(phase: SubmissionPhase): boolean {
  return phase === 'forbidden' || phase === 'limit' || phase === 'signed-out';
}

export function channelFailurePhase(error: unknown): SubmissionPhase {
  if (!(error instanceof CollectiveClientRequestError)) return 'failed';
  if (error.status === 401) return 'signed-out';
  if (error.status === 403) return 'forbidden';
  if (error.code === 'CHANNEL_LIMIT_REACHED') return 'limit';
  return 'failed';
}

function channelFailureMessage(
  phase: Exclude<SubmissionPhase, 'idle' | 'submitting'>,
  language: 'zh' | 'en',
  collectiveName: string,
) {
  if (phase === 'forbidden') {
    return language === 'en'
      ? 'You no longer have permission to create channels. Only stewards can.'
      : '你现在没有新建频道的权限，只有管理员可以';
  }
  if (phase === 'limit') {
    return language === 'en'
      ? 'This Collective has reached its channel limit.'
      : '这个共同体的频道数已经达到上限，暂时不能再新建。';
  }
  if (phase === 'signed-out') {
    return language === 'en'
      ? 'Your sign-in has expired. Sign in again before creating a channel.'
      : '登录状态已经失效，请重新登录后再新建频道。';
  }
  return language === 'en'
    ? `Could not create the channel: ${collectiveName}'s service is temporarily unavailable. Retry will not create a duplicate.`
    : `没能新建：暂时连不上${collectiveName}的服务。点「重试」，不会建出两个`;
}
