# Prolibu objects by module

Every standard object in the public API, grouped by the platform module it belongs to. The
**API path** column is the collection path: `GET /v2/<path>` lists, `POST /v2/<path>` creates.
A few objects are read-only logs (ContactSubmission, LoginActivity, ProposalVersion,
StageHistory): they have no create.

Modules are switched on per account. An object listed here but missing from the account's
`GET /v2/openapi/specification/<path>` is not enabled there; say so and stop. An account can
also add its own Custom Objects; they appear in the account's OpenAPI document but not here
(see `prolibu-custom-fields`). The rules every call follows are in `api-conventions.md`.

## Sales

| Object | API path | What it is for |
| --- | --- | --- |
| Deal | `deal` | A sales opportunity with a customer: contact, company, stage, owner, and the proposal with its quote. |
| Lead | `lead` | A prospect not yet qualified; converting it creates a Contact. |
| Presentation | `presentation` | A presentation sent to a contact, built from a layout template, with view tracking and expiration. |
| ProposalVersion | `proposalversion` | A saved version (snapshot) of a deal's proposal. |
| Goal | `goal` | A sales target for one seller over a period, with a target value and currency. |
| ContactProtocol | `contactprotocol` | A follow-up sequence of steps applied to contacts, deals or calls when they reach given stages. |
| AdCampaign | `adcampaign` | An advertising campaign that contacts are attributed to, with the user group that receives them. |
| AdHub | `adhub` | A connected ad-platform account (for example Meta) that brings in leads and reports conversions. |
| AdHubForm | `adhubform` | A lead form discovered on a connected ad-platform account, linked to the Prolibu form that receives its leads. |
| Campaign | `campaign` | An older, minimal campaign record (code and name) that nothing else points to. For ad campaigns use AdCampaign. |
| BusinessEvent | `businessevent` | An event the company runs or attends (conference, trade show): venue, dates, budget, attendees and results. |
| EventProspect | `eventprospect` | A candidate event being evaluated; promoting it creates a BusinessEvent. |
| EventExpense | `eventexpense` | An expense recorded against a business event, converted to the workspace currency. |

## Contacts and companies

| Object | API path | What it is for |
| --- | --- | --- |
| Contact | `contact` | A person the business deals with: contact details, company, owner, source and activity. |
| Company | `company` | An organization: identification, domains, contact details, industry and owner. |
| ContactSubmission | `contactsubmission` | One submission by a contact (form or lead ad), numbered so re-contacts are kept apart, with the campaign that brought it. |

## Pricing and quotes

| Object | API path | What it is for |
| --- | --- | --- |
| Product | `product` | A catalog item that can be quoted: name, group, family, categories, units and payment settings. |
| Pricebook | `pricebook` | A price list, with validity dates and an optional discount schedule. |
| PricebookEntry | `pricebookentry` | The price, cost, taxes and rules of one product inside one price list. |
| Quote | `quote` | The priced offer: currency, dates, line items, discounts, taxes and totals. |
| LineItem | `lineitem` | One priced line of a quote, taken from a pricebook entry. |
| ProductGroup | `productgroup` | A group of products shown together in a proposal, with its header, footer and display options. |
| ProductFamily | `productfamily` | A family of products with its own proposal snippets and automatic percent-of-total settings. |
| ProductCategory | `productcategory` | A category used to classify products. |
| ProductRule | `productrule` | Limits applied when a product is quoted: quantity, price, discount, payments, markup, and products that must be included or excluded. |
| Feature | `feature` | A choice offered on a product, with the product options to pick from and how many must be selected. |
| DiscountSchedule | `discountschedule` | Rules that set a product's discount inside a price list (for example by quantity), with a floor price. |
| Coupon | `coupon` | A discount code (percentage or fixed amount) with validity dates and redemption limits. |
| Tax | `tax` | A tax with its rate. |
| CommercialException | `commercialexception` | A request or approval to lift product rules on a deal (for example a discount above the limit), with the approver and decision. |
| ItemStock | `itemstock` | A bookable physical unit (a vehicle, a room) with capacity, home branch and current branch. |

## Billing

| Object | API path | What it is for |
| --- | --- | --- |
| Invoice | `invoice` | A bill to a contact or company, with due date, payments and balance. |
| Payment | `payment` | A payment received and the invoices it pays. |
| Subscription | `subscription` | A recurring contract with a start and end date and a billing cadence, which generates instalment invoices. |

