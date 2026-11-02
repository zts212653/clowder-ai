# Same-process follow-up recordings

`followup-default.ndjson` and `followup-immediate.ndjson` are sanitized protocol
fixtures derived from official AGY CLI 1.4.5 captures on 2026-10-23. The names
refer to the captured default and `send-immediately` settings, not a claim that
headless execution supports immediate steering. Each recording contains two
inputs and two results within one conversation.

The 14 and 16 protocol events retain their original order, step indices, states,
tool names, text chunks, final responses, durations, and usage counters. This
preserves the regression's actual boundaries: per-turn accounting must not use
cumulative result usage, and the first turn's tools must not leak into the next.

Recorder-only metadata is omitted. Conversation IDs are consistent fixture
aliases; the initial working directory and file-read path use `/fixture/workspace`.
Tool outputs are inert fixture text. No account state, credentials, host paths,
or original command identifiers are included. The test only replays these JSON
records; it does not execute their commands, read their paths, or invoke a model.

Original capture SHA256 values (for maintainer provenance; originals are not
required or distributed with the test):

- Default: `c75d5d88503140b5f603658bb3ed7f84a61ab0c0f00bd3bfdc594c2e118b7775`
- Immediate: `286c410eefda2ae7a3e027006a0344f45a6d6a66f7e4574725ff5d72fb0a579b`
