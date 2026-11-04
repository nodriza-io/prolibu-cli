# Academy model

How the Academy objects relate and behave, as the server and the app do it today.

## Objects

| Object | Route | Key fields |
| --- | --- | --- |
| Program | `/v2/program` | `programName`, `programCode` (ACP-…), `status` Draft/Published/Archived (default Draft), `active`, `courses[]`, `requiredCourses[]`, `allowEveryone.view`, `teams[]`, `certificate.enabled`, `certificate.template` |
| Course | `/v2/course` | `courseName`, `courseCode` (ACC-…), `status` (default Draft), `active`, `modules[]` (filled by the server), `prerequisites[]`, `navigationMode` Free/Sequential, `passingScore` (70), `level`, `estimatedDuration` (minutes), `badgeNomination`, `certificate.{enabled,template}` |
| Module | `/v2/module` | `moduleName`, `order`, `lessons[]` (filled by the server). Created with `origin: {modelName: "Course", docId}` |
| Lesson | `/v2/lesson` | `lessonName`, `type` Article/Video/Quiz/File, `order`, `content` (HTML), `videoSource` Url/File + `videoUrl`/`videoFile`, `assessment`, `resources[]` (files), `required` (default true), `completionRule` View/Interact/Score/Manual (default View), `minScore`, `duration`. Created with `origin: {modelName: "Module", docId}` |
| Assessment | `/v2/assessment` | questions and answers (answers never reach students), `attemptsAllowed` (3), `passingScore` (70), `timeLimit`, `status` |
| Enrollment | `/v2/enrollment` | `assignee`, `course`, `program`, `status` InProgress/Completed/Failed, `progressPercent` and `score` (server-computed), `lastLesson`, `completedAt` |
| LessonProgress | `/v2/lessonprogress` | one per enrollment and lesson: `status` InProgress/Completed, `completedBy` User/Admin, `timeSpent`, `watchTime`, `score` |
| AssessmentAttempt | `/v2/assessmentattempt` | `assessment`, `enrollment`, `attemptNumber`, `status` InProgress/Submitted/Passed/Failed, `answers`, `score` (%) |
| Certificate | `/v2/certificate` | `certificateCode` (ACR-…), `type` Course/Program, `assignee`, `enrollment`, `issuedAt`, `expiresAt`, `status` Active/Expired/Revoked, `pdfFile` |

`origin` on a module or lesson makes the server add its id to the parent's list (at the start
of the list). The lists' order means nothing: the app sorts by `order`. The script appends new
modules and lessons after the existing ones.

`/v2/lessonprogress/trackProgress` (POST `{enrollment, lesson, status, completedBy, …}`) is the
upsert the app uses. Progress there only goes up, and a Completed lesson never goes back.

## Access

A person reaches a course when some program holding it is Published, active, and open to them:
`allowEveryone.view` is true, or they are in one of `teams`. Admins reach every published
program. Courses have no access fields of their own.

- **Home** (`GET /v2/course/home`, any signed-in user): "continue" lists the caller's in-progress
  enrollments in published courses; "recommended" lists reachable courses not taken yet.
- **Enrolling:** for a non-admin creator, the server refuses a course the assignee cannot reach
  ("This course is not available for you.", 403). An admin creator skips that check, so the
  script repeats it in the preview. A second enrollment for the same person and course is
  refused while one is InProgress. After Completed or Failed, a new attempt is allowed.
- **Roles:** Academy objects need their own permissions. A user without them gets 403 on every
  Academy route. The app sends them back to the start page, even when a course of theirs shows
  on their home.

## Progress and completion

When a lesson's progress is saved, the server recomputes the enrollment:
`round(completed required lessons / required lessons × 100)`. At 100 the enrollment becomes
Completed with `completedAt`. A course without modules or without required lessons never moves.

The completion rule is applied by the app's player, not by the server:

- View: done when opened. For a video, the app waits until a share of it is watched.
- Interact: done after the student's action.
- Score: done when a quiz attempt is Passed and reaches `minScore`.
- Manual: only an instructor marks it, with `completedBy: Admin`.

Quiz attempts are graded by the server when set to Submitted. Open answers score 0 until graded
by hand. `attemptsAllowed` limits new attempts. The enrollment `score` is the average of all
graded attempts, failed ones included.

## Certificates

When an enrollment becomes Completed (by progress, by a PATCH `status: Completed`, or created
already Completed), the server:

1. awards the course badge, if the course has one and the person does not have it yet. The
   badge notifies the person in the app and by e-mail (the "badges" notice);
2. stops here if the course certificate is off;
3. creates the course certificate if that enrollment has none, with `expiresAt` from the
   account's certificate-expiration preference (days; 0 = never);
4. renders the design (`certificate.template`) to a PDF and attaches it. On failure it only
   logs; nothing retries;
5. if the enrollment has a `program`, checks the program. When every required course has a
   Completed enrollment linked to that program, and the program certificate is on and not
   issued yet, it issues the program certificate (PDF the same way).

No certificate step sends an e-mail or an in-app notice. The app's player waits up to about a
minute for the PDF, then says it could not prepare it. The certificate page itself is drawn by
the app from the certificate's data.

### Design variables

The design is HTML stored on the course or program (`certificate.template`). These variables
are replaced when the certificate is issued:

`[[userName]]`, `[[firstName]]`, `[[lastName]]`, `[[email]]`, `[[certificateCode]]`,
`[[issuedAt]]` (e.g. "03 Nov 2026"), `[[courseName]]`, `[[programName]]`, `[[type]]`.

It is printed landscape A4 without margins. A text without `<html>` is wrapped in a page. Content
templates of type `certificate` exist, but courses and programs do not reference them: the
design lives on the course or program.

## Things the server accepts that break the flow

| Write | What happens |
| --- | --- |
| Turning certificates on after people finished | They keep no certificate until their enrollment is marked Completed again (`reissue`) |
| A required course in a program whose course certificate is off | The program certificate is never checked when that course is completed |
| An enrollment without `program` | It never counts for any program certificate |
| A program certificate with no required courses | Never issued |
| A Quiz lesson with no assessment | Students see an empty lesson; if required, nobody finishes |
| A required Manual lesson | Students cannot finish until an instructor marks it |
| Adding required lessons to a published course | In-progress percentages drop at the next saved lesson; completed ones stay completed |
