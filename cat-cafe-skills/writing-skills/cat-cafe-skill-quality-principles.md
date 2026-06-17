# Cat Café Skill Quality Principles

**Load this reference when:** writing or reviewing a Cat Café skill and the question is whether the skill is valuable, overbroad, too tutorial-like, or should be a hook/MCP description/reference instead.

## Thesis

Good skills do not teach smart cats to write for loops.

Good skills put domain know-how, historical traps, evidence standards, and behavior brakes where cats naturally pass during work.

If a skill mostly repeats generic coding knowledge already in strong model weights, it is not neutral. It spends context, anchors the agent to boilerplate, and can hide the repo-specific judgment that actually matters.

## Value Gate

Before writing a skill, answer this table. If every answer is "no", do not write the skill.

| Question | Good answer |
|----------|-------------|
| Does it contain project/industry/vendor know-how the model is unlikely to know reliably? | Yes: write a skill or reference with source paths. |
| Does it encode a real Cat Café failure mode or operator correction? | Yes: include the exact trap and countermeasure. |
| Does it define an evidence standard for completion or escalation? | Yes: turn vague quality into checkable proof. |
| Does it stop a behavior the model knows is wrong but rationalizes under pressure? | Yes: write a discipline skill and pressure-test it. |
| Does it make an important tool or truth source discoverable at the right moment? | Yes: write a routing skill or MCP description. |
| Is the risky behavior mechanically detectable? | Use a hook/runtime guard instead of prompt-only instruction. |

## Four Useful Skill Shapes

### 1. Domain Know-How

Use for knowledge not safely recoverable from general training:

- repo-specific architecture boundaries
- vendor CLI/API quirks
- compliance constraints
- product vocabulary
- version-sensitive workflows, with "verify official source" instructions

Do not copy broad tutorials. A React skill that teaches component composition is weak. A Cat Café Console skill that explains our settings migration gates and known visual regressions is strong.

### 2. Historical Trap

Use when the skill prevents a failure that has actually happened.

Required ingredients:

- incident or thread anchor
- the tempting wrong move
- why the wrong move felt reasonable
- the exact countermeasure

The Common Mistakes section is often the most valuable part of the skill.

### 3. Evidence Standard

Use when agents tend to replace proof with confidence.

Good evidence standards say:

- what source to read
- what command/test/screenshot/log proves the claim
- what counts as BLOCKED
- what must not be inferred

Bad evidence standards say:

- "be careful"
- "make sure quality is high"
- "do a thorough review"

### 4. Behavior Brake / Cognitive Path

Use when the model can do the work but often skips the right path:

- TDD order under time pressure
- search/read before editing
- cross-cat review before merge
- ball ownership and routing
- using an installed tool the model does not naturally think to use

This is not "training wheels". It is cognitive path engineering: align good instincts, suppress bad instincts, and keep the agent inside the repo's truth system.

## Carrier Choice

| Need | Carrier |
|------|---------|
| Teach broad language/framework basics | Do not write; rely on model knowledge or official docs. |
| Keep long external API details | Reference file, loaded only on demand. |
| Route the agent to a tool/truth source | Skill description or MCP description. |
| Enforce a fragile exact sequence | Skill plus script; use low freedom. |
| Prevent irreversible or mechanically detectable failure | Hook/runtime guard. |
| Capture a reusable reasoning method | Method Card or skill draft, then evaluate. |
| Run open-ended brainstorming | Collaborative-thinking guardrails, not a rigid debate DAG. |

## Skills That Limit Ability

A skill is limiting when it:

- over-explains knowledge the model already has
- forces a fixed role/game/workflow where judgment should stay fluid
- broadens triggers until it loads for everything
- copies time-sensitive facts without requiring verification
- makes the agent recite process instead of acting
- substitutes "ask three agents" for evidence or clear ownership

The symptom: the agent becomes more compliant but less intelligent.

## Skills That Amplify Ability

A skill amplifies ability when it:

- shortens the path to the right tool or source
- names the exact rationalization that usually causes failure
- preserves independent thinking before discussion
- keeps disagreement visible until convergence
- turns vague quality into artifacts and commands
- moves stable procedures into scripts/assets instead of prose

The symptom: the agent spends less context deciding how to behave and more context solving the real problem.

## Proof Standard

Do not claim a skill works because it sounds wise.

Use a process TDD loop:

1. **RED**: run a realistic scenario without the skill and capture the failure.
2. **GREEN**: write the smallest skill that prevents that failure.
3. **PRESSURE**: rerun with time, sunk-cost, authority, or social pressure.
4. **FALSE POSITIVE**: test a near-miss where the skill should not trigger.
5. **REGRESSION**: keep the scenario as a replay case when the skill changes.

For knowledge-evolution skills, require replay/A-B evidence before promoting from draft to standard.

## Review Rubric

When reviewing a skill, answer:

1. What failure does this prevent?
2. Would a strong model already know this?
3. Is the trigger narrow enough?
4. Is the "not for" boundary explicit?
5. Does it cite a project truth source or real trap?
6. Does it choose the right carrier: skill, reference, script, MCP description, hook, or system prompt?
7. What pressure test proves it works?
8. What false-positive test proves it does not over-trigger?

If the best answer is "this is generally good advice", reject or demote to a reference.
