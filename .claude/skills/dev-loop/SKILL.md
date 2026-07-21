---
name: dev-loop
description: Drive a full-loop, sub-agent-based development cycle for rlbotline — architect → developer(s) → test → doc-sync → review. Use when the user wants a feature or non-trivial change shipped through the specialized sub-agents instead of doing it inline. Trigger, e.g. "/dev-loop add anti-flood to worker".
---

# /dev-loop — Sub-agent development loop

You are the **orchestrator**. You do NOT implement, design, or review directly — you delegate each
stage to the specialized sub-agent via the `Agent` tool and carry the hand-off forward. Full
reference: `.github/workflows-docs/subagent-dev-loop.md`.

## The roster (`.claude/agents/`)
`solution-architect` · `worker-developer` · `api-developer` · `web-developer` ·
`test-engineer` · `doc-sync` · `code-reviewer` · `security-reviewer` · `debugger`

## The loop

1. **Architect.** Spawn `solution-architect` with the request. It returns an ordered task
   breakdown (`spec → backend → worker → frontend → docs`), the files per stack, the contract
   delta, and risk flags (auth/creds/token/proxy/container → needs `security-reviewer`).
   - If it says the task is trivial + single-stack, skip to the one named developer.

2. **Docs-first when a contract moves.** If the breakdown changes a route/payload/webhook/DB
   schema, spawn `doc-sync` to update `docs/api-spec.md` FIRST (edit order is spec-first). Otherwise
   defer docs to step 5.

3. **Implement, per stack, in order** (`api-developer` → `worker-developer` → `web-developer` —
   only the ones the architect listed). Pass each developer its file list + contract delta. Each
   developer must run its own verify gate and report real output.

4. **Test.** Spawn `test-engineer` to add coverage and run the verify gate(s). On RED → spawn
   `debugger`, get the root cause + fix target, route back to the owning developer, then re-test.
   Do not advance on a red gate.

5. **Sync docs.** Spawn `doc-sync` to bring `docs/*-architecture.md` (and spec, if not already) in
   line with what shipped.

6. **Review.** Spawn `code-reviewer` on the working diff. Findings route back to the **owning**
   developer, then re-review. If the change touched auth/creds/token/proxy/container, ALSO spawn
   `security-reviewer`.

7. **Done** only when: every stack's verify gate is green, docs are synced, and review findings are
   resolved. Summarize what shipped and the gate output for the user.

## Rules
- Never let a developer silently change a contract — that belongs to `solution-architect`/`doc-sync`.
- "Green" = the stack's REAL command passed: worker/api `bun run verify`; web
  `bunx tsc --noEmit && next build`.
- Prefer continuing an existing agent (SendMessage) over re-spawning cold when iterating.
- Keep the user in the loop at decision points; surface each agent's key result, not raw transcripts.
