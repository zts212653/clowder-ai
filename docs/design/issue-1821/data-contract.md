# Context receipt proposal: data and review boundaries

This file records the data boundaries for Issue #1821 / PR #1823. The concrete design direction was accepted in [the maintainer response](https://github.com/zts212653/clowder-ai/pull/1823#issuecomment-6690153941); implementation and product verification are in progress. All screenshot content must be synthetic.

## Default summary

The default view must describe a recorded context delivery to a specific receiver. A task theme cannot be invented from a provider, a thread identifier, a missing baton, or a count.

| Information | Current source | Display boundary |
| --- | --- | --- |
| Receiving cat | `buildBriefingMessage` options `receiverDisplayName` / `receiverCatId`, copied from actual serial/parallel routing | Use the recorded name, then recorded ID. Old cards without either say it was not recorded. |
| Sender and handoff excerpt | `options.baton.fromSpeakerDisplay` / `mentionExcerpt` | Quote or shorten the recorded excerpt faithfully. No baton means the handoff source is not recorded; it does not prove the operator directly invoked the cat. |
| Recent dialogue supplied | `coverageMap.burst` | Describe it only when the new card explicitly records the corresponding available context. Counts belong in the expanded view. |
| Anchors / memory | `anchorSummaries` / `threadMemorySummary` | Distinguish supplied summaries from pointers and search suggestions. Do not turn a candidate pointer into a claim that source text was supplied. |
| Source references | `rankedSources` through `selectDirectiveSources`, persisted navigation fields | A reference is a lookup entry; do not claim its entire document was included. |
| Old cards | Persisted `title`, `fields`, `bodyMarkdown`; receiver/coverage metadata may be absent | Preserve their inspectable original information and show honest missing fields. Do not reconstruct current responsibility or delivery state from historical text. |

A synthetic excerpt such as “请核对侧栏菜单的可见性” can illustrate the default view only if the proposal explicitly marks it as a recorded handoff excerpt. A default summary requiring new structured display metadata must be identified in the notes; it is not already present in every historical card.

## Expanded content

Use one clear expansion entry. Separate human-readable handoff/source material from technical diagnostics by headings and typography, without a second expansion hurdle. Preserve the inspectable information once rather than repeating the title, navigation fields, and raw body in multiple places.

Keep original commands, complete IDs, source references and raw diagnostic values accessible. `cold` does not mean “no history”; T0/T1/T2 are source/evidence tiers, not delivery modes or task completion states. Missing sources, missing recipients, and unrecorded coverage are separate facts.

## Required review specimens

- Approximately 600 px available chat column, plus 320 px and 375 px viewports.
- Light and dark appearances, collapsed and expanded states.
- Synthetic long unbroken thread IDs, commands and paths.
- A historical card without receiver/coverage metadata.
- A card with no recorded receiver and no recorded handoff/source, without guessed facts or misleading zeroes.
- Annotated screenshots in the message-flow context, with proposal status visible outside the component.

The visual direction is aligned. The next gates are production-component evidence, substantive independent code review, current checks and formal approval. The existing PR remains Draft while implementation is being verified.
