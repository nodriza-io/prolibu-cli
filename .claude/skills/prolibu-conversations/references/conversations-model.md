# Conversations: how the platform behaves

Verified against the platform's code and a non-production account. Read it when a case falls
outside the steps in `SKILL.md`.

## Objects

| Object | Path | What matters |
| --- | --- | --- |
| Conversation | `/v2/conversation` | `channelType` (`whatsapp`, `sms`, `voice`, `aiChat`), `phoneNumber` (E.164), `channel`, `contact`, `status` (`active`, `closed`, `pending`, `archived`), `assignee`, `aiAgentProfile`, `aiContext`, `lastInboundAt`, `unreadCount`, `flowSession` |
| Message | `/v2/message` | `conversation`, `direction` (`inbound`, `outbound`, `internal`, `system`), `eventType`, `body`, `status` (`queued`… `sent`, `delivered`, `read`, `failed`, `undelivered`), `errorMessage`, template fields |
| ConversationFlow | `/v2/conversationflow` | `conversationFlowName`, `channels`, `triggerType` (array), `startNodeId`, `nodes`, `nodePositions`, `active` |
| Channel | `/v2/channel` | `channelName`, `active`, `channelProvider`, `aiAgentProfile` (one agent per channel) |

- A conversation has no deal field. Its contact is set when it is created (the number matches
  a contact's `mobile`, `whatsapp` or `phones.number`) or later, when a contact with that
  number is created or its phones change. Numbers are compared by digits.
- `aiContext` holds the AI state: `escalatedAt`, `escalationReason`, `takenOverBy`,
  `pendingConfirmation`. These keys are stripped from REST writes: the API cannot set or clear
  an escalation.
- Older messages may have no `eventType`; they count as messages.

## Who answers

The AI agent answers a new customer message when the channel is active, has an agent, the
agent is active, and the conversation is not escalated. Conversation `status` is not checked:
the agent also answers closed conversations.

- **Escalated:** the agent called a person (`escalate_to_human`); a task is created for them.
- **Taken over:** a person sent a message through `/v2/message/send`; the agent steps back.
  Not when the sender is the agent's own user, and not when a script sends.
- **Handback:** `POST /v2/aichat/resume {"conversationId"}`. Allowed to admins, the creator,
  the assignee, collaborators, whoever took it over, and the agent's user (others get 403).
  It answers `{"resumed": false}` when the conversation was not escalated. It writes a
  system message "… handed the conversation back to the agent." and the agent ignores
  messages that arrived before.
- Closing or archiving an escalated conversation also hands it back, silently.

## Sending

`POST /v2/message/send` (route permission only):

1. `conversation` or `to` is required. **`to` wins over the conversation's number**: the
   message goes to `to` and is logged in this thread. A `channelType` different from the
   conversation's makes the server find or create another conversation.
2. A template is `contentType: "template"` or `templateSid`; `templateSid` is required for
   every provider. Only numeric `templateVariables` keys are sent, in order; others are
   dropped silently.
3. The channel must exist and be active; a Meta connection must be `active` or
   `pendingPayment`.
4. The message is created (`queued`) **before** the provider is called; on any provider error
   it is marked `failed` with the reason and the call answers with that error.
5. There is no window check on the server. Meta answers "The 24-hour window to reply has
   closed. Send an approved template."; Twilio answers with its own message.
6. Status is ignored: sending into a closed conversation works, but the app's composer is
   locked for closed conversations, so the script blocks it too.
7. `POST /v2/message/{id}/retry` resends only `body`, without `contentType`, `templateSid` or
   `conversation`: a failed template goes out as free text.

## Templates

`GET /v2/channel/{channelId}/whatsappTemplates` lists the channel's templates. Meta channels
list local templates that are approved and fully mapped; Twilio channels list the Content API
templates with `whatsappStatus`. The app keeps only `approved`. Each item has `sid`, `name`
(sent as `templateName`), `language`, `body` with `{{1}}`… slots, and `variableMappings`
(`{"1": {"type": "field", "path": "contact.firstName"}, "2": {"type": "text", "value": "…"}}`).
A channel without provider credentials answers 400.

## Conversation flows

- Nothing on the server runs a flow. The app offers active flows of the conversation's channel
  (`triggerType` `manual` or `inbound`, both the same) to the human agent as a guide and saves
  the answers in `flowSession`. `keyword` is never offered.
- `active` defaults to `true` on create; the app creates flows with `active: false` and
  `triggerType: ["manual"]`.
- The server accepts any graph. The app's editor rules: errors `noStart`, `startMissing`,
  `branchWithoutTarget`, `danglingTarget`, `missingVarName`, `selectWithoutOptions`,
  `blankOption`; warnings `unknownType`, `emptyContent`, `duplicateVarName`, `noDefault`,
  `unreachable`. A flow with errors, or without steps, cannot be published.
- Conditions by answer type: text `equals`, `not_equals`, `contains`; number `equals`,
  `not_equals`, `gt`, `gte`, `lt`, `lte`; boolean `equals`; select `equals`, `not_equals`;
  every type also `default`.
- Missing `nodePositions` are laid out by the editor.

## Lists

- Filters on `aiContext.*` at the root of `xquery` are ignored (every record comes back); put
  them inside `$or`.
- Reading conversations or messages through the API does not mark them as read.
