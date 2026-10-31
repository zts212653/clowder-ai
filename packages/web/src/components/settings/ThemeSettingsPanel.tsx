'use client';

import { lazy, Suspense, useState } from 'react';
import { useThemeStore } from '@/stores/themeStore';
import { HubIcon } from '../hub-icons';
import { useShellCopy } from '../shell/shell-copy';
import { type ShellLanguage, useShellLanguage, writeShellLanguage } from '../shell/shell-language';
import { type ShellPresentation, useShellPresentation, writeShellPresentation } from '../shell/shell-presentation';
import { ProcessTalkSettings } from './ProcessTalkSettings';
import { themeSettingsCopy } from './theme-settings.shell-copy';

const OklchTuner = lazy(() => import('../dev/OklchTuner').then((m) => ({ default: m.OklchTuner })));

const MAX_CUSTOM = 2;

const PRESENTATIONS: ReadonlyArray<ShellPresentation> = ['v2', 'classic'];
const LANGUAGES: ReadonlyArray<ShellLanguage> = ['zh', 'en'];
/** A language's own name for itself. Not a word of this page: it reads the same whichever language the page is in. */
const OWN_NAME: Readonly<Record<ShellLanguage, string>> = { zh: '中文（简体）', en: 'English' };
/** The BCP 47 tag each fragment is marked with, so a screen reader speaks the name and the note each in their own language. */
const DOCUMENT_LANG: Readonly<Record<ShellLanguage, string>> = { zh: 'zh-CN', en: 'en' };

/**
 * One line of a radio group — the same writing for 界面版本 and 界面语言: a ring, the name, and a quieter note after it. The
 * parts may carry their own `lang` and the note may be set off by a separator, because for 界面语言 the name and the note are
 * in different languages and the accessible name (name + separator + note) has to be read in each of them: `English · 英文`,
 * not the glued `English英文`.
 */
function ChoiceRow({
  testId,
  selected,
  label,
  note,
  labelLang,
  noteLang,
  separator,
  onChoose,
}: {
  testId: string;
  selected: boolean;
  label: string;
  note: string;
  labelLang?: string;
  noteLang?: string;
  separator?: string;
  onChoose: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      data-testid={testId}
      data-chat-background-surface={selected ? 'selected' : 'paper'}
      onClick={onChoose}
      className="shell-focusable flex items-center gap-3 rounded-lg px-3 py-2 text-left text-sm"
      style={{
        background: selected ? 'var(--shell-selected)' : 'var(--shell-paper)',
        border: '1px solid var(--shell-hairline)',
        color: 'var(--shell-ink)',
      }}
    >
      <span
        aria-hidden="true"
        className="h-3.5 w-3.5 flex-none rounded-full"
        style={{
          border: '1.5px solid var(--shell-ink)',
          background: selected ? 'var(--shell-ink)' : 'transparent',
        }}
      />
      <span className="flex-1">
        <span lang={labelLang}>{label}</span>
        {note && (
          <span lang={noteLang} className="ml-2 text-xs" style={{ color: 'var(--shell-muted)' }}>
            {separator}
            {note}
          </span>
        )}
      </span>
    </button>
  );
}

/**
 * 主题 — the one place for how the app looks. Themes come from the existing themeStore (built-in light/dark and up to
 * two custom ones); nothing here keeps its own copy. 界面版本 and 界面语言 sit here because they only change presentation:
 * both are browser-local preferences read through their own `use…` hook, applied at the click (no Save), never a store that
 * gates data. Choosing a language swaps the dictionary the new shell reads; nothing on this page or under it remounts.
 */