## Support

| Object | API path | What it is for |
| --- | --- | --- |
| Ticket | `ticket` | A support case from a contact or user, with its case type, stage, assignee and comments. |
| CaseType | `casetype` | A kind of support case, with the area and user group that resolve it. |
| EmailHub | `emailhub` | A connected inbox that turns incoming email into tickets. |
| RoutingRule | `routingrule` | A rule that sends incoming tickets to a case type and group by subject keywords or sender domain. |

## Operations

| Object | API path | What it is for |
| --- | --- | --- |
| Task | `task` | A to-do with dates, assignee, stage, checklist and dependencies on other tasks. |
| WorkOrder | `workorder` | A piece of work for a customer, made of tasks, with stage, progress and execution time. |

## Productivity tools

| Object | API path | What it is for |
| --- | --- | --- |
| Call | `call` | A phone or WhatsApp call with a prospect or contact: summary, recording, transcription and duration. |
| Meeting | `meeting` | A meeting with dates, attendees, attendance and status. |
| Note | `note` | A note, optionally with a checklist and attachments. |
| ContactList | `contactlist` | A named list of contacts. |
| EmailCampaign | `emailcampaign` | A bulk email to a list of contacts, sent once or as a sequence, with stats. |
| Contract | `contract` | A document to be signed by signers and reviewers, with its audit trail and signed files. |
| File | `file` | A file or folder in the account's cloud drive. |

## Calendars and scheduling

| Object | API path | What it is for |
| --- | --- | --- |
| Calendar | `calendar` | A bookable calendar (appointments, test drives or rooms) with durations, limits and availability rules. |
| CalendarEvent | `calendarevent` | A booking or event on a calendar, with its attendees, status and reminders. |
| CalendarPolicy | `calendarpolicy` | Working-hour rules for a calendar, optionally for one user. |
| CalendarException | `calendarexception` | Dates that are exceptions to a calendar's normal availability. |
| CalendarGroup | `calendargroup` | A named group of calendars (name and description); nothing else points to it. |
| Attendee | `attendee` | A person attending a calendar event (contact or user). |

## Messaging and calls

| Object | API path | What it is for |
| --- | --- | --- |
| Channel | `channel` | A communication channel (phone, WhatsApp and similar) with its provider and numbers. |
| ChannelProvider | `channelprovider` | The provider account and credentials behind a channel (for example Twilio). |
| PhoneNumber | `phonenumber` | A phone number and what it can do: SMS, WhatsApp, voice. |
| Conversation | `conversation` | A conversation thread with a contact on a channel, including AI-run conversations. |
| Message | `message` | One event in a conversation: a text, media, voice note, call and so on. |
| ConversationFlow | `conversationflow` | An automated conversation flow started on inbound conversations or by an agent. |

## Content

| Object | API path | What it is for |
| --- | --- | --- |
| Article | `article` | An article with body, cover, status (draft, scheduled, published, archived) and publish date. |
| Portal | `portal` | A portal with menu, slides and articles, shown to everyone or to selected workspaces. |

## People (HR and learning)

| Object | API path | What it is for |
| --- | --- | --- |
| Employee | `employee` | An employment record for a platform user: company, hire date, status and manager. |
| Vacancy | `vacancy` | An open position, published with an application form. |
| Candidate | `candidate` | A person in recruiting, with CV, skills and stage. |
| JobApplication | `jobapplication` | One candidate's application to a vacancy, with stage, interviews and outcome. |
| Interview | `interview` | An interview for a job application. |
| Asset | `asset` | Company equipment with its holder, condition and history. |
| AssetAssignment | `assetassignment` | The hand-over of an asset to an employee and its return. |
| Program | `program` | A learning program made of courses, with certification. |
| Course | `course` | A course made of modules and lessons. |
| Module | `module` | A section of a course that holds lessons. |
| Lesson | `lesson` | One lesson: article, video, quiz or file. |
| Assessment | `assessment` | A quiz with questions, passing score and time limit. |
| AssessmentAttempt | `assessmentattempt` | One learner's attempt at an assessment and its score. |
| Enrollment | `enrollment` | A learner's enrollment in a course or program and their progress. |
| LessonProgress | `lessonprogress` | A learner's progress on one lesson. |
| Certificate | `certificate` | A certificate issued for completing a course or program. |

## Recognition and rewards

