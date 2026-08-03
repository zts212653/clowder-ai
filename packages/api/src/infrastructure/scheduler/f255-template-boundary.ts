export const F255_PRESENT_LOOP_TEMPLATE_ID = 'present-loop';

interface PackTemplateLookup {
  get(templateId: string): { builtinTemplateRef: string } | null;
}

export function isF255PresentLoopBuiltinRef(builtinTemplateRef: string): boolean {
  return builtinTemplateRef === F255_PRESENT_LOOP_TEMPLATE_ID;
}

export function isF255ConfigOnlyTemplate(templateId: string, packTemplateStore?: PackTemplateLookup): boolean {
  if (templateId === F255_PRESENT_LOOP_TEMPLATE_ID) return true;
  const packTemplate = packTemplateStore?.get(templateId);
  return !!packTemplate && isF255PresentLoopBuiltinRef(packTemplate.builtinTemplateRef);
}

export function f255ConfigRequired() {
  return {
    error: 'Present Loop is configured from the cat home in /starry, not as a raw schedule task',
    code: 'F255_CONFIG_REQUIRED',
  } as const;
}
