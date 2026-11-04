---
name: prolibu-academy
description: Work the Prolibu Academy (learning module) the way the app does — build programs and courses with their modules and lessons in order (article, video, quiz linked to an assessment), publish them so the right people see them, enroll users (the server checks that each person can reach the course through a published program), see who has not finished a course, mark Manual lessons done as an instructor, and explain why someone did or did not get a certificate (and issue it when it was missed). Use it whenever someone asks to create or publish a course or program, enroll people, check training progress, or asks about a missing certificate. Spanish triggers: "crea un curso", "curso de inducción", "agrega lecciones", "publica el curso", "inscribe a", "inscríbelos en el programa", "quién no ha terminado el curso", "avance del curso", "no le salió el certificado", "certificado del curso", "academia", "capacitación".
---

# Prolibu Academy

## Central idea

A **Program** groups courses and decides who sees them. A **Course** holds **Modules**, and
each module holds **Lessons** (Article, Video, Quiz or File). Order comes from each record's
`order` field, not from the lists. A student only reaches a course through a program that is
**Published**, active, and open to everyone or to one of the student's teams. Admins see every
published program.

An **Enrollment** is one person taking one course, optionally under a program. Progress is the
share of **required** lessons done. At 100% the enrollment becomes Completed by itself. That
issues the course **Certificate** if the course has certificates on, and a badge if the course
has one. The program certificate is checked at the same moment. Nothing in this flow sends an
e-mail or a notice, except the badge.

`scripts/academy.js` does every write and check:

```
node .claude/skills/prolibu-academy/scripts/academy.js <command> <domain> …
  programs <domain>                            programs, access, certificate settings
  course <domain> <course id|code|name>        outline in student order + publish check
  progress <domain> <course> [--status NotFinished|InProgress|Completed|Failed]
  diagnose <domain> <user e-mail> <course>     why a certificate was or was not issued
  certificates <domain> [--user e-mail]
  preview <domain> '<plan>'  →  apply <domain> '<plan>' --version <v> --confirmed [--reaches-people]
```

Output is JSON. Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked
(nothing written). Every command takes `--profile <name>`. Plans go inline in single quotes,
or as a path to a temp file.

## Ask the user first

1. **Which account.** If `accounts/` has several domains, ask.
2. **To build:** course name, modules and lessons in order, the text or video link of each
   lesson, which lessons are optional, and the program it belongs to (new or existing).
3. **Who may see it:** everyone, or some teams (teams are managed in the app).
4. **Certificate:** on or off, for the course and for the program. The design is HTML with
   the variables in `references/academy-model.md`. If the user has no design, say the
   certificate will have no PDF until one is added in the app.
5. **To enroll:** the people's e-mails, the course, and the program if the course is in several.

## Steps

**See what exists.** `programs`, then `course <name>` shows modules and lessons in order, the
programs that hold it and a publish check (`blockers`, `warnings`).

**Build a course.** Preview a build plan. A new course is created as **Draft**.

```json
{"kind": "build",
 "program": {"programName": "Onboarding", "allowEveryone": true, "certificate": {"enabled": true, "template": "<div>…[[userName]]…</div>"}},
 "course": {"courseName": "Induction", "level": "Beginner", "estimatedDuration": 60,
            "certificate": {"enabled": true, "template": "<div>…[[courseName]]…</div>"}},
 "modules": [
   {"moduleName": "Welcome", "lessons": [
     {"lessonName": "Who we are", "type": "Article", "content": "<p>…</p>"},
     {"lessonName": "Welcome video", "type": "Video", "videoUrl": "https://…"},
     {"lessonName": "Check", "type": "Quiz", "assessment": "<assessment name|id>", "minScore": 80},
     {"lessonName": "Role play", "type": "Article", "content": "<p>…</p>", "completionRule": "Manual"}]}]}
```

- `program` is a new program object or an existing one's name, code or id. The course is added
  to it and, unless `"requiredInProgram": false`, counts for the program certificate.
- To add to an existing course, give `"course": "<name|code|id>"`. Use `{"module": "<existing
  name|id>", "lessons": […]}` to append to a module. `"set": {…}` changes course fields
  (certificate, level, navigationMode…); the certificate design is kept when only `enabled`
  changes.
- Quiz lessons need an assessment that exists. Questions are written in the app's assessment
  designer. File lessons are created in the app, because files are uploaded there.
