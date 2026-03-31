import { useCallback, useEffect, useRef, useState } from 'react';
import { formatCatName, useCatData } from '@/hooks/useCatData';
import { useIMEGuard } from '@/hooks/useIMEGuard';
import { apiFetch } from '@/utils/api-client';
import { CatSelector } from './CatSelector';
import { DirectoryBrowser } from './DirectoryBrowser';
import { projectDisplayName } from './thread-utils';

/** F33: Session binding passed alongside thread creation */
export interface SessionBinding {
  catId: string;
  cliSessionId: string;
}

/** F095 Phase C: All options collected by the new-thread modal */
export interface NewThreadOptions {
  projectPath?: string;
  preferredCats?: string[];
  sessionBindings?: SessionBinding[];
  title?: string;
  pinned?: boolean;
  backlogItemId?: string;
}

interface BacklogItemSummary {
  id: string;
  title: string;
  status: string;
}

export function DirectoryPickerModal({
  existingProjects,
  onSelect,
  onCancel,
}: {
  existingProjects: string[];
  onSelect: (opts: NewThreadOptions) => void;
  onCancel: () => void;
}) {
  const [selectedCats, setSelectedCats] = useState<string[]>([]);
  const [sessionInputs, setSessionInputs] = useState<Record<string, string>>({});
  const [bindExpanded, setBindExpanded] = useState(false);
  const [cwdPath, setCwdPath] = useState<string | null>(null);
  const [showBrowser, setShowBrowser] = useState(false);
  const [pathInput, setPathInput] = useState('');
  const [pathError, setPathError] = useState<string | null>(null);
  const { getCatById } = useCatData();
  const modalRef = useRef<HTMLDivElement>(null);
  const ime = useIMEGuard();

  // F068-R7: Two-step flow — select project first, then confirm
  // 'lobby' sentinel means user explicitly chose "大厅 (无项目)"
  const [selectedPath, setSelectedPath] = useState<string | 'lobby' | null>(null);
  // P2 fix: clear stale pathError whenever user selects a project
  const handleSelectPath = useCallback((path: string | 'lobby') => {
    setPathError(null);
    setSelectedPath(path);
  }, []);

  // F095 Phase C: new fields
  const [threadTitle, setThreadTitle] = useState('');
  const [pinOnCreate, setPinOnCreate] = useState(false);
  const [backlogItems, setBacklogItems] = useState<BacklogItemSummary[]>([]);
  const [selectedBacklogItemId, setSelectedBacklogItemId] = useState('');

  // Fetch active backlog items for feat dropdown
  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch('/api/backlog/items');
        if (res.ok) {
          const data = await res.json();
          const active = (data.items ?? []).filter(
            (item: BacklogItemSummary) => item.status !== 'done' && item.status !== 'cancelled',
          );
          setBacklogItems(active);
        }
      } catch {
        // ignore — backlog is optional
      }
    })();
  }, []);

  const selectWithOptions = useCallback(
    (projectPath: string | undefined) => {
      const bindings: SessionBinding[] = [];
      for (const [catId, sid] of Object.entries(sessionInputs)) {
        const trimmed = sid.trim();
        if (trimmed && selectedCats.includes(catId)) {
          bindings.push({ catId, cliSessionId: trimmed });
        }
      }
      onSelect({
        projectPath,
        preferredCats: selectedCats.length > 0 ? selectedCats : undefined,
        sessionBindings: bindings.length > 0 ? bindings : undefined,
        title: threadTitle.trim() || undefined,
        pinned: pinOnCreate || undefined,
        backlogItemId: selectedBacklogItemId || undefined,
      });
    },
    [onSelect, selectedCats, sessionInputs, threadTitle, pinOnCreate, selectedBacklogItemId],
  );

  // F068-R7: Confirm creation with currently selected project
  const confirmCreate = useCallback(() => {
    if (selectedPath === null) return;
    selectWithOptions(selectedPath === 'lobby' ? undefined : selectedPath);
  }, [selectedPath, selectWithOptions]);

  // F113: Handle directory selection from the web-based browser
  const handleBrowserSelect = useCallback(
    (path: string) => {
      handleSelectPath(path);
      setShowBrowser(false);
    },
    [handleSelectPath],
  );

  // F068: Submit path from text input — validate via browse endpoint before accepting
  const handlePathSubmit = useCallback(async () => {
    const trimmed = pathInput.trim();
    if (!trimmed) return;
    setPathError(null);
    try {
      const res = await apiFetch(`/api/projects/browse?path=${encodeURIComponent(trimmed)}`);
      if (!res.ok) {
        const data = await res.json();
        setPathError(data.error || '路径无效');
        return;
      }
      // Valid directory — select the canonicalized path
      const data = await res.json();
      handleSelectPath(data.current);
    } catch {
      setPathError('无法连接到服务器');
    }
  }, [pathInput, handleSelectPath]);

  // Fetch cwd for "推荐" badge
  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch('/api/projects/cwd');
        if (res.ok) {
          const data = await res.json();
          setCwdPath(data.path);
        }
      } catch {
        // ignore — cwd is optional
      }
    })();
  }, []);

  // Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onCancel]);

  const [catsExpanded, setCatsExpanded] = useState(false);
  const catSummary = selectedCats.length > 0 ? `已选 ${selectedCats.length} 只猫` : '';

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop click-to-close
    <div
      role="presentation"
      className="fixed inset-0 bg-black/30 flex items-center justify-center z-50"
      onClick={(e) => {
        if (modalRef.current && !modalRef.current.contains(e.target as Node)) onCancel();
      }}
    >
      <div
        ref={modalRef}
        className="bg-cafe-surface rounded-xl shadow-2xl w-full max-w-[640px] mx-4 max-h-[85vh] flex flex-col overflow-hidden"
      >
        {/* ── Header + Title ── */}
        <div className="px-5 pt-4 pb-3 border-b border-cafe-subtle">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold text-cafe-black">新建对话</h2>
            <button
              type="button"
              onClick={onCancel}
              className="text-cafe-muted hover:text-cafe-secondary transition-colors p-1"
            >
              <svg aria-hidden="true" className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
                <path
                  fillRule="evenodd"
                  d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
          </div>
          <input
            type="text"
            value={threadTitle}
            onChange={(e) => setThreadTitle(e.target.value)}
            placeholder="对话标题（可选）"
            maxLength={200}
            className="w-full text-sm px-3 py-2 rounded-lg border border-cafe bg-cafe-surface focus:outline-none focus:ring-1 focus:ring-cocreator-primary"
          />
        </div>

        {/* ── Project list (PRIMARY ACTION — takes most space, hidden when browser is open) ── */}
        <div className={`overflow-y-auto px-5 py-3 space-y-1 ${showBrowser ? 'hidden' : 'flex-1 min-h-[180px]'}`}>
          <div className="text-[10px] text-cafe-muted font-medium mb-1">选择项目</div>

          {cwdPath && !existingProjects.includes(cwdPath) && (
            <button
              type="button"
              onClick={() => handleSelectPath(cwdPath)}
              className={`w-full text-left px-3 py-2.5 text-sm text-cafe-secondary hover:bg-cocreator-bg rounded-lg transition-colors flex items-center gap-2 ${selectedPath === cwdPath ? 'ring-2 ring-cocreator-primary bg-cocreator-bg' : 'ring-1 ring-cocreator-primary/30 bg-cocreator-bg/50'}`}
              title={cwdPath}
            >
              <FolderIcon />
              <div className="min-w-0 flex-1">
                <span className="font-medium block truncate">{projectDisplayName(cwdPath)}</span>
                <span className="text-[10px] text-cafe-muted block truncate">{cwdPath}</span>
              </div>
              <span className="text-[10px] text-cocreator-primary flex-shrink-0">推荐</span>
            </button>
          )}

          {/* Browsed path not in existing list — show as highlighted entry (pinned to top) */}
          {selectedPath &&
            selectedPath !== 'lobby' &&
            selectedPath !== cwdPath &&
            !existingProjects.includes(selectedPath) && (
              <button
                type="button"
                onClick={() => handleSelectPath(selectedPath)}
                className="w-full text-left px-3 py-2.5 text-sm text-cafe-secondary hover:bg-cocreator-bg rounded-lg transition-colors flex items-center gap-2 ring-2 ring-cocreator-primary bg-cocreator-bg"
                title={selectedPath}
              >
                <FolderIcon />
                <div className="min-w-0 flex-1">
                  <span className="font-medium block truncate">{projectDisplayName(selectedPath)}</span>
                  <span className="text-[10px] text-cafe-muted block truncate">{selectedPath}</span>
                </div>
                <span className="text-[10px] text-cocreator-primary flex-shrink-0">已选</span>
              </button>
            )}

          {existingProjects.map((path) => (
            <button
              type="button"
              key={path}
              onClick={() => handleSelectPath(path)}
              className={`w-full text-left px-3 py-2.5 text-sm text-cafe-secondary hover:bg-cocreator-bg rounded-lg transition-colors flex items-center gap-2 ${selectedPath === path ? 'ring-2 ring-cocreator-primary bg-cocreator-bg' : ''}`}
              title={path}
            >
              <FolderIcon />
              <div className="min-w-0 flex-1">
                <span className="font-medium block truncate">{projectDisplayName(path)}</span>
                <span className="text-[10px] text-cafe-muted block truncate">{path}</span>
              </div>
            </button>
          ))}

          <button
            type="button"
            onClick={() => handleSelectPath('lobby')}
            className={`w-full text-left px-3 py-2.5 text-sm text-cafe-secondary hover:bg-cocreator-bg rounded-lg transition-colors flex items-center gap-2 ${selectedPath === 'lobby' ? 'ring-2 ring-cocreator-primary bg-cocreator-bg' : ''}`}
          >
            <span className="text-base">🏠</span>
            <span>大厅 (无项目)</span>
          </button>
        </div>

        {/* ── Options bar: feat + pin + cats toggle (hidden when browser is open) ── */}
        <div
          className={`px-5 py-2 border-t border-cafe-subtle flex items-center gap-3 flex-wrap ${showBrowser ? 'hidden' : ''}`}
        >
          {backlogItems.length > 0 && (
            <div className="flex-1 min-w-[140px]">
              <select
                value={selectedBacklogItemId}
                onChange={(e) => setSelectedBacklogItemId(e.target.value)}
                className="w-full text-xs px-2 py-1.5 rounded border border-cafe bg-cafe-surface focus:outline-none focus:ring-1 focus:ring-cocreator-primary text-cafe-secondary"
              >
                <option value="">关联 Feature（可选）</option>
                {backlogItems.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
            </div>
          )}
          <label className="flex items-center gap-1.5 text-xs text-cafe-secondary cursor-pointer flex-shrink-0">
            <input
              type="checkbox"
              checked={pinOnCreate}
              onChange={(e) => setPinOnCreate(e.target.checked)}
              className="rounded border-cafe text-cocreator-primary focus:ring-cocreator-primary"
            />
            <span>创建后置顶</span>
          </label>
          <button
            type="button"
            onClick={() => setCatsExpanded((v) => !v)}
            className="flex items-center gap-1 text-xs text-cafe-secondary hover:text-cafe-secondary transition-colors ml-auto"
          >
            <span>{catsExpanded ? '收起猫猫' : '选猫猫'}</span>
            {catSummary && <span className="text-cocreator-primary">({catSummary})</span>}
            <svg
              aria-hidden="true"
              className={`w-3 h-3 transition-transform ${catsExpanded ? 'rotate-180' : ''}`}
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path
                fillRule="evenodd"
                d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        </div>

        {/* ── Cat selector (collapsed by default, hidden when browser is open) ── */}
        {catsExpanded && !showBrowser && (
          <div className="px-5 py-2 border-t border-cafe-subtle">
            <CatSelector selectedCats={selectedCats} onSelectionChange={setSelectedCats} />
            {/* F33: Session binding */}
            {selectedCats.length > 0 && (
              <div className="mt-2">
                <button
                  type="button"
                  onClick={() => setBindExpanded((v) => !v)}
                  className="w-full text-xs text-cafe-secondary hover:text-cafe-secondary flex items-center justify-between transition-colors py-1"
                >
                  <span>绑定外部 Session (可选)</span>
                  <svg
                    aria-hidden="true"
                    className={`w-3.5 h-3.5 transition-transform ${bindExpanded ? 'rotate-180' : ''}`}
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path
                      fillRule="evenodd"
                      d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
                      clipRule="evenodd"
                    />
                  </svg>
                </button>
                {bindExpanded && (
                  <div className="mt-1.5 space-y-2">
                    <p className="text-[10px] text-cafe-muted">
                      粘贴 Claude Code / Codex 的 Session ID，创建后自动绑定
                    </p>
                    {selectedCats.map((catId) => {
                      const cat = getCatById(catId);
                      const label = cat ? formatCatName(cat) : catId;
                      return (
                        <div key={catId} className="flex items-center gap-2">
                          <span className="text-[11px] text-cafe-secondary w-16 truncate flex-shrink-0" title={label}>
                            {label}
                          </span>
                          <input
                            value={sessionInputs[catId] ?? ''}
                            onChange={(e) => setSessionInputs((prev) => ({ ...prev, [catId]: e.target.value }))}
                            placeholder="CLI Session ID"
                            maxLength={500}
                            className="flex-1 text-[11px] font-mono px-2 py-1 rounded border border-cafe bg-cafe-surface-elevated focus:outline-none focus:ring-1 focus:ring-cocreator-primary"
                          />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── F113: Inline directory browser (replaces osascript picker) ── */}
        {showBrowser && (
          <div className="border-t border-cafe-subtle flex-1 min-h-0 flex flex-col overflow-hidden">
            <DirectoryBrowser
              initialPath={cwdPath ?? undefined}
              activeProjectPath={cwdPath ?? undefined}
              onSelect={handleBrowserSelect}
              onCancel={() => setShowBrowser(false)}
            />
          </div>
        )}

        {/* ── Bottom: browse button + path input + confirm ── */}
        <div className="px-5 py-3 border-t border-cafe-subtle space-y-2 flex-shrink-0">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setShowBrowser((v) => !v)}
              className={`flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium transition-colors ${
                showBrowser
                  ? 'bg-cocreator-primary text-white'
                  : 'bg-cafe-surface-elevated hover:bg-gray-200 text-cafe-secondary'
              }`}
            >
              <FolderOpenIcon />
              <span>{showBrowser ? '收起浏览' : '浏览文件夹...'}</span>
            </button>
            <input
              type="text"
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              onCompositionStart={ime.onCompositionStart}
              onCompositionEnd={ime.onCompositionEnd}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !ime.isComposing()) handlePathSubmit();
              }}
              placeholder="或输入路径..."
              className="flex-1 text-xs px-3 py-2 rounded-lg border border-cafe bg-cafe-surface focus:outline-none focus:ring-1 focus:ring-cocreator-primary"
            />
            {pathInput.trim() && (
              <button
                type="button"
                onClick={handlePathSubmit}
                className="px-2.5 py-2 rounded-lg bg-cafe-surface-elevated text-cafe-secondary hover:bg-gray-200 transition-colors"
                aria-label="跳转到路径"
              >
                <svg aria-hidden="true" className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                  <path
                    fillRule="evenodd"
                    d="M10.293 3.293a1 1 0 011.414 0l6 6a1 1 0 010 1.414l-6 6a1 1 0 01-1.414-1.414L14.586 11H3a1 1 0 110-2h11.586l-4.293-4.293a1 1 0 010-1.414z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
            )}
          </div>
          {pathError && <p className="text-[10px] text-red-500">{pathError}</p>}
          {/* F068-R7: Selected path hint + confirm button */}
          <div className="flex items-center gap-2 pt-1">
            {selectedPath && (
              <span
                className={`truncate flex-1 ${
                  showBrowser
                    ? 'text-xs font-medium text-cocreator-primary bg-cocreator-bg px-2 py-1 rounded-md'
                    : 'text-[11px] text-cafe-secondary'
                }`}
                title={selectedPath === 'lobby' ? '大厅' : selectedPath}
              >
                已选：{selectedPath === 'lobby' ? '大厅 (无项目)' : projectDisplayName(selectedPath)}
              </span>
            )}
            <button
              type="button"
              onClick={confirmCreate}
              disabled={selectedPath === null}
              className="ml-auto px-5 py-2 rounded-lg bg-cocreator-primary hover:bg-cocreator-dark text-white text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              创建对话
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function FolderIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={`w-4 h-4 flex-shrink-0 ${className ?? ''}`}
      viewBox="0 0 16 16"
      fill="currentColor"
    >
      <path d="M1 3.5A1.5 1.5 0 012.5 2h3.879a1.5 1.5 0 011.06.44l1.122 1.12A1.5 1.5 0 009.62 4H13.5A1.5 1.5 0 0115 5.5v7a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z" />
    </svg>
  );
}

function FolderOpenIcon() {
  return (
    <svg aria-hidden="true" className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
      <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
      <path fillRule="evenodd" d="M2 8h16v4a2 2 0 01-2 2H4a2 2 0 01-2-2V8z" clipRule="evenodd" opacity="0.4" />
    </svg>
  );
}
