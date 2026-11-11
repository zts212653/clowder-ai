import loadOrder from '../../public/pdl/load-order.json';
import { chatModels } from './chat-models';
import { frameRequest } from './frame-bridge';
import type { ChatPort } from './types';

const { scripts, styles } = loadOrder;

export const scriptSources = [
  ...scripts.map((path) => `/pdl/${path}`),
  '/pdl-app/api.js',
  '/pdl-app/appearance.js',
  '/pdl-app/plugin-config.js',
  '/pdl-app/plugins.js',
  '/pdl-app/starry.js',
  '/pdl-app/workbench-data.js',
  '/pdl-app/planning-data.js',
  '/pdl-app/work-details.js',
  '/pdl-app/content-data.js',
  '/pdl-app/project.js',
  '/pdl-app/project-owners.js',
  '/pdl-app/owner-projections.js',
  '/pdl-app/members.js',
  '/pdl-app/watcher.js',
  '/pdl-app/matters.js',
  '/pdl-app/home.js',
  '/pdl-app/sidebar.js',
  '/pdl-app/inbox.js',
  '/pdl-app/accounts.js',
  '/pdl-app/profiles.js',
  '/pdl-app/capabilities.js',
  '/pdl-app/rules.js',
  '/pdl-app/thread-settings.js',
  '/pdl-app/notifications.js',
  '/pdl-app/setup.js',
  '/pdl-app/chat-owners.js',
  '/pdl-app/placement.js',
  '/pdl-app/chat.js',
];

let startup: Promise<void> | undefined;

export function mountChat(port: ChatPort): Promise<void> {
  startup ??= startChat(port);
  return startup;
}

async function startChat(port: ChatPort): Promise<void> {
  window.clowderFrameRequest = frameRequest;
  if (document.readyState === 'loading')
    await new Promise<void>((resolve) =>
      document.addEventListener('DOMContentLoaded', () => resolve(), { once: true }),
    );
  for (const path of styles) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `/pdl/${path}`;
    await new Promise<void>((resolve, reject) => {
      link.onload = () => resolve();
      link.onerror = () => reject(new Error(`Failed to load ${path}`));
      document.head.append(link);
    });
  }
  for (const path of scriptSources) {
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = path;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Failed to load ${path}`));
      document.body.append(script);
    });
  }
  await window.clowderChat.start(port, chatModels);
}
