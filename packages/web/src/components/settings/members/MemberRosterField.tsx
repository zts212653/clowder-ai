import type { resolveMemberIdentity } from '@cat-cafe/shared';
import { TextAreaField } from '../../hub-cat-editor-fields';
import type { MemberText } from './MemberRuntimeFields';

/** Source selection belongs to the shared resolver; this component only renders that result. */
export function MemberRosterField({
  label,
  ariaLabel,
  field,
  profileHref,
  hasProfile,
  limitation = false,
  t,
  onChange,
}: {
  label: string;
  ariaLabel?: string;
  field: ReturnType<typeof resolveMemberIdentity>['rosterFields']['caution'];
  profileHref: string;
  hasProfile: boolean;
  limitation?: boolean;
  t: MemberText;
  onChange: (value: string) => void;
}) {
  const profileLink = (missing = false) => (
    <a href={profileHref} className="text-[var(--shell-primary-text)] hover:underline">
      {missing ? t('还没有能力画像 ›', 'No capability profile yet ›') : t('能力画像 ›', 'Capability profile ›')}
    </a>
  );
  const hint =
    field.source === 'dossier'
      ? profileLink()
      : field.source === 'role'
        ? t('沿用职责', 'Same as Role')
        : limitation && !hasProfile && !field.configuredValue.trim()
          ? profileLink(true)
          : field.source === 'template'
            ? t('默认', 'Default')
            : undefined;
  return (
    <TextAreaField
      label={label}
      ariaLabel={ariaLabel}
      value={field.configuredValue}
      onChange={onChange}
      placeholder={field.effectiveValue}
      labelHint={hint}
      footer={
        field.replacedValue !== undefined && (
          <p className="mt-1.5 text-xs leading-[18px] text-cafe-muted">
            {t('替代了能力画像里的', 'Replaces ')}
            <span className="text-cafe-secondary">
              {t('「', '“')}
              {field.replacedValue}
              {t('」', '”')}
            </span>{' '}
            <button
              type="button"
              className="ml-1 text-[var(--shell-primary-text)] hover:underline"
              onClick={() => onChange('')}
            >
              {t('改用能力画像', 'Use profile')}
            </button>
          </p>
        )
      }
    />
  );
}
