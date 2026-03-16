'use client';

interface NightStatusProps {
  roleName: string;
  actionHint: string;
}

export function NightStatus({ roleName, actionHint }: NightStatusProps) {
  return (
    <div data-testid="night-status" className="flex items-center justify-center gap-2 bg-ww-topbar px-6 h-12 w-full">
      <span className="w-2 h-2 rounded-full bg-ww-success shrink-0" data-testid="status-dot" />
      <span className="text-ww-muted text-sm font-medium">
        你的身份：{roleName} · {actionHint}
      </span>
    </div>
  );
}
