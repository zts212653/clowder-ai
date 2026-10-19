import { type FormEvent, useState } from 'react';

interface AuthoringState {
  readonly submitting: boolean;
  readonly error?: string;
}

const idle: AuthoringState = { submitting: false };

export function NewProjectControl({
  channelId,
  onCreate,
}: {
  readonly channelId: string;
  readonly onCreate?: (channelId: string, title: string, purpose: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [purpose, setPurpose] = useState('');
  const [state, setState] = useState<AuthoringState>(idle);
  if (!onCreate) return null;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const nextTitle = title.trim();
    const nextPurpose = purpose.trim();
    if (!nextTitle || !nextPurpose || state.submitting) return;
    setState({ submitting: true });
    try {
      await onCreate(channelId, nextTitle, nextPurpose);
      setTitle('');
      setPurpose('');
      setOpen(false);
      setState(idle);
    } catch (error) {
      setState({ submitting: false, error: commandErrorMessage(error) });
    }
  };
  return (
    <div className="project-authoring-control">
      <button type="button" className="project-primary-action" aria-expanded={open} onClick={() => setOpen(!open)}>
        新建项目
      </button>
      {open && (
        <form className="project-authoring-form project-authoring-form-global" onSubmit={(event) => void submit(event)}>
          <label>
            <span>项目名称</span>
            <input
              aria-label="项目名称"
              value={title}
              maxLength={200}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label>
            <span>完成标准</span>
            <textarea
              aria-label="项目完成标准"
              value={purpose}
              maxLength={4000}
              rows={3}
              onChange={(event) => setPurpose(event.target.value)}
            />
          </label>
          {state.error && <p role="alert">{state.error}</p>}
          <div className="project-authoring-actions">
            <button type="button" onClick={() => setOpen(false)}>
              取消
            </button>
            <button type="submit" className="project-primary-action" disabled={state.submitting}>
              {state.submitting ? '正在创建…' : '创建项目'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function commandErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作尚未确认，请重试。';
}
