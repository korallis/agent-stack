Owner brief for the @RIG@ rig, from @OPERATOR@ on the owner's behalf.

1. Re-read your instruction file: CULTURE.md (Owner decisions and "@PROJECT@ specifics") was filled in after launch.
2. Build the plan in @WORK@/docs/PLAN.md. Process: research, plan, implement, verify.
   - One mission per area of the plan (per issue for an issues project). Slices with SPEC.md: intent, status,
     depends_on, Territory, proof contract, and the research findings and choices.
   - Waves in each mission.yaml arrangement.waves. Load-bearing work (schema, auth, payments, data changes) gets its
     own wave. A W witness slice ends each user-facing wave.
   - The architect researches first (the repo's AGENTS.md or CLAUDE.md, docs, the code the plan touches) and writes
     docs/VERIFY.md (verification-guide) before the first wave.
3. Merge path and environments: see CULTURE "@PROJECT@ specifics". Seats use only .env.local.
@WORKFLOW@
5. Run `agent-project-check @PROJECT@` after planning. No FAIL before builders are dispatched.
Report plan-ready to @OPERATOR@ as a queue row before any builder starts; then report each finished mission. FYIs
to the owner use --human-intent update.
