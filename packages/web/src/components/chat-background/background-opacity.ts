import type { BackgroundOpacity, ChatBackgroundImageState as ChatBackgroundImage } from '@cat-cafe/shared';

/** Contrast is a safety boundary; the automatic image should remain quiet enough for ordinary work. */
export function recommendedBackgroundOpacity(readable: BackgroundOpacity): BackgroundOpacity {
  return { light: Math.min(readable.light, 0.2), dark: Math.min(readable.dark, 0.2) };
}

/** Preserve inferred legacy manual intent before a new recommendation happens to equal that value. */
export function backgroundManualModes(image: ChatBackgroundImage): Record<keyof BackgroundOpacity, boolean> {
  return {
    light: image.manualOpacity?.light ?? image.opacity.light !== image.recommendedOpacity.light,
    dark: image.manualOpacity?.dark ?? image.opacity.dark !== image.recommendedOpacity.dark,
  };
}

export function backgroundImagePreference(
  selection: Pick<ChatBackgroundImage, 'url' | 'name' | 'placement'>,
  readableOpacity: BackgroundOpacity,
  previous?: ChatBackgroundImage,
): ChatBackgroundImage {
  const recommendedOpacity = recommendedBackgroundOpacity(readableOpacity);
  return {
    ...selection,
    kind: 'image',
    opacity: previous ? followAutomaticBackgroundOpacity(previous, recommendedOpacity) : recommendedOpacity,
    recommendedOpacity,
    readableOpacity,
    manualOpacity: previous ? backgroundManualModes(previous) : { light: false, dark: false },
  };
}

/** Each mode follows its recommendation until the user chooses a different opacity. */
export function followAutomaticBackgroundOpacity(
  image: ChatBackgroundImage,
  next: BackgroundOpacity,
): BackgroundOpacity {
  const manual = backgroundManualModes(image);
  return {
    light: manual.light ? image.opacity.light : next.light,
    dark: manual.dark ? image.opacity.dark : next.dark,
  };
}
