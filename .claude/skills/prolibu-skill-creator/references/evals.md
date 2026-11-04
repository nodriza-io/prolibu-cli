# Evals: how to measure a skill

A skill is done when an agent that only has the repo does the task right for realistic
requests. Measure that with `claude -p` sessions on a non-production account.

## Two files

- **`evals/evals.json`** (committed): the requests with placeholders and the expectations.

  ```json
  {
    "skill_name": "prolibu-<topic>",
    "setup": "What the test account needs before running (records, settings).",
    "evals": [
      {
        "id": 1,
        "prompt": "Add 3 units of <product> to the quote of the deal <deal>.",
        "expected_output": "One sentence: what a good run does.",
        "expectations": ["Concrete, checkable statements about the run and the account."]
      }
    ]
  }
  ```

- **A cases file** (never committed: it names real test records), the concrete prompts for
  `scripts/run-evals.js`:

  ```json
  {
    "allow": [],
    "cases": [
      { "id": "q1", "prompt": "Add 3 units of Room B to the quote of the deal \"QA Skills · quote\".", "reply": "Yes, go ahead." },
      { "id": "q3", "prompt": "Add a 'Custom onboarding package' to the same deal for 500." }
    ]
  }
  ```

  `reply` adds a second turn on the same session: usually the user's yes, or a change of mind
  ("OK, only the quantity then") to check that the agent previews again. A flow with two yeses
  (build a report, then the dashboard) uses `"replies": ["Yes.", "Yes, the dashboard too."]`.
  `"allow"` adds tools a skill needs beyond the defaults (for example `Bash(./prolibu vt push:*)`);
  `"deny"` (top level or per case) blocks commands a case must not reach, such as a script's
  send command. A case that ends after turn 1 measures "stops before writing": use it for
  anything that must never run on a shared account (sends, triggers), and deny the command
  too, because a child session could add `--confirmed` by itself.

## Pick the cases

3–5 per skill, covering:

- the main flow, end to end, including the write after the yes;
- the same flow in Spanish (the agent must answer in Spanish);
- a trap the skill exists for (a closed deal, a duplicated id, a private URL, a field that
  would be dropped);
- a request the skill must refuse or redirect (an API key, a forbidden object);
- a diagnosis ("it says sent but nothing was created").

## Run

```
node .claude/skills/prolibu-skill-creator/scripts/run-evals.js --cases /tmp/cases.json --out /tmp/evals-<topic>
node .claude/skills/prolibu-skill-creator/scripts/summarize-evals.js /tmp/evals-<topic>
```

- Cases run one after another (they may share records). A two-turn case takes one to three
  minutes and costs about $0.50–1.50; a hard diagnosis can take 50 turns and $3. A full set
  of 3–5 cases is roughly $5–25. Run the command in the background and wait for it to finish;
  use a new `id` for a rerun so the old transcript stays.
- The child sessions may only use the skills' scripts, the generic helper, the non-interactive
  `./prolibu` commands, read tools, and writes under `accounts/` and `/tmp`. Add tools with
  `"allow"` when a skill needs more.
- To compare with an older version: `git worktree add /tmp/old <old-commit>`, link
  `node_modules`, copy `accounts/<domain>/profile.json` into it, and run with `--cwd /tmp/old`.
  Remove the worktree afterwards: it holds a copy of the key.

## Judge

Read every summary; for writes, also read the account afterwards. A case passes when:

- the agent loaded the right skill and used its script (not hand-made calls);
- it read before writing, showed a plain preview with the server's numbers, and wrote only
  after the yes;
- the account ends as expected (read it back yourself);
- it refused or stopped where it should, without looking for a way around;
- it answered in the user's language, without jargon.

The summary prints flags to look at first:

- `FLAG: wrote in turn 1` — the agent wrote before the user could answer the preview. This
  fails the case: strengthen the preview's `nextStep` (see `patterns.md`).
- `FLAG: … profile*.json` — the agent tried to read an API key. This fails the case even when
  the harness denied it: change the skill so it never needs to (the runner also replaces any
  key that reaches a transcript with `***`).

Things that look like failures but are the harness: a `DENIED` for a compound shell command
(`a; echo $?`) or a write outside `accounts/` and `/tmp`. A real user would get a permission
prompt instead. Rerun the case if the denial blocked the main flow.

When a case fails, fix the skill (or its script), rerun that case once under a new id, and
say in the report what changed and why.
