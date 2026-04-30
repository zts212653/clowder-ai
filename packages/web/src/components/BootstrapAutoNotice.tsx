export function BootstrapAutoNotice() {
  return (
    <div data-testid="bootstrap-auto-notice" className="flex justify-center mb-3">
      <div className="max-w-[85%] w-full" data-notice-tone="warning">
        <div className="system-notice-bar rounded-2xl px-4 py-3 text-cafe-secondary">
          <div className="flex items-start gap-3">
            <span className="system-notice-bar__icon leading-none mt-0.5 text-xl flex-shrink-0">⏳</span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium" style={{ color: 'var(--notice-label)' }}>
                正在自动建立记忆索引…
              </p>
              <p className="text-xs text-cafe-secondary mt-0.5">治理初始化完成，猫猫正在扫描项目文档以构建知识库</p>
              <p className="text-[10px] text-cafe-muted mt-2">
                此过程在后台运行。你可以继续对话，完成后将显示扫描结果。
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
