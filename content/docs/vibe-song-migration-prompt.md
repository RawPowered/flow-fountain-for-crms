# VibeAI prompt: migrate the Dialer to SONG

Use this prompt in VibeAI after deploying the matching Workbench API version.

---

You are updating the VibeDialer so the Workbench SONG API becomes the authoritative source for call scripts, branches, prompts, input requirements, appointment actions, and dispositions. Preserve the existing polished Dialer presentation, Dynamic Greeting switch, local-time calculation, weather lookup, calendar widget, CRM note workflow, authentication, and lead controls. Remove the static eight-stage script definitions only after the SONG runtime path works end to end.

## Required API contract

All requests use the existing Workbench API origin. Continue sending:

```http
Authorization: Bearer <WORKBENCH_API_KEY>
X-Operator-Token: <CURRENT_OPERATOR_SESSION_TOKEN>
Content-Type: application/json
```

Do not place either credential in a request body, URL, log, workspace state, or error report.

Load the published script for the current assigned lead with:

```http
POST /api/song/runtime/resolve
```

```json
{
  "locationId": "CURRENT_LOCATION_ID",
  "serviceType": "CURRENT_SERVICE_POOL",
  "leadId": "CURRENT_LEAD_ID",
  "runtimeContext": {
    "greeting": "RESULT_OF_EXISTING_DYNAMIC_GREETING_LOGIC",
    "localTime": "RESULT_OF_EXISTING_LEAD_LOCAL_TIME_LOGIC",
    "weatherSummary": "RESULT_OF_EXISTING_WEATHER_LOGIC",
    "appointmentType": "inspection OR consultation"
  }
}
```

Keep the existing `useDynamicGreeting` state and switch. When it is enabled, pass the current `getGreeting()` result based on lead-local time. When disabled, pass `Hello`. Keep the existing city/state/latitude/longitude weather flow in the Vibe app and pass its concise display result as `weatherSummary`. Use `consultation` for Solar and Remodeling and `inspection` for other services.

The response is:

```ts
type SongRuntime = {
  scriptId: string;
  versionId: string;
  versionNumber: number;
  checksum: string;
  name: string;
  serviceType: string;
  startNodeId: string;
  maxTransitions: number;
  variables: Array<{ key: string; label: string; source: string; defaultValue: unknown }>;
  variableValues: Record<string, unknown>;
  nodes: SongNode[];
};

type SongNode = {
  id: string;
  type: 'prompt' | 'question' | 'qualification' | 'value' | 'objection' |
    'action' | 'appointment' | 'voicemail' | 'disposition' | 'confirmation' | 'end';
  title: string;
  goal: string;
  prompt: string;
  helperText: string;
  required: boolean;
  trackAnalytics: boolean;
  actions: SongAction[];
  branches: SongBranch[];
};

type SongBranch = {
  id: string;
  label: string;
  outcome: string;
  targetNodeId: string;
  agentResponse?: string;
  condition?: unknown;
  actions: SongAction[];
};

type SongAction = {
  type: 'none' | 'authorize_call' | 'capture_input' | 'set_variable' |
    'book_appointment' | 'set_disposition' | 'release_lead' |
    'emit_event' | 'complete_script';
  config: Record<string, unknown>;
};
```

## Runtime controller

Replace `currentStageIndex` as the source of navigation with:

```ts
const [songRuntime, setSongRuntime] = useState<SongRuntime | null>(null);
const [currentNodeId, setCurrentNodeId] = useState<string | null>(null);
const [runtimeValues, setRuntimeValues] = useState<Record<string, unknown>>({});
const [selectedBranch, setSelectedBranch] = useState<SongBranch | null>(null);
const [songLoading, setSongLoading] = useState(false);
const [songError, setSongError] = useState<string | null>(null);
const [transitionCount, setTransitionCount] = useState(0);
```

After a lead is assigned or restored, and whenever its service changes:

1. Resolve the SONG runtime.
2. Set `runtimeValues` from `runtime.variableValues`.
3. Set `currentNodeId` to `runtime.startNodeId`.
4. Reset selected branch and transition count.
5. Emit `script_started` and then `node_viewed`.

Do not cache one lead's `variableValues` for another lead. Do not persist resolved contact values in local storage or workspace state.

Interpolate prompts with SONG syntax:

```ts
function renderSongTemplate(text: string, values: Record<string, unknown>) {
  return String(text || '').replace(
    /{{\s*([a-z][a-zA-Z0-9_.]*)\s*}}/g,
    (_, key) => values[key] == null || values[key] === '' ? `{{${key}}}` : String(values[key])
  );
}
```

Render the current node's `goal` in the Current Objective area, `prompt` in the primary script card, and `helperText` in the supporting instruction area. Use node type to retain the existing visual treatment. Do not hard-code identity, reason, address, diagnosis, trust, appointment, confirmation, or wrap-up text in `index.tsx`.

## Branch behavior

Render `currentNode.branches` as the customer-response buttons. On selection:

