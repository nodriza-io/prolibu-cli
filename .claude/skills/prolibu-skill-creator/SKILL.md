---
name: prolibu-skill-creator
description: Create a new Prolibu CLI skill, or rebuild one that does not work, the way this repo's skills are made — research how the platform really does the task (backend code, the app's flows, live API), write the procedure in the standard shape, put fragile writes in a tested script, test live on a non-production account, measure it with evals and wire it into the skill map. Use it whenever someone asks to create, add or improve a skill ("make a skill so the CLI knows how to build a dashboard with several reports", "the forms skill fails, fix it"), or wants the CLI to learn a new kind of task. Spanish triggers: "créame una skill", "crea una skill para", "una skill que sepa", "mejora la skill de", "que el CLI aprenda a".
---

# Prolibu Skill Creator

## Central idea

A skill is **the procedure to do one kind of task the way the Prolibu app does it**, verified
against the platform's code, not a summary of documentation. The team's first skills failed
because they were indexes ("read chapter X first") that described the backend instead of the
workflow, made claims nobody checked, and were never measured. Every skill made with this one
must pass four gates:

1. **Verified:** every claim has evidence (code line, front flow or live call), kept in a
   private report outside the repo.
2. **Procedural:** `SKILL.md` alone tells an agent what to ask, what to run and how to check.
3. **Safe:** fragile writes live in a tested script that previews, needs `--confirmed`, and
   reads back.
4. **Measured:** evals run with `claude -p` on a test account pass before the skill is done.

The model to copy is `../prolibu-quotes/` (SKILL.md, `scripts/quote.js`,
`references/quote-model.md`, `evals/evals.json`, `test/prolibu-quotes.test.js`).

## Ask the user first

1. **The task, in their words, and 2–3 real requests** someone would type (they become evals).
2. **Who uses it:** developers of this CLI, product experts who don't code, or integrators.
3. **The test account:** a non-production domain under `accounts/` with an admin key. Ask
   what must never happen there (restarts of a shared account, emails to real people…).
4. **Where the sources are.** Backend and front code are private, so their location is
   personal: read `sources.local.json` next to this file (git ignores it). If it is missing,
   ask and save it:

   ```json
   {
     "backend": { "ssh": "<host or empty>", "path": "<repo path>", "ref": "origin/main" },
     "front": { "path": "<repo path>", "ref": "origin/develop" },
     "notes": ["<folders with team notes, if any>"]
   }
   ```

   Without code access, the skill can still be built from the OpenAPI spec and live reads,
   but say which claims could not be verified in code.

## Steps

1. **Check what exists.** Read `../prolibu-platform-map/SKILL.md` (the router). If a skill
   already covers part of the task, extend it instead of adding an overlapping one.
2. **Research where the truth is.** Read only; never modify, check out, restart or write in a
   source checkout (a backend checkout may be a live server).
   - **Backend:** the model (fields, defaults, validation), the route and controller, hooks
     that run on save, what is overwritten, side effects (restarts, emails, webhooks, created
     records), permissions. Read from `ref` with `git show <ref>:<path>` and `git grep`.
   - **Front:** how the app's screens do the task: which calls, in which order, with which
     payload, what they preserve, what they validate first. Read `ref` the same way.
   - **API:** `GET /v2/openapi/specification/<object>` and live reads through the helper.
     Rules every skill relies on are in
     `../prolibu-platform-map/references/api-conventions.md`.
   - **Team notes:** leads to check, never truth on their own (they often describe unmerged
     work).
   Write each claim with its evidence (`path:line@commit` or the live call) in a private
   report OUTSIDE the repo (for example a folder of verification notes the user picks).
3. **Write down the app's recipe** before writing the skill: the steps in order; what the
   server rejects; what it accepts silently but breaks (the traps); what the user must decide.
4. **Choose the shape.** A script is needed when a write has several steps, must preserve
   fields the user did not mention, or the server accepts mistakes silently. If a `./prolibu`
   command already does the job, the skill drives it, in its non-interactive form only.
5. **Write `SKILL.md`** from `assets/SKILL.template.md`: 100–200 lines, the sections in its
   order, English, plain short sentences. Deep detail goes in `references/*.md`.
6. **Write the script** (if any) from `assets/script.template.js`, on `createClient` from
   `../_shared/prolibu-api.js`: JSON output; exit codes 0/1/2/3; a `preview` that writes
   nothing and returns a version; a write command that needs that version and
   `--confirmed`; inline JSON input; a read-back that checks the result.
7. **Write the tests** in `test/prolibu-<skill>.test.js`, with a fake fetch shaped after the
   verified server behavior. Break the code on purpose once per rule: a test that does not
   fail proves nothing.
8. **Test live** on the test account: only records you create, named `QA Skills · …` (codes
   `qa-skills-…`), kept afterwards. Anything that restarts a shared account, emails people or
   calls outside services waits for the user's explicit yes.
9. **Measure with evals.** Write `evals/evals.json` (3–5 requests with concrete
   expectations; account values as placeholders). Put the concrete prompts for the test
   account in a local cases file, then run:

   ```
   node .claude/skills/prolibu-skill-creator/scripts/run-evals.js --cases <cases.json> --out <dir>
   node .claude/skills/prolibu-skill-creator/scripts/summarize-evals.js <dir>
   ```

   When rebuilding a skill, run the same cases against the old version (`--cwd` on a
   worktree of the old commit) to show the difference. Fix and rerun until every case
   behaves as expected. Read `references/evals.md` for the cases format and how to judge.
10. **Wire it in:** a row in the router table of `../prolibu-platform-map/SKILL.md`, a row in
    the table of `AGENTS.md`, and README only if users need to know. `npm run test:skills`
    already picks up `test/prolibu-*.test.js`.
11. **Check before committing:** `node .claude/skills/prolibu-skill-creator/scripts/check-public.js`
    must report nothing. The repo is public: no backend paths, internal domains, real ids,
    keys, or names of people or customers.

## Report to the user

What the skill does, what was verified and how, the live records created (ids), the eval
results (and the old version's, when rebuilding), bugs found in the platform, CLI or front
(with the private report's location), and open decisions.

## Don't

- Write a skill from documentation or memory alone, or copy a claim you could not verify
  (mark it unverified instead).
- Make the skill say "read the guide first": the procedure goes in the skill.
- Let a skill write through hand-made calls when the task has traps: put them in a script.
- Run interactive `./prolibu` commands from a skill (they hang an agent).
- Commit the private report, `sources.local.json`, eval transcripts or anything from
  `accounts/`.