export function ThemeSettingsPanel() {
  const store = useThemeStore();
  const t = useShellCopy(themeSettingsCopy);
  const presentation = useShellPresentation();
  const language = useShellLanguage();
  const [tunerOpen, setTunerOpen] = useState(false);
  const customCount = store.themes.filter((theme) => !theme.builtIn).length;
  // What each language is called in the language being read; shown beside its own name only when it differs from it.
  const calledHere: Readonly<Record<ShellLanguage, string>> = {
    zh: t.language.names.chinese,
    en: t.language.names.english,
  };

  return (
    <div className="space-y-6" data-testid="theme-settings-panel">
      <header>
        <h2 className="text-base font-semibold" style={{ color: 'var(--shell-ink)' }}>
          {t.title}
        </h2>
        <p className="mt-1 text-xs" style={{ color: 'var(--shell-muted)' }}>
          {t.scope}
        </p>
      </header>

      <section aria-labelledby="shell-presentation-heading">
        <h3 id="shell-presentation-heading" className="text-sm font-semibold" style={{ color: 'var(--shell-ink)' }}>
          {t.presentation.heading}
        </h3>
        <div role="radiogroup" aria-labelledby="shell-presentation-heading" className="mt-2 flex flex-col gap-1.5">
          {PRESENTATIONS.map((id) => (
            <ChoiceRow
              key={id}
              testId={`shell-presentation-${id}`}
              selected={presentation === id}
              label={t.presentation[id].label}
              note={t.presentation[id].note}
              onChoose={() => writeShellPresentation(id)}
            />
          ))}
        </div>
      </section>

      <section aria-labelledby="shell-language-heading">
        <h3
          id="shell-language-heading"
          className="flex items-center gap-1.5 text-sm font-semibold"
          style={{ color: 'var(--shell-ink)' }}
        >
          <span aria-hidden="true" className="flex-none" style={{ color: 'var(--shell-muted)' }}>
            <HubIcon name="languages" className="h-4 w-4" />
          </span>
          {t.language.heading}
        </h3>
        <p className="mt-1 text-xs" style={{ color: 'var(--shell-muted)' }}>
          {t.language.note}
        </p>
        <div role="radiogroup" aria-labelledby="shell-language-heading" className="mt-2 flex flex-col gap-1.5">
          {LANGUAGES.map((id) => (
            <ChoiceRow
              key={id}
              testId={`shell-language-${id}`}
              selected={language === id}
              label={OWN_NAME[id]}
              labelLang={DOCUMENT_LANG[id]}
              note={calledHere[id] === OWN_NAME[id] ? '' : calledHere[id]}
              noteLang={DOCUMENT_LANG[language]}
              separator=" · "
              onChoose={() => writeShellLanguage(id)}
            />
          ))}
        </div>
      </section>

      <ProcessTalkSettings />

      <section aria-labelledby="theme-list-heading">
        <h3 id="theme-list-heading" className="text-sm font-semibold" style={{ color: 'var(--shell-ink)' }}>
          {t.colors.heading}
        </h3>
        <ul className="mt-2 flex list-none flex-col gap-1.5 p-0">
          {store.themes.map((theme) => {
            const active = theme.id === store.activeId;
            return (
              <li
                key={theme.id}
                data-chat-background-surface={active ? 'selected' : 'paper'}
                className="flex items-center gap-2 rounded-lg px-3 py-2"
                style={{
                  background: active ? 'var(--shell-selected)' : 'var(--shell-paper)',
                  border: '1px solid var(--shell-hairline)',
                }}
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => store.setActive(theme.id)}
                  data-testid={`theme-${theme.id}`}
                  className="shell-focusable flex-1 rounded-md text-left text-sm"
                  style={{ color: 'var(--shell-ink)' }}
                >
                  {theme.name}
                  {active && (
                    <span className="ml-2 text-xs" style={{ color: 'var(--shell-muted)' }}>
                      {t.colors.inUse}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    store.setActive(theme.id);
                    setTunerOpen(true);
                  }}
                  className="shell-focusable rounded-md px-2 py-1 text-xs"
                  style={{ color: 'var(--shell-body)' }}
                  aria-label={t.colors.editLabel(theme.name)}
                >
                  {t.colors.edit}
                </button>
                {!theme.builtIn && (
                  <button
                    type="button"
                    onClick={() => store.deleteCustom(theme.id)}
                    className="shell-focusable rounded-md px-2 py-1 text-xs"
                    style={{ color: 'var(--shell-body)' }}
                    aria-label={t.colors.removeLabel(theme.name)}
                  >
                    {t.colors.remove}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        {customCount < MAX_CUSTOM && (
          <button
            type="button"
            data-testid="theme-create"
            onClick={() => {
              const id = store.createCustom(t.colors.customName(customCount + 1), store.activeId);
              if (id) setTunerOpen(true);
            }}
            className="shell-focusable mt-2 rounded-lg px-3 py-2 text-sm"
            style={{ border: '1px solid var(--shell-hairline-strong)', color: 'var(--shell-ink)' }}
          >
            {t.colors.create}
          </button>
        )}
      </section>

      {tunerOpen && (
        <Suspense>
          <OklchTuner onClose={() => setTunerOpen(false)} />
        </Suspense>
      )}
    </div>
  );
}
