<!-- @segment B1 — Session Bootstrap -->
<!-- Variables: SESSION_NUM, TOTAL_SESSIONS, SEALED_COUNT, CAT_HANDOFF_NOTE, -->
<!--   THREAD_MEMORY, PROJECT_RECALL, SESSION_DIGEST, TASK_SNAPSHOT, TOOL_INSTRUCTIONS -->
<!-- Condition: Session #2+ (first session returns null) -->
<!-- Note: Runtime uses token-budgeted section selection (max 2000 tokens). -->
<!--   Sections drop in priority order: recall → task → digest → memory. -->
<!--   Identity + handoff note + tools are always-keep. -->

[Session Continuity — Session #{{SESSION_NUM}}]
This is session #{{SESSION_NUM}} of {{TOTAL_SESSIONS}} total sessions for this thread.
{{SEALED_COUNT}} previous session(s) are sealed and searchable.

{{CAT_HANDOFF_NOTE}}

{{THREAD_MEMORY}}

{{PROJECT_RECALL}}

{{SESSION_DIGEST}}

{{TASK_SNAPSHOT}}

[Session Recall — Available Tools]
{{TOOL_INSTRUCTIONS}}
