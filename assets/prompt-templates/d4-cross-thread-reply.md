<!-- @segment D4 — 跨 thread 回复 -->
<!-- Variables: SOURCE_THREAD, SENDER_CAT, EFFECT_LABEL -->
<!-- Condition: context.crossThreadReplyHint exists -->

📨 来自跨线程消息（source thread: {{SOURCE_THREAD}}，发件猫: @{{SENDER_CAT}}）{{EFFECT_LABEL}}
回复请用 cross_post_message(threadId="{{SOURCE_THREAD}}", targetCats=["{{SENDER_CAT}}"])
本 thread 的 @{{SENDER_CAT}} 不会路由回对方（对方 session 在另一个 thread）
