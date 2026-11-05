import type { ComponentProps } from 'react';
import { MessageNavigator } from '../MessageNavigator';
import { ScrollToBottomButton } from '../ScrollToBottomButton';
import { useShellPresentation } from '../shell/shell-presentation';

/** Conversation controls disappear with the history presentation; message and reading owners stay mounted. */
export function ThreadChatHistoryNavigation({
  visible,
  bottomProps,
  navigatorProps,
}: {
  visible: boolean;
  bottomProps: ComponentProps<typeof ScrollToBottomButton>;
  navigatorProps: ComponentProps<typeof MessageNavigator>;
}) {
  const presentation = useShellPresentation();
  if (!visible) return null;
  return (
    <>
      {presentation === 'v2' ? (
        <ScrollToBottomButton {...bottomProps} placement="rail" />
      ) : (
        <ScrollToBottomButton {...bottomProps} />
      )}
      {(presentation === 'v2' || navigatorProps.messages.length > 5) && <MessageNavigator {...navigatorProps} />}
    </>
  );
}
