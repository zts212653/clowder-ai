import Link from 'next/link';
import { SETTINGS_SECTIONS } from './settings-nav-config';

interface ConsoleSetupStateConfig {
  title: string;
  description: string;
  href: string;
  ctaLabel: string;
}

const RUNTIME_BACKED_SECTIONS = new Set(SETTINGS_SECTIONS.map((section) => section.id));

export function resolveConsoleSetupState(section: string, fetchError: string | null): ConsoleSetupStateConfig | null {
  if (!fetchError || !RUNTIME_BACKED_SECTIONS.has(section)) return null;

  const sectionMeta = SETTINGS_SECTIONS.find((candidate) => candidate.id === section);
  const sectionLabel = sectionMeta?.label ?? '当前分区';

  return {
    title: 'Console 还没连上运行时',
    description: `当前分区“${sectionLabel}”依赖运行时 API。先启动 API，再回到这里继续配置；如果你需要参考旧交互，可以打开 Classic 参考世界。`,
    href: '/classic',
    ctaLabel: '查看 Classic 参考',
  };
}

export function ConsoleSetupState({ title, description, href, ctaLabel }: ConsoleSetupStateConfig) {
  return (
    <section className="console-section-shell rounded-xl p-5 md:p-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="space-y-2">
          <span className="console-pill inline-flex items-center rounded-full px-3 py-1 text-[11px] font-semibold text-cafe-secondary">
            Setup Required
          </span>
          <h3 className="text-lg font-semibold tracking-[-0.03em] text-cafe">{title}</h3>
          <p className="max-w-2xl text-sm leading-6 text-cafe-secondary">{description}</p>
        </div>
        <Link href={href} className="console-button-secondary">
          {ctaLabel}
        </Link>
      </div>
      <div className="mt-4 console-card-soft rounded-xl px-4 py-4 text-sm text-cafe-secondary">
        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cafe-muted">Why</p>
        <p className="mt-2 leading-6">
          新世界是默认目标，Classic 只保留为旧交互参考。API
          没起时不要直接把用户扔到“网络错误”，应该明确告诉用户当前缺的是运行时，而不是让界面继续混用两套世界语义。
        </p>
      </div>
    </section>
  );
}
