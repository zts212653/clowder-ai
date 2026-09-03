import { type FormEvent, useState } from 'react';

import type { ClientPhase, HumanAuthProviderStatus } from './client-types.js';
import type { EntryMode } from './human-auth-flow.js';

export function OnboardingScene({
  phase,
  mode,
  providers,
  error,
  onBootstrap,
  onAuthenticate,
  onCreateCollective,
}: {
  readonly phase: ClientPhase;
  readonly mode: EntryMode;
  readonly providers: readonly HumanAuthProviderStatus[];
  readonly error?: string;
  readonly onBootstrap: (displayName: string) => Promise<void>;
  readonly onAuthenticate: () => Promise<void>;
  readonly onCreateCollective: (name: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const github = providers.find((provider) => provider.id === 'github');

  if (phase === 'loading') {
    return (
      <div className="state-scene" aria-live="polite">
        <p>正在打开共同家园…</p>
      </div>
    );
  }
  if (phase === 'unavailable') {
    return (
      <div className="state-scene state-scene-error" role="alert">
        <h2>现在还进不去</h2>
        <p>共同现场暂时不可达。数据仍留在原处，恢复连接后可以继续。</p>
        {error && <small>{error}</small>}
      </div>
    );
  }

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setLocalError(undefined);
    try {
      await action();
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const submitValue = (action: (value: string) => Promise<void>) => async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get('value') ?? '').trim();
    if (value) await run(() => action(value));
  };

  if (phase === 'create-collective') {
    return (
      <EntryCard
        eyebrow="第一次建立 Collective"
        title="给共同家园起个名字"
        description="你会成为第一位管理者。首启完成后还需绑定 Human 身份，才能邀请成员、连接 Café 或进入日常协作。"
        label="Collective 名称"
        defaultValue="Clowder AI Collective"
        button="建立 Collective"
        busy={busy}
        error={localError}
        onSubmit={submitValue(onCreateCollective)}
      />
    );
  }

  if (phase === 'bind-identity') {
    return (
      <AuthCard
        eyebrow="Human 身份"
        title="绑定你的 Human 身份"
        description="一次性初始化已经建立首个 Collective。完成身份验证后，才能邀请成员、连接 Café 或进入日常协作。"
        button="继续使用 GitHub 验证"
        providerReady={github?.ready === true}
        busy={busy}
        error={localError ?? error}
        onAuthenticate={() => run(onAuthenticate)}
      />
    );
  }

  if (mode === 'bootstrap') {
    return (
      <EntryCard
        eyebrow="一次性初始化"
        title="创建这里的第一位管理者"
        description="这条链接只建立首位管理者。接着创建第一个 Collective，再单独绑定 Human 身份；日常进入不会再使用这个 secret。"
        label="你希望显示的名字"
        button="创建管理入口"
        busy={busy}
        error={localError}
        onSubmit={submitValue(onBootstrap)}
      />
    );
  }

  if (mode === 'invite') {
    return (
      <AuthCard
        eyebrow="Collective 邀请"
        title="加入同一个共同现场"
        description="先验证你的 Human 身份，再接受这次邀请。Clowder AI endpoint 的连接与撤销仍独立管理。"
        button="使用 GitHub 验证并加入"
        providerReady={github?.ready === true}
        busy={busy}
        error={localError ?? error}
        onAuthenticate={() => run(onAuthenticate)}
      />
    );
  }

  return (
    <AuthCard
      eyebrow="欢迎回来"
      title="进入你的 Collective"
      description="用已经绑定的 Human 身份登录。若你是新成员，请从邀请链接进入。"
      button="使用 GitHub 登录"
      providerReady={github?.ready === true}
      busy={busy}
      error={localError ?? error}
      onAuthenticate={() => run(onAuthenticate)}
    />
  );
}

function AuthCard({
  eyebrow,
  title,
  description,
  button,
  providerReady,
  busy,
  error,
  onAuthenticate,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
  readonly button: string;
  readonly providerReady: boolean;
  readonly busy: boolean;
  readonly error?: string;
  readonly onAuthenticate: () => Promise<void>;
}) {
  return (
    <div className="entry-wrap">
      <section className="entry-card">
        <p className="entry-eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
        <p>{description}</p>
        <div className="entry-action">
          <button type="button" disabled={busy || !providerReady} onClick={() => void onAuthenticate()}>
            {busy ? '正在前往验证…' : button}
          </button>
        </div>
        {!providerReady && <p className="provider-note">Human 登录尚未配置，请联系 Service 管理者。</p>}
        {error && <p className="form-error">{error}</p>}
      </section>
    </div>
  );
}

function EntryCard({
  eyebrow,
  title,
  description,
  label,
  defaultValue,
  button,
  busy,
  error,
  onSubmit,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
  readonly label: string;
  readonly defaultValue?: string;
  readonly button: string;
  readonly busy: boolean;
  readonly error?: string;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
}) {
  return (
    <div className="entry-wrap">
      <section className="entry-card">
        <p className="entry-eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
        <p>{description}</p>
        <form onSubmit={(event) => void onSubmit(event)}>
          <label>
            {label}
            <input name="value" defaultValue={defaultValue} autoComplete="name" required />
          </label>
          <button type="submit" disabled={busy}>
            {busy ? '正在继续…' : button}
          </button>
        </form>
        {error && <p className="form-error">{error}</p>}
      </section>
    </div>
  );
}
