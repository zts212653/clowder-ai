export function BootstrapAutoNotice() {
  return (
    <div data-testid="bootstrap-auto-notice" className="flex justify-center mb-3">
      <div className="max-w-[85%] w-full rounded-lg border border-conn-amber-ring bg-conn-amber-bg/50 p-4">
        <div className="flex items-center gap-3">
          <span className="text-xl flex-shrink-0">⏳</span>
          <div>
            <p className="text-sm font-medium text-conn-amber-text">正在自动建立记忆索引…</p>
            <p className="text-xs text-conn-amber-text mt-0.5">治理初始化完成，猫猫正在扫描项目文档以构建知识库</p>
          </div>
        </div>
        <p className="text-[10px] text-conn-amber-text mt-2 ml-9">
          此过程在后台运行。你可以继续对话，完成后将显示扫描结果。
        </p>
      </div>
    </div>
  );
}
