import { resolveShellCopy } from '../shell/shell-copy';
import type { ShellLanguage } from '../shell/shell-language';
import { demoStoryCopy } from './demo-story.shell-copy';

export type DemoCat = 'architect' | 'designer' | 'developer';
export type DemoArtifact = 'design' | 'architecture' | 'initial' | 'review' | 'final';
export type DemoPreviewStage = DemoArtifact | 'waiting';
export interface DemoEvent {
  id: keyof typeof demoStoryCopy.zh.events;
  title: string;
  speaker: DemoCat | 'user' | 'system';
  text: string;
  duration: number;
  to?: DemoCat;
  artifact?: DemoArtifact;
}

const timeline = [
  {
    id: 'team',
    speaker: 'system',
    duration: 2600,
  },
  {
    id: 'task',
    speaker: 'user',
    duration: 3500,
  },
  {
    id: 'accept',
    speaker: 'architect',
    duration: 5000,
    to: 'designer',
  },
  {
    id: 'design',
    speaker: 'designer',
    duration: 5000,
    to: 'architect',
    artifact: 'design',
  },
  {
    id: 'architecture',
    speaker: 'architect',
    duration: 5000,
    to: 'developer',
    artifact: 'architecture',
  },
  {
    id: 'build',
    speaker: 'developer',
    duration: 4000,
    to: 'architect',
    artifact: 'initial',
  },
  {
    id: 'review',
    speaker: 'architect',
    duration: 5500,
    to: 'developer',
    artifact: 'review',
  },
  {
    id: 'revision',
    speaker: 'developer',
    duration: 5000,
    to: 'architect',
    artifact: 'final',
  },
  {
    id: 'approved',
    speaker: 'architect',
    duration: 3000,
    artifact: 'final',
  },
] as const satisfies readonly Omit<DemoEvent, 'title' | 'text'>[];

export function getDemoEvents(language: ShellLanguage): readonly DemoEvent[] {
  const copy = resolveShellCopy(demoStoryCopy, language);
  return timeline.map((event) => ({ ...event, ...copy.events[event.id] }));
}

export function getDemoTeam(language: ShellLanguage) {
  const { team } = resolveShellCopy(demoStoryCopy, language);
  return {
    architect: { ...team.architect, avatar: '/avatars/opus.png' },
    designer: { ...team.designer, avatar: '/avatars/gemini.png' },
    developer: { ...team.developer, avatar: '/avatars/codex.png' },
  };
}

// Existing consumers keep the Chinese defaults; playback metadata and bookmarks stay language-independent.
export const DEMO_EVENTS = getDemoEvents('zh');
export const DEMO_TEAM = getDemoTeam('zh');
// Navigation must inherit the user's presentation preference, never write a shell intent.
export const DEMO_SETTINGS_URL = '/settings?s=members&view=setup';
