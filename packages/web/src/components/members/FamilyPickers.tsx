'use client';

import { useRef } from 'react';
import catalog from '../../../public/avatars/family/catalog.json';
import { AvatarImageWithFallback } from '../AvatarImageWithFallback';
import type { TemplateCard } from '../first-run-quest/TemplateStep';
import { useMembersCopy, useMemberText } from './editor-presentation';
import { MemberOperationFeedback } from './MemberOperationFeedback';

export function FamilyTemplatePicker({
  templates,
  selectedId,
  onSelect,
}: {
  templates: TemplateCard[];
  selectedId: string | null;
  onSelect: (template: TemplateCard | null) => void;
}) {
  const t = useMemberText();
  return (
    <section>
      <h3>{t('从家里的猫开始')}</h3>
      <div className="member-template-grid" data-guide-id="add-member.template-picker">
        {templates.map((t) => (
          <button
            key={t.id}
            type="button"
            className="member-template"
            aria-pressed={selectedId === t.id}
            style={{ '--member-color': t.color.primary } as React.CSSProperties}
            onClick={() => onSelect(t)}
          >
            {t.avatar && <AvatarImageWithFallback src={t.avatar} alt="" className="member-template-avatar" />}
            <span>
              <strong>{t.nickname ?? t.name}</strong>
              <small>{t.name}</small>
              <small>{t.roleDescription}</small>
            </span>
          </button>
        ))}
        <button
          className="member-template member-blank"
          type="button"
          aria-pressed={selectedId === 'custom'}
          onClick={() => onSelect(null)}
        >
          {t('从空白开始')}
        </button>
      </div>
    </section>
  );
}

export function FamilyAvatarPicker({
  value,
  uploading,
  onSelect,
  onUpload,
}: {
  value: string;
  uploading: boolean;
  onSelect: (src: string) => void;
  onUpload: (file: File) => Promise<void>;
}) {
  const t = useMemberText();
  const copy = useMembersCopy();
  const input = useRef<HTMLInputElement>(null);
  return (
    <section>
      <h3>
        {t('头像')}
        <small>{t('家里用过的头像，也可以上传自己的')}</small>
      </h3>
      <div className="member-avatar-catalog">
        {['布偶猫', '缅因猫', '暹罗猫', '其他'].map((group) => (
          <div className="member-avatar-group" key={group}>
            <span>{t(group)}</span>
            <div>
              {catalog
                .filter((avatar) => avatar.group === group)
                .map((avatar) => (
                  <button
                    key={avatar.id}
                    type="button"
                    className="member-avatar-option"
                    aria-label={copy.avatarLabel(avatar.label)}
                    aria-pressed={value === avatar.src}
                    onClick={() => onSelect(avatar.src)}
                  >
                    <AvatarImageWithFallback src={avatar.src} alt="" className="member-avatar" />
                    <span>{avatar.label}</span>
                  </button>
                ))}
            </div>
          </div>
        ))}
        <button className="member-button" type="button" disabled={uploading} onClick={() => input.current?.click()}>
          {uploading ? t('上传中…') : t('上传自己的头像')}
        </button>
        <input
          ref={input}
          aria-label={t('上传头像')}
          className="sr-only"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file)
              void onUpload(file).finally(() => {
                if (input.current) input.current.value = '';
              });
          }}
        />
      </div>
      <MemberOperationFeedback source="avatar" />
    </section>
  );
}
