interface BreadcrumbSegment {
  label: string;
  href?: string;
}

interface SettingsBreadcrumbProps {
  segments: BreadcrumbSegment[];
}

export function SettingsBreadcrumb({ segments }: SettingsBreadcrumbProps) {
  return (
    <nav className="text-sm font-semibold text-cafe-accent" aria-label="Breadcrumb">
      {segments.map((seg, i) => (
        <span key={seg.label}>
          {i > 0 && <span className="mx-1 text-cafe-muted">&gt;</span>}
          {seg.href ? (
            <a href={seg.href} className="hover:underline">
              {seg.label}
            </a>
          ) : (
            <span>{seg.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}
