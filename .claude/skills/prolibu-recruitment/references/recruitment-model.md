# Recruitment and assets model

How the HR objects (without the academy) relate and behave, as the server and the app do it
today. The app's screens for all of them are the generic list, board and record drawer.

## Objects

| Object | Route | Key fields |
| --- | --- | --- |
| Vacancy | `/v2/vacancy` | `title` (required), `vacancyCode` (VAC-…, random), `description`, `responsibilities`, `requirements` (plain text on the public page), `department`, `location`, `employmentType` Full-time/Part-time/Contract/Internship/Temporary, `workMode` On-site/Remote/Hybrid, `seniority`, `salaryRange.{min,max,currency,visible}` (visible false by default), `openings` (1), `hiredCount` (server), `stage`, `publishedAt`/`filledAt`/`closedAt` (server), `closeDate` (informative), `applicationForm`, `assignee` (owner recruiter), `assignmentGroup` (round-robin recruiters), `collaborators` |
| Candidate | `/v2/candidate` | `candidateCode` (CAN-…), `email` (key, lower case, one per workspace), names, `mobile`, `socialNetworks`, `jobTitle`, `seniority`, `skills[]`, `yearsOfExperience`, `salaryExpectation`, `resume` (private file), `source`, `stage`, `sourceContact` |
| JobApplication | `/v2/jobapplication` | `jobApplicationCode` (APP-…), `vacancy` (empty = spontaneous), `candidate` (set by the server from the e-mail), `email`, `coverLetter`, `resume` (private file), `expectedSalary`, `rating` 0–5, `stage`, `appliedAt`/`hiredAt`/`rejectedAt` (server), `rejection.{reason,kind,details}` (cleared unless Rejected), `interviews[]` (server) |
| Interview | `/v2/interview` | `interviewCode` (INT-…), `jobApplication` (required), `vacancy`, `round`, `kind` phone/video/technical/panel/culture/final/other, `interviewers[]`, `organizer`, `startDate`, `endDate`, `location`, `meetingUrl`, `status` scheduled/awaiting_feedback/complete/cancelled/no_show/declined |
| Employee | `/v2/employee` | `employeeCode` (EMP-…), `user` (required, an existing user), `workspace` (the employing company), `employeeNumber`, `hireDate`, `exitDate`, `status` Active/OnLeave/Terminated, `employmentType`, `workMode`, `reportsTo` (another Employee), `emergencyContact`, `documents[]` |
| Asset | `/v2/asset` | `assetCode` (AST-…), `assetName`, `serialNumber` (unique, case-insensitive), `brand`, `model`, `condition`, `stage`, `assignedTo`/`currentAssignment` (server, from assignments), `purchase`, `warranty`, `depreciation`, `specs` |
| AssetAssignment | `/v2/assetassignment` | `assignmentCode` (ASG-…), `asset`, `assignedTo` (a user), `assignedAt`, `dueDate`, `returnedAt` (server), `status` Assigned/Returned/Overdue/Lost, `conditionOut`, `conditionIn`, `handoverContract`/`returnContract` (server) |

## Factory stages

Seeded in every account with the same `_id`; the server's hooks compare against those ids, so
the script uses them (codes differ between accounts). Names follow the account language.

| Pipeline | Stages (in order; * ends the flow) |
| --- | --- |
| Vacancy | Draft, Open, On Hold, Filled*, Closed* |
| JobApplication | Applied, Screening, Interview, Offer, Hired*, Rejected* |
| Candidate | Prospect, Active, Talent Pool, Hired*, Archived* |
| Asset | In Stock, Reserved, Assigned, In Maintenance, Retired*, Lost*, Disposed* |

An account may add required fields to a stage (for example `rejection.reason` on Rejected);
the preview blocks a move that lacks them.

## Publishing and closing

- `POST /v2/vacancy/publish/<id>` sets Open and, unless the account turned it off, creates the
  application form once: public, captcha on, CV required, notifications to the owner (else the
  recruiter group's members, else the publisher). Its mappings create the Candidate and the
  JobApplication with the vacancy fixed on the server. It does not turn an existing form back
  on. The script first edits the stage through `PATCH /v2/vacancy/<id>`, which checks the
  user's edit right on the record; then calls publish only to create the form.
- `/v2/vacancy/view/<code or _id>` answers only while the vacancy is Open; otherwise "not
  found". `/v2/vacancy/careers` lists every Open vacancy of the account (all workspaces), with
  filters, no `noindex`: job ads are meant to be found.
- The form is a separate public record (`/v2/form/view/<formId>`, submissions to
  `/v2/form/register`). It accepts applications while the form is active, whatever the
  vacancy's stage. That is why `close` turns it off; turning a form on or off needs Forms
  rights (the Recruiter role can only read forms).
- `closeDate` is only stored: nothing closes the vacancy or the form on that date.

## E-mails and notifications

| Event | Who | Condition |
| --- | --- | --- |
| New application | Owner / recruiter group (app notification) | always |
| New application | Applicant (acknowledgement e-mail) | account setting, on by default |
| Stage → Rejected | Candidate (rejection e-mail) | always, no setting |
| Any other stage change | Candidate (stage e-mail) | account setting, off by default |
| Stage change, new assignee, new collaborator | Recruiters (app notifications) | always |
| Interview created | nobody | — |
| Interview ended N hours ago (24 by default), application without rating | Each interviewer (reminder e-mail), then status awaiting_feedback | hourly job |
| Asset assigned or returned | nobody | — |

The account settings are readable by every user at `GET /v2/user/preferences` →
`modules.hr`; the script reads them for the preview.

## Hiring

Moving an application to Hired sets `hiredAt` and recounts the vacancy: hired applications ≥
`openings` moves it to Filled (off the public page); fewer moves a Filled vacancy back to
Open. Other applications are not touched. The Candidate's own stage is separate; the script
moves it to Hired too. An Employee needs an existing user: user accounts are created by an
admin in the app, never by this skill. Salary and payroll data are not part of Employee.

## Assets

Creating an AssetAssignment refuses an asset already held (Assigned or Overdue) or at an end
stage. It moves the asset to Assigned with its holder. Setting the assignment to Returned
moves the asset back to In Stock and clears the holder; Lost moves it to Lost. Only the
asset's current assignment changes the asset. The return date is the save time (the field is
not writable). Moving an asset to Assigned on the board is refused; moving an assigned asset
is refused until it is returned. If the account asks for signed acts, a Draft contract with the
holder as signer is created (and a contact for that user's e-mail if none exists). No job
marks assignments Overdue or sends overdue notices, although an account setting names one.

## Permissions

| Role | Can |
| --- | --- |
| Recruiter | CRUD on vacancies, candidates, applications, interviews (own records unless the account's access rules say more); read contacts and forms |
| Recruiting Manager | The above on every record, plus reports, dashboards and stage editing |
| People Manager | CRUD on employees; read users and workspaces |
| Asset Assistant | CRUD on own assets and assignments, tasks and notes on them, read users |
| Asset Manager | Every asset and assignment, retire / lost / dispose, signing acts |

The script edits through each object's record routes (`PATCH /v2/<object>/<id>`, `POST
/v2/<object>`), so the user's own role and record permissions decide what goes through. It
uses the publish route only after the record edit, to create the form.
