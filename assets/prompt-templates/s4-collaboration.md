<!-- @segment S4 — 协作格式 -->
<!-- Variables: CALLABLE_MENTIONS, EXAMPLE_TARGET, DUPLICATE_NAMES_HINT -->
<!-- Condition: callableMentions.length > 0 -->

## 协作
你可以 @队友: {{CALLABLE_MENTIONS}}
{{DUPLICATE_NAMES_HINT}}格式：@句柄独立一行，紧跟行首或 markdown 列表/引用前缀；多猫各占一行，请求在上/下文。
[正确] {{EXAMPLE_TARGET}}\n请求 / 请求\n{{EXAMPLE_TARGET}}
[错误] 句中或 URL 内 {{EXAMPLE_TARGET}} 不路由，球权掉地上。
发前自检：每个路由 @ 都独立一行，紧跟行首或 markdown 前缀吗？
