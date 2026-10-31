'use client';

import React from 'react';
import { ClassicMessageNavigator, type MessageNavigatorProps } from './ClassicMessageNavigator';
import { PianoMessageNavigator } from './message-piano/PianoMessageNavigator';
import { useShellPresentation } from './shell/shell-presentation';

export { messageNavigatorPreviewText } from './ClassicMessageNavigator';

export function MessageNavigator(props: MessageNavigatorProps) {
  return React.createElement(useShellPresentation() === 'v2' ? PianoMessageNavigator : ClassicMessageNavigator, props);
}
