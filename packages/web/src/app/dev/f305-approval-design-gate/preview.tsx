'use client';

import { useState } from 'react';
import { CandidateMeetingCard } from './candidate-card';
import { CurrentMeetingCard } from './current-card';
import { ApprovalChrome, WorkspaceHeader } from './preview-chrome';

type PreviewMode = 'candidate' | 'current';
type PreviewState = 'default' | 'repair';
type PreviewWidth = 'desktop' | 'narrow';

export function F305ApprovalDesignGatePreview() {
  const [mode, setMode] = useState<PreviewMode>('candidate');
  const [previewState, setPreviewState] = useState<PreviewState>('default');
  const [width, setWidth] = useState<PreviewWidth>('desktop');
  const [editOpen, setEditOpen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);

  return (
    <main className="min-h-screen bg-cafe-surface-canvas px-3 py-4 text-cafe sm:px-6 sm:py-6">
      <section className="mx-auto max-w-6xl">
        {controlsVisible ? (
          <PreviewControls
            mode={mode}
            previewState={previewState}
            width={width}
            onModeChange={setMode}
            onStateChange={setPreviewState}
            onWidthChange={setWidth}
            onHide={() => setControlsVisible(false)}
          />
        ) : (
          <button
            type="button"
            className="mb-3 rounded-lg border border-cafe bg-cafe-surface px-3 py-1.5 text-micro font-medium"
            onClick={() => setControlsVisible(true)}
          >
            显示体验控制
          </button>
        )}

        <div
          className={`mx-auto overflow-hidden rounded-2xl border border-cafe bg-cafe-surface shadow-md transition-[max-width] duration-200 ${
            width === 'narrow' ? 'max-w-[390px]' : 'max-w-[1180px]'
          }`}
          data-testid="f305-shell"
          data-width={width}
        >
          <WorkspaceHeader />
          <ApprovalChrome />
          <div className="bg-cafe-surface-canvas p-3 sm:p-5">
            {mode === 'current' ? (
              <CurrentMeetingCard repair={previewState === 'repair'} />
            ) : (
              <CandidateMeetingCard
                repair={previewState === 'repair'}
                editOpen={editOpen}
                onEditToggle={() => setEditOpen((value) => !value)}
              />
            )}
          </div>
        </div>
      </section>
    </main>
  );
}

function PreviewControls({
  mode,
  previewState,
  width,
  onModeChange,
  onStateChange,
  onWidthChange,
  onHide,
}: {
  mode: PreviewMode;
  previewState: PreviewState;
  width: PreviewWidth;
  onModeChange: (mode: PreviewMode) => void;
  onStateChange: (state: PreviewState) => void;
  onWidthChange: (width: PreviewWidth) => void;
  onHide: () => void;
}) {
  return (
    <div
      className="mb-4 rounded-2xl border border-cafe bg-cafe-surface-elevated p-3 shadow-sm"
      data-testid="f305-demo-controls"
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="mr-auto min-w-[220px]">
          <p className="text-xs font-semibold">审批卡对比</p>
          <p className="mt-0.5 text-micro text-cafe-muted">演示页面 · 示例内容 · 不会执行真实操作</p>
        </div>
        <ControlGroup label="页面">
          <ControlButton testId="f305-mode-current" active={mode === 'current'} onClick={() => onModeChange('current')}>
            原页面
          </ControlButton>
          <ControlButton
            testId="f305-mode-candidate"
            active={mode === 'candidate'}
            onClick={() => onModeChange('candidate')}
          >
            新页面
          </ControlButton>
        </ControlGroup>
        <ControlGroup label="连接">
          <ControlButton
            testId="f305-state-default"
            active={previewState === 'default'}
            onClick={() => onStateChange('default')}
          >
            正常
          </ControlButton>
          <ControlButton
            testId="f305-state-repair"
            active={previewState === 'repair'}
            onClick={() => onStateChange('repair')}
          >
            已失效
          </ControlButton>
        </ControlGroup>
        <ControlGroup label="窗口">
          <ControlButton
            testId="f305-width-desktop"
            active={width === 'desktop'}
            onClick={() => onWidthChange('desktop')}
          >
            宽屏
          </ControlButton>
          <ControlButton testId="f305-width-narrow" active={width === 'narrow'} onClick={() => onWidthChange('narrow')}>
            窄屏
          </ControlButton>
        </ControlGroup>
        <button
          type="button"
          className="rounded-lg border border-cafe px-2.5 py-1.5 text-micro font-medium text-cafe-secondary hover:bg-cafe-surface"
          onClick={onHide}
        >
          隐藏控制条
        </button>
      </div>
    </div>
  );
}

function ControlGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1 rounded-xl border border-cafe bg-cafe-surface p-1">
      <span className="px-1.5 text-micro text-cafe-muted">{label}</span>
      {children}
    </div>
  );
}

function ControlButton({
  active,
  testId,
  onClick,
  children,
}: {
  active: boolean;
  testId: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`rounded-lg px-2.5 py-1.5 text-micro font-medium ${
        active ? 'bg-cafe-interactive text-[var(--cafe-accent-foreground)]' : 'text-cafe-secondary hover:bg-cafe-muted'
      }`}
      aria-pressed={active}
      data-testid={testId}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
