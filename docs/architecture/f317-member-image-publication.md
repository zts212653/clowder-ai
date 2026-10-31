---
feature_ids: [F317, F172]
topics: [member-publication, mcp-admission, artifact-surface]
doc_kind: architecture
created: 2026-10-10
updated: 2026-10-10
mcp_admission_status: accepted
mcp_admission_ref: "file:docs/architecture/f317-member-image-publication.md"
mcp_admission_claims:
  - ref: "file:docs/architecture/f317-member-image-publication.md"
    toolName: cat_cafe_publish_image
    resourceFamily: artifact-surface
    boundaryKind: resource-entry
    decision: accepted
---

# Ordinary member local-image publication

Accepted source `[thread-id]#private-source-id`
explicitly authorizes a governed local PNG publication entry within original
C / Task33 standing, reusing F172 and the callback/Message owners. The full
source was read. Implementation contract (internal).

This admits exactly `cat_cafe_publish_image / artifact-surface / resource-entry`.
It publishes authorized local PNG bytes and one durable image message in the
authenticated invocation's current thread. Identity cannot be supplied in the
request. The MCP adapter enforces existing file roots; the server accepts PNG
bytes and never opens the client-reported source path. Provenance says member
file publication, not native image generation. No Task mutation or owner migration.

The existing rich-block tool only stages presentation; the existing post-message
tool does not import a local image. This entry binds the image file and durable
message receipt with a single caller key through the existing F172/image-storage
and MessageStore owners. Same key/different bytes conflicts; display metadata
is fixed by the first durable Message, after which changed metadata or a withdrawn
or soft-deleted message conflicts too. Hard deletion keeps the existing store's
behavior: the in-memory store releases the key; Redis retains a tombstone and
returns 409. Use a new key for an intended new publication after that conflict;
a tombstone must never be returned as a successful publication.
Exact retries of current publications return the original message and revision.
Exposure is `full` only.

File reads support macOS (kernel `O_NOFOLLOW_ANY` for the whole path) and Linux
(opened descriptor resolved through `/proc/self/fd` before reading bytes); other
platforms or unavailable verification fail closed. Allowed roots inherit the
existing file-tool policy, including the ordinary member's legacy data-directory
root (normally `~/.cat-cafe`), not a new per-thread filesystem sandbox.
The thread must be created by the authenticated owner; system-created threads
without that ownership are rejected. An abrupt process death can leave an
unpublished `*.tmp` file in uploads; the final immutable filename never exposes
that incomplete file, and this entry does not introduce a background deletion job.

F232, PublishedMediaSource and F138 consume the existing URL/message/revision
without contract changes. New versions use a new image key and the caller's
existing content lineage. The entry grants no new native/model window, private
file scope, human impersonation, Work delegation or external provider access.
Independent review must cover this accepted source and the implementation;
this record is not author self-approval or evidence of a completed native journey.