| Object | API path | What it is for |
| --- | --- | --- |
| BadgeNomination | `badgenomination` | A kind of badge that can be awarded, with its icon and coin reward. |
| Badge | `badge` | A badge awarded to a user. |
| Challenge | `challenge` | A challenge with a coin pot shared among its winners. |
| ChallengeApplication | `challengeapplication` | A user's entry to a challenge, approved or rejected by a manager. |
| Reward | `reward` | Coins given to a user, with the reason. |
| RewardsBudget | `rewardsbudget` | Coins allocated to managers for a spending period. |
| Prize | `prize` | A prize that can be redeemed for coins. |
| RedeemedPrize | `redeemedprize` | A prize redeemed and the coins spent. |

## AI

| Object | API path | What it is for |
| --- | --- | --- |
| AiAgentProfile | `aiagentprofile` | An AI agent: the user it runs as, model, persona, instructions, skills and actions. |
| Skill | `skill` | An AI skill: a prompt template, or instructions plus actions for an agent. |
| AiAction | `aiaction` | A tool an AI agent can call: a platform tool, a script, a browser action, a prompt or an HTTPS call. |
| EventTrigger | `eventtrigger` | Runs an AI skill or agent on a schedule or when a record changes. |
| McpSession | `mcpsession` | A session of an external AI client connected through MCP. |

## Devices (IoT)

| Object | API path | What it is for |
| --- | --- | --- |
| Device | `device` | A connected hardware device and its status. |
| DeviceTrigger | `devicetrigger` | An action a device performs on an event or schedule. |

## Virtual tours

| Object | API path | What it is for |
| --- | --- | --- |
| VirtualTour | `virtualtour` | A virtual tour (automotive or spaces) made of scenes and floor plans. |
| Scene | `scene` | One view of a tour: a 2D image, a 360° panorama or an image sequence. |
| Spot | `spot` | A hotspot placed in a scene or floor plan (information, media or link to another scene). |
| FloorPlan | `floorplan` | A floor-plan image with navigation hotspots. |
| Tour | `tour` | A tour with exterior hotspots, engine view, interior 360° photos and a photo and video gallery. |

## Platform and configuration

