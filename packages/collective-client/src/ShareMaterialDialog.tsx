import { useEffect, useState } from 'react';
import type { CollectiveRoadmapRecord } from './client-types.js';
import { MaterialDialogFrame } from './MaterialDialogFrame.js';
import { useMaterialText } from './material-copy.js';
import type { ProjectMaterialClient } from './project-material-client.js';

export function ShareMaterialDialog({
  project,
  client,
  onClose,
  onShared,
}: {
  project: CollectiveRoadmapRecord;
  client: ProjectMaterialClient;
  onClose(): void;
  onShared(): Promise<void>;
}) {
  const t = useMaterialText(),
    [connections, setConnections] = useState<{ connectionId: string; label: string }[]>([]);
  const [connectionId, setConnectionId] = useState(''),
    [provider, setProvider] = useState<'github' | 'feishu'>('github');
  const [sourceId, setSourceId] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(false);
  const [loading, setLoading] = useState(true),
    [consent, setConsent] = useState(false);
  useEffect(() => {
    let current = true;
    void client
      .connections(project.roadmapId)
      .then((values) => {
        if (current) {
          setConnections(values);
          setConnectionId(values[0]?.connectionId ?? '');
        }
      })
      .catch(() => {
        if (current) setError(true);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [client.namespace, project.roadmapId]);
  return (
    <MaterialDialogFrame label={t('add')} onClose={onClose} busy={busy}>
      <h2>{t('add')}</h2>
      <p>
        {project.title} · #{project.sourceLocation.channelId}
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError(false);
          void client
            .publish(project, connectionId, provider, sourceId.trim())
            .then(onShared)
            .then(onClose)
            .catch(() => setError(true))
            .finally(() => setBusy(false));
        }}
      >
        {loading ? (
          <p>{t('loading')}</p>
        ) : connections.length ? (
          <>
            <label>
              {t('cafe')}
              <select value={connectionId} onChange={(event) => setConnectionId(event.target.value)}>
                {connections.map((connection) => (
                  <option key={connection.connectionId} value={connection.connectionId}>
                    {connection.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('provider')}
              <select
                value={provider}
                onChange={(event) => {
                  setProvider(event.target.value as 'github' | 'feishu');
                  setSourceId('');
                }}
              >
                <option value="github">GitHub PR / Issue</option>
                <option value="feishu">{t('meeting')}</option>
              </select>
            </label>
            <label>
              {t(provider === 'github' ? 'github' : 'meeting')}
              <input
                value={sourceId}
                maxLength={2048}
                required
                placeholder={
                  provider === 'github' ? 'https://github.com/owner/repo/issues/123' : 'feishu://meeting-artifacts/…'
                }
                onChange={(event) => setSourceId(event.target.value)}
              />
            </label>
            <label className="material-consent">
              <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
              <span>{t('consent')}</span>
            </label>
          </>
        ) : (
          <p>{t('noCafe')}</p>
        )}
        {error && <p role="alert">{t('shareError')}</p>}
        <footer>
          <button type="button" disabled={busy} onClick={onClose}>
            {t('cancel')}
          </button>
          <button
            type="submit"
            className="primary"
            disabled={busy || loading || !connectionId || !sourceId.trim() || !consent}
          >
            {t('share')}
          </button>
        </footer>
      </form>
    </MaterialDialogFrame>
  );
}