1. Save the selected branch.
2. Emit `branch_selected` with node ID, branch ID, and outcome.
3. Show interpolated `branch.agentResponse` when present before advancing. Preserve the current concern-response experience.
4. Execute branch actions in order.
5. Advance to `branch.targetNodeId` only after required actions succeed.
6. Increment transition count and fail closed if it exceeds `runtime.maxTransitions`.
7. Emit `node_viewed` after entering the target node.

Unknown node, action, or missing target values must show a controlled error and must not silently advance.

## Action behavior

- `capture_input`: render the existing address/text input using `config.key`, `config.label`, `config.inputType`, and `config.required`. Store the value only in `runtimeValues`. Block advancement while a required value is empty.
- `set_variable`: set `runtimeValues[config.key] = config.value`.
- `book_appointment`: retain the existing service-calendar widget and calendar endpoint. `config.useServicePoolCalendar` means use the calendar already assigned to the selected service pool. Mark booking state only after the existing booking flow succeeds.
- `set_disposition`: call the existing authenticated disposition/CRM update path using `config.status`. Preserve `config.label` for display. When `config.releaseLead === true`, run the existing release/unassignment behavior only after disposition succeeds.
- `release_lead`: run the existing release/unassignment behavior.
- `authorize_call`: use the existing OWL compliance authorization endpoint before dialing.
- `emit_event`: post the configured event through SONG telemetry.
- `complete_script`: emit `script_completed`, run the existing end-call cleanup, clear lead-scoped SONG state, and load the next eligible lead.

Keep CRM notes and additional notes behavior. For imported wrap-up nodes, `capture_input` with key `additionalNotes` replaces the static notes input binding.

## SONG telemetry

Post runtime events to:

```http
POST /api/song/events
```

```json
{
  "locationId": "CURRENT_LOCATION_ID",
  "userId": "CURRENT_OPERATOR_USER_ID",
  "leadId": "CURRENT_LEAD_ID",
  "scriptId": "RUNTIME_SCRIPT_ID",
  "versionId": "RUNTIME_VERSION_ID",
  "nodeId": "CURRENT_NODE_ID",
  "branchId": "OPTIONAL_BRANCH_ID",
  "eventType": "node_viewed",
  "outcome": "OPTIONAL_OUTCOME",
  "metadata": {}
}
```

Use only supported events: `script_started`, `node_viewed`, `branch_selected`, `action_started`, `action_completed`, `action_failed`, `script_completed`, and `script_abandoned`. Never put tokens, authorization headers, passwords, complete lead objects, phone numbers, email addresses, or CRM payloads in metadata.

## Preserve and export the current scripts

Before deleting static service script data, add a temporary developer-only function that serializes the existing service configuration into this exact shape:

```ts
const vibeSongExport = {
  services: Object.entries(existingServiceConfiguration).map(([serviceType, service]) => ({
    serviceType,
    scriptName: `${serviceType} - Vibe Legacy Flow`,
    description: `Imported from VibeDialer static flow for ${serviceType}.`,
    reason: service.reason,
    mainScript: service.mainScript,
    concerns: service.concerns,
    outcomes: OUTCOMES,
    dynamicAnswers: service.dynamicAnswers ?? undefined,
  })),
};
```

Expose this JSON through a temporary developer console command or download button, not through a public production API. The administrator will paste it into **SONG > Actions > Import Vibe scripts**, run Preview, then Apply. Remove the temporary export control after migration is confirmed.

The importer translates the current eight stages, concern responses, jump targets, wrong-person and not-interested exits, appointment behavior, confirmation, outcomes, and legacy placeholders. Do not publish imported drafts automatically. The administrator will inspect and publish each service in SONG.

## Failure and loading states

- While resolving, show a quiet loading state in the script panel and disable response controls.
- For `401`, refresh/re-establish the operator session through the existing login flow; do not retry indefinitely.
- For `403`, show that the lead or location is not authorized and disable dialing.
- For `404 SONG_RUNTIME_NOT_FOUND`, show `No published SONG script is assigned to this service pool` with a retry control. Do not fall back to static scripts after migration.
- For network/5xx failures, preserve the assigned lead, show Retry, and do not advance or disposition it.

## Acceptance criteria

1. Dynamic Greeting still changes with the existing switch and lead-local time.
2. Existing weather and location display remains operational.
3. A published SONG edit changes the Dialer without a Vibe redeploy.
4. Restoring an assigned lead loads its service's published SONG version.
5. Only declared variable values are received; the complete CRM record is not exposed.
6. Address capture, concerns, branch responses, appointment booking, confirmation, wrap-up, CRM notes, and dispositions work.
7. Wrong Person and Not Interested follow their imported terminal paths.
8. Every node and branch emits SONG telemetry once, without duplicate events from React rerenders.
9. Unknown actions and failed required actions fail closed.
10. Remove the old static stage rendering and data only after these checks pass.

Implement this end to end, run the existing build/tests, and inspect browser network traffic to verify both authentication headers are present and no sensitive payload is logged.