| Object | API path | What it is for |
| --- | --- | --- |
| User | `user` | A person who signs in to the account, with roles and workspaces. |
| Role | `role` | A named set of permissions given to users. |
| Team | `team` | A team of users. |
| UserGroup | `usergroup` | A group of users for a purpose (contact assignment, ticket resolution, proposal wizard, record sharing, calendar load balancing), optionally with load balancing. |
| UsersGroup | `usersgroup` | An older list of users (code, name, members) that nothing else points to. Use UserGroup. |
| Workspace | `workspace` | A business unit inside the account; records belong to one. |
| AuthenticationRule | `authenticationrule` | Sign-in rule that gives matching email domains or addresses their roles and workspaces. |
| Token | `token` | An API key or session token, with its roles, scopes and expiry. |
| OauthApp | `oauthapp` | An external application allowed to connect by OAuth. |
| OauthGrant | `oauthgrant` | An authorization given to an OAuth application. |
| ServiceCredential | `servicecredential` | Stored credentials for an external service (AI providers, Twilio, SendGrid, Google, Meta and others). |
| SyncConnection | `syncconnection` | A sync with an external CRM (for example HubSpot) for contacts, companies, deals, products and users, with a direction per object and field and stage mappings. |
| ConfirmationCode | `confirmationcode` | A one-time verification code sent by email or WhatsApp. |
| LoginActivity | `loginactivity` | A record of a sign-in attempt and its result. |
| Log | `log` | A system log entry (submissions, script runs and others). |
| Stage | `stage` | A pipeline stage, with color, order and the fields required to move into it. |
| StageHistory | `stagehistory` | A record of a record moving from one stage to another. |
| Group | `group` | Groups records of one object (for example a project of tasks), with optional stages of its own, working days and a shared timeline. |
| Tag | `tag` | A label for records. |
| Category | `category` | A category, optionally nested, used to classify records. |
| Comment | `comment` | A comment on a record, with attachments. |
| Notification | `notification` | An in-app notification for a user. |
| EventSubscription | `eventsubscription` | Which events notify a user. |
| Email | `email` | One email sent from the platform, with delivery and view tracking. |
| MessageTemplate | `messagetemplate` | A reusable email or WhatsApp message with variables. |
| ContentTemplate | `contenttemplate` | A design used in proposals and documents: layout, content, snippet, certificate or custom view. |
| Template | `template` | A template the platform renders by name: system pages, notification emails, vCards. Proposal designs are ContentTemplate. |
| Font | `font` | A font file available in the editors. |
| Form | `form` | A web form or a mirrored ad lead form, and where its submissions go. See `prolibu-forms`. |
| FormSubmission | `formsubmission` | One submission of a form and what it created. See `prolibu-forms`. |
| Webhook | `webhook` | Sends an HTTP POST to an external URL when chosen events happen. See `prolibu-webhooks`. |
| Script | `script` | Server-side code run on demand, on record events or on a schedule. See `prolibu-scripts`. |
| Endpoint | `endpoint` | A custom URL that runs a script. See `prolibu-endpoints`. |
| Site | `site` | A hosted website or single-page app. See `prolibu-sites`. |
| CustomField | `customfield` | Extra fields added to an object. See `prolibu-custom-fields`. |
| Cob | `cob` | A Custom Object defined by the account. See `prolibu-custom-fields`. |
| CustomFilter | `customfilter` | A saved filter on an object's list. |
| CustomView | `customview` | Which parts of a proposal are shown (agent card, quote, notes, snippets, product groups). |
| CustomUi | `customui` | A custom interface piece: sidebar, default columns, field widget, row action or cell widget. |
| ProposalWizard | `proposalwizard` | A self-service quoting page where a visitor builds a proposal from a catalog. |
| ProposalWizardGroup | `proposalwizardgroup` | A page that lets the visitor choose between several proposal wizards. |
| Report | `report` | A report over an object's records or external data: columns, filters and measures. |
| Dashboard | `dashboard` | A dashboard of widgets. |
| Page | `page` | A page of widgets inside a report. |
| Widget | `widget` | A chart or figure built from a report. |
| Scoring | `scoring` | A scoring profile that rates records by rules, AI, or both. |
| Plugin | `plugin` | An add-on package (bundle and assets) with its options. |
| Poll | `poll` | A poll made of questions, with a closing date. |
| Question | `question` | A poll question and its options. |
| Vote | `vote` | A rating of a user or contact, given by a user or contact, about a deal or a ticket. |
| PaymentMethod | `paymentmethod` | A stored payment method (card or bank account) of a contact or company. |
| ShortUrl | `shorturl` | A short link that redirects to a URL. |
| HealthCheck | `healthcheck` | A monitor that checks a URL on an interval and alerts on failure. |
| LiveStream | `livestream` | Forwards the activity notifications of chosen users (publishers) to a list of subscriber users, for the events in its event subscription. |

## Service routes (no object behind them)

These paths answer under `/v2/<path>/<action>` but have no collection: `GET /v2/<path>` does
not list anything. Most are admin-only; the ones marked *never* are for the app, not for skills.

| Path | What it does |
| --- | --- |
| `aichat` | The in-app AI chat: send a message, conversations, providers, agents, resume. `resume` reaches people. See `prolibu-ai-agents`. |
| `auditlog` | `getlogs` only: who signed in or changed users, roles, tokens or (when switched on) records. Admin. See `prolibu-diagnostics`. |
| `auth` | Sign-in, session, sign-out, MFA and password reset. *Never* from a skill: skills use the API key. |
| `integration` | Third-party lookups (Kaspr limits, credits and profiles). |
| `oauth` | Lists OAuth providers and connects or disconnects an app. Changing a connection is done in the app. |
| `permission` | `library`: every permission that can be given to a role. Read only. |
| `preference` | The account's settings: `read` and `write`, admin only. Writes change the whole account; the public subset is `GET /v2/user/preferences`. |
| `service` | Utilities: exchange rate, DNS check, object schema, captcha, QR code, vCard, import template, data import and import jobs. Imports: see `prolibu-imports`. |
| `templates` | `gallery`: the template gallery shown when creating proposals and documents. |

A path that is in neither this list nor the tables above may be a Custom Object of the account:
check `GET /v2/cob` before saying it does not exist.

## Optional modules

Few accounts load these modules.

| Object | API path | What it is for |
| --- | --- | --- |
| Branch | `branch` | Inventory: a location of the business (showroom, warehouse, or a channel without an address such as digital or fleet). Item stock points to its home and current branch. |

The Subscriptions module (Account, Deployment, Pool, SubscriptionPlan) is Prolibu's own
administration of customer accounts. Never use it through a skill.

Signatures and signing certificates have no objects of their own: document signing goes
through Contract.