- `completionRule`: View (default), Interact, Score (default for quizzes), Manual (only an
  instructor completes it). `"required": false` makes a lesson optional.

**Publish.** `{"kind":"publish","course":"Induction","program":"Onboarding"}` (or only one of
them; `"status":"Draft"` or `"Archived"` takes it down). The preview blocks a course with no
required lessons or a quiz without an assessment. It also warns about a program open to nobody.

**Enroll.** `{"kind":"enroll","course":"Induction","program":"Onboarding","users":["a@example.com"]}`.
The preview blocks people who cannot reach the course and skips people already in progress.
A person who completed it before starts a new attempt. It picks the program when there is only
one; the program is what makes the course count toward the program certificate. Say plainly that
**nobody is told**: the person finds it on their home. A non-admin also needs a role with
Academy permissions, which an admin gives in the app.

**Who has not finished.** `progress <course> --status NotFinished`. Only people who enrolled
appear. Compare with the user's list to find who never enrolled.

**Missing certificate.** `diagnose <e-mail> <course>`. Explain `findings` in plain words and
offer the fix it names:
- lessons pending → the student finishes them; Manual ones → a complete plan
  `{"kind":"complete","user":"a@example.com","course":"Induction","lessons":["Role play"]}`;
- completed but certificate off, or turned on later → turn it on (`set`), then
  `{"kind":"reissue","user":"a@example.com","course":"Induction"}`.

Every write: `preview`, show the user `changes`, `recipients`, `warnings` and `blockers`, stop.
After a yes, `apply` with the preview's `--version` and `--confirmed`. When `recipients` is not
empty (a badge e-mails the person), add `--reaches-people` only after a yes to those people.

## How the platform behaves

Details and evidence are in `references/academy-model.md`.

- **Progress only moves when a lesson is saved.** Adding required lessons to a published course
  lowers everyone's percentage the next time they save a lesson. Completed enrollments stay
  completed.
- **Completion rules are enforced by the app, not the server.** The server counts any lesson
  marked done.
- **Certificates are issued once per enrollment**, when it becomes Completed. Turning
  certificates on later does not certify people who already finished: use `reissue`.
- **The PDF** is made from the design at issue time. Without a design, or if the print service
  fails, the certificate has no PDF and cannot be regenerated. The app still shows its page.
- **The program certificate** needs every required course of the program completed by enrollments
  linked to that program. It is only checked while a course certificate is being issued, so a
  required course with certificates off never triggers it.
- **Expiry** comes from an account preference (days; 0 = never).

## Symptoms

| Symptom | Cause | Fix |
| --- | --- | --- |
| Student does not see the course | Course or program Draft, or program not open to them | `course`, then publish or add their team in the app |
| "This course is not available for you" | Same, when the student enrolls | Same |
| Course on their home but it does not open | Their role has no Academy permissions | An admin gives the role in the app |
| Stuck below 100% | Pending required lesson, often Manual | `diagnose`, then `complete` |
| Completed, no certificate | Certificate was off at completion | `set` certificate on, then `reissue` |
| Certificate without PDF | No design, or the print service failed | Add a design for future ones |
| No program certificate | Enrollment not linked to the program, or a course with certificate off | `diagnose` |

## Verify

- `apply` reads the records back and lists anything that did not save under `problems`.
- After a build, run `course` and check the order and the publish check.
- After enroll, run `progress`; after complete or reissue, run `certificates --user`.

## Don't

- Write lessons, enrollments or progress with hand-made calls: the script keeps order, the
  program link and the checks.
- Enroll people the user did not name, or mark lessons done that the user did not confirm.
- Delete programs, courses, enrollments or certificates, or edit certificates directly.
- Create users, teams or roles, or change anyone's permissions.
- Put scripts, inline handlers or `javascript:` links in lesson content or certificate designs.

## Writing to an account

Reads and writes follow [`../_shared/WRITE-FLOW.md`](../_shared/WRITE-FLOW.md): domain, reads
only, plain summary, explicit yes, write, read back. `preview` is the summary step. A `403`
means the profile's user may not do that; sellers usually have no Academy permissions. Stop and
say so; never retry it another way or with another profile. Quiz questions and file uploads are
done in the app. Teams and roles belong to the account admin. Badges are configured in the app's
achievements module.
