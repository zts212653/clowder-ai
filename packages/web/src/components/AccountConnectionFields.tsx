import type { Dispatch, SetStateAction } from 'react';
import { accountFormCopy } from './accounts/account-form.shell-copy';
import type { BuiltinAccountClient } from './hub-accounts.types';
import { HubIcon } from './hub-icons';
import { TagEditor } from './hub-tag-editor';
import { formInputClass } from './mcp-form-helpers';
import { useShellCopy } from './shell/shell-copy';

/** Match accounts-schemas.ts: mixed-case tails are valid, CAT_CAFE_ stays reserved. */
export function isValidAccountEnvKey(key: string): boolean {
  return /^[A-Z_][A-Za-z0-9_]*$/.test(key) && !key.startsWith('CAT_CAFE_');
}
/** Suggested models per client — kept in sync with cat-template.json clientDefaults. */
const MODEL_SUGGESTIONS: Partial<Record<BuiltinAccountClient, string[]>> = {
  anthropic: [
    'claude-sonnet-4-6',
    'claude-opus-4-6',
    'claude-opus-4-6[1m]',
    'claude-sonnet-4-5-20250929',
    'claude-opus-4-5-20251101',
  ],
  openai: ['gpt-5.4', 'gpt-5.3-codex', 'gpt-5.3-codex-spark'],
  google: [
    'Gemini 3.1 Pro (High)',
    'Gemini 3.1 Pro (Low)',
    'Gemini 3.6 Flash (High)',
    'Gemini 3.5 Flash (High)',
    'Claude Opus 4.6 (Thinking)',
  ],
  opencode: ['claude-sonnet-4-6', 'claude-opus-4-6'],
};

export function AccountConnectionFields({
  isOAuth,
  isCodexLogin,
  isEdit,
  initialClientId,
  clientId,
  baseUrl,
  setBaseUrl,
  apiKey,
  setApiKey,
  models,
  setModels,
  envEntries,
  setEnvEntries,
  advancedOpen,
  setAdvancedOpen,
  clearError,
}: {
  isOAuth: boolean;
  isCodexLogin: boolean;
  isEdit: boolean;
  initialClientId?: BuiltinAccountClient;
  clientId?: BuiltinAccountClient;
  baseUrl: string;
  setBaseUrl: (value: string) => void;
  apiKey: string;
  setApiKey: (value: string) => void;
  models: string[];
  setModels: (value: string[]) => void;
  envEntries: Array<{ key: string; value: string }>;
  setEnvEntries: (value: Array<{ key: string; value: string }>) => void;
  advancedOpen: boolean;
  setAdvancedOpen: Dispatch<SetStateAction<boolean>>;
  clearError: () => void;
}) {
  const t = useShellCopy(accountFormCopy);
  return (
    <>
      {/* API Key mode: Base URL + API Key */}
      {!isOAuth && (
        <>
          <div>
            <label className="mb-1 block text-xs font-medium text-cafe-secondary">{t.baseUrl}</label>
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.openai.com/v1"
              className={formInputClass}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-cafe-secondary">API Key{isEdit && t.keyKeep}</label>
            <input
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                clearError();
              }}
              placeholder={isEdit ? '••••••••••••' : 'sk-...'}
              className={formInputClass}
            />
          </div>
        </>
      )}

      {(!isCodexLogin || isEdit) && (
        <>
          {/* 可用模型 */}
          <div>
            <label className="mb-1 block text-xs font-medium text-cafe-secondary">{t.models}</label>
            <TagEditor
              tags={models}
              tone="purple"
              addLabel={t.addModel}
              commitLabel={t.commitModel}
              removeLabel={t.removeModel}
              placeholder={t.modelHint}
              emptyLabel={isOAuth ? t.modelsOptional : t.modelsRequired}
              onChange={setModels}
              minCount={0}
            />
            {/* Model suggestions for builtin clients */}
            {isOAuth &&
              clientId &&
              (MODEL_SUGGESTIONS[initialClientId ?? clientId] ?? []).filter((m) => !models.includes(m)).length > 0 && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1">
                  <span className="text-micro text-cafe-muted">{t.recommended}</span>
                  {(MODEL_SUGGESTIONS[initialClientId ?? clientId] ?? [])
                    .filter((m) => !models.includes(m))
                    .map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setModels([...models, m])}
                        className="rounded-full border border-dashed border-[var(--console-border-soft)] px-2 py-0.5 text-micro text-cafe-secondary transition hover:border-cafe-accent hover:text-cafe-accent"
                      >
                        + {m}
                      </button>
                    ))}
                </div>
              )}
          </div>

          {/* F171: 高级配置 — collapsible env var injection */}
          <div className="rounded-lg border border-[var(--console-border-soft)]">
            <button
              type="button"
              onClick={() => setAdvancedOpen((v) => !v)}
              className="flex w-full items-center gap-1 px-3 py-2 text-xs font-medium text-cafe-secondary hover:bg-[var(--console-card-bg)]"
            >
              <span className="text-micro">{advancedOpen ? '\u25BE' : '\u25B8'}</span>
              {t.advanced}
            </button>
            {advancedOpen && (
              <div className="console-divider-t px-3 pb-3 pt-2">
                <p className="mb-2 text-micro text-cafe-muted">{t.envHint}</p>
                <div className="space-y-1.5">
                  {envEntries.map((entry, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      <div className="w-[38%] shrink-0">
                        <input
                          value={entry.key}
                          onChange={(e) => {
                            const next = [...envEntries];
                            next[i] = { ...next[i], key: e.target.value };
                            setEnvEntries(next);
                          }}
                          placeholder="KEY"
                          className={`font-mono ${
                            entry.key.trim() && !isValidAccountEnvKey(entry.key.trim())
                              ? `${formInputClass} !border-semantic-critical !bg-semantic-critical-surface !text-semantic-critical`
                              : formInputClass
                          }`}
                        />
                      </div>
                      <span className="text-micro text-cafe-muted">=</span>
                      <div className="min-w-0 flex-1">
                        <input
                          value={entry.value}
                          onChange={(e) => {
                            const next = [...envEntries];
                            next[i] = { ...next[i], value: e.target.value };
                            setEnvEntries(next);
                          }}
                          placeholder="value"
                          className={`font-mono ${formInputClass}`}
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => setEnvEntries(envEntries.filter((_, j) => j !== i))}
                        className="text-xs text-cafe-muted hover:text-semantic-critical"
                        title={t.delete}
                        aria-label={t.delete}
                      >
                        <HubIcon name="trash" className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                  {envEntries.some((e) => e.key.trim() && !isValidAccountEnvKey(e.key.trim())) && (
                    <p className="text-micro text-semantic-critical">
                      {envEntries.some((e) => e.key.trim().startsWith('CAT_CAFE_')) ? t.reserved : ''}
                      {t.invalidEnv}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setEnvEntries([...envEntries, { key: '', value: '' }])}
                  className="mt-2 text-micro font-medium text-cafe-accent hover:text-cafe-accent-hover"
                >
                  {t.addEnv}
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
