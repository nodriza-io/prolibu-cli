---
name: prolibu-<topic>
description: <What it does, in one sentence, the way the app does it>. <What it covers: the main steps and decisions>. Use it whenever someone <wants…>, or reports <symptoms in the user's words>. Spanish triggers: "<…>", "<…>".
---

# Prolibu <Topic>

## Central idea

<One paragraph: what the thing is in the platform, where it lives, and the one rule that
breaks things when ignored.>

`scripts/<topic>.js` does the fragile parts in code: <what it preserves, validates, reads
back>. Your job is the conversation: <what to agree with the user>, show the preview, and
write only after a clear yes.

```
node .claude/skills/prolibu-<topic>/scripts/<topic>.js <command> <domain> …
  <read commands>
  preview <domain> '<plan json>'                       writes nothing; returns a version
  apply   <domain> '<plan json>' --version <v> --confirmed
```

Output is JSON. Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked
(nothing written).

## Ask the user first

In plain business terms:

1. <The decision the user must make, with the default if any.>
2. <…>

If `accounts/` has several domains, ask which one.

## Steps

1. **Read.** <command> — note <what>.
2. **Plan.** <the JSON plan, with an example and the fields allowed>.
3. **Preview.** <what to tell the user from the output>.
4. **Wait for an explicit yes.** <which changes need their own yes>.
5. **Write.** <command>; it refuses when <conditions>.
6. **Report.** <what to give the user>.

## How the platform behaves

Details and edge cases are in `references/<topic>-model.md`. Read it when a case falls
outside the steps.

- **<Rule>.** <Consequence and what the script does about it.>

## Symptoms

| Symptom | Cause | Fix |
| --- | --- | --- |
| <what the user sees> | <verified cause> | <what to do> |

## Verify

- <What the read-back checks, and what to give the user.>

## Don't

- <Each way people get this wrong.>

## Writing to an account

Reads and writes follow [`../_shared/WRITE-FLOW.md`](../_shared/WRITE-FLOW.md): domain, reads
only, plain summary, explicit yes, write, read back. `preview` is the summary step and
`apply` the write. For how objects relate, see `prolibu-platform-map`.
