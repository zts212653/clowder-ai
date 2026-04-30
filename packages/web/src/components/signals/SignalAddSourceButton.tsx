export function SignalAddSourceButton() {
  return (
    <button
      type="button"
      disabled
      title="添加信源功能即将上线"
      className="flex items-center gap-2 rounded-lg bg-[var(--cafe-accent,#C65F3D)] px-3.5 text-[13px] font-semibold text-[var(--cafe-surface)] opacity-50 cursor-not-allowed"
      style={{ height: 36 }}
    >
      <svg className="h-[15px] w-[15px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
      </svg>
      添加信源
    </button>
  );
}
