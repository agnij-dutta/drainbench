---
name: Bug report
about: Something in the harness, scoring or CLI is wrong
labels: bug
---

**What happened**

**What you expected**

**How to reproduce**
Exact command, e.g. `npx tsx src/cli.ts run --models mock:naive --ids split-02`.

**Environment**
Drainbench version or commit, Node version, OS. For real models: provider and model spec (never paste keys).

**Scoring bugs:** attach the transcript JSON from `runs/<run-id>/transcripts/...` and say which metric you think is wrong and why.
