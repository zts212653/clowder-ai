# AGY subagent lifecycle fixture

Captured by the native provider from the installed official Antigravity CLI 1.5.12.
The reported failure contained steps 236–239, each with ACTIVE and DONE updates.
The runtime archive was captured on 2026-11-23; its original coordinates remain
in the incident Task's local replay evidence. Only the eight relevant `step_update` envelopes were extracted;
no child conversation or child log was read.

Conversation IDs, agent declarations, task prompts, log URIs and workspace URIs
are replaced by inert fixture values. Field presence, lifecycle states, tool
names, array lengths, indices and durations preserve the observed wire shape.
The tests add synthetic parent input/response/result events; those are not
represented as captured provider output.

`subagent/DONE` acknowledges the `invoke_subagent` operation and returns child
conversation references. It does not independently prove the children finished
their tasks. Child outputs must not become parent response text.

Sparse terminal updates, reference-only child entries, hook-refused or partially
started ERROR updates, concurrent generic output, long prompts, and mixed child
text in the tests are synthetic counterexamples. They are not additional
observations of this CLI. The complete captured frames do not establish a global
requirement to repeat request fields or child references in every update.
