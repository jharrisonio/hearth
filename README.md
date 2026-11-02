# Hearth

A household todo list for people and the bots that help them. It replaces a shared Google Doc: personal lists stay private, the household list is shared, and a bot can only see the team its token was minted for.

James and Naomi are seeded when `SEED=1`. Dev sign-in works without Google. Bot calls use a Bearer token.

## Run it

Docker Compose brings up Postgres, the API, and the React PWA.

```bash
docker compose up --build
```

- Web: http://127.0.0.1:43123
- API: http://127.0.0.1:43124
- Postgres: `postgres://hearth:hearth@127.0.0.1:54329/hearth`

Open the web app and choose **Sign in as James** or **Sign in as Naomi**. `DEV_AUTH` defaults to on in Compose. Turn it off anywhere that is not your own machine.

Google sign-in uses the same web origin. In the Google client, set the redirect URI to:

`http://127.0.0.1:43123/api/auth/google/callback`

### Without rebuilding the app image

Start only Postgres, then run the API and Vite dev server on the host:

```bash
cp .env.example .env
docker compose up postgres -d
pnpm install
pnpm icons   # only needed once, PNGs are already in the repo after the first run
pnpm dev
```

The Vite server on port 43123 proxies `/api` to the API on port 43124.

### Check that personal lists stay personal

With the API up:

```bash
pnpm isolation-check
```

That script signs in as both seeded people, checks Naomi cannot read James's personal tasks, checks a household task is visible to both, exercises create / update / complete / do-immediately, and checks a bot token cannot cross teams.

## Environment

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string |
| `SESSION_SECRET` | Signs the session cookie. At least 16 characters |
| `DEV_AUTH` | `1` enables `POST /auth/dev` for seeded users |
| `SEED` | `1` creates James, Naomi, the Harrison household, and a few starter tasks if those lists are empty |
| `GOOGLE_CLIENT_ID` | Google OAuth client id. Optional |
| `GOOGLE_CLIENT_SECRET` | Google OAuth secret. Optional |
| `PUBLIC_URL` | Browser origin of the web app, used for the OAuth redirect. Default `http://127.0.0.1:43123`. On Railway this can be omitted when `WEB_PUBLIC_DOMAIN` is set |
| `WEB_PUBLIC_DOMAIN` | Public host of the web service, without a scheme. The API turns it into `https://…` when `PUBLIC_URL` is unset |
| `PORT` | Port the process listens on. The API defaults to `43124` locally and `3001` inside Compose. Railway sets this |
| `CORS_ORIGINS` | Optional comma-separated browser origins allowed to call the API directly. Leave empty when the web app proxies `/api` (Compose and the Railway web service). No wildcard |
| `DATABASE_SSL` | Set to `1` to force TLS to Postgres. Also enabled when `DATABASE_URL` contains `sslmode=require` |
| `API_UPSTREAM` | Web only. API origin, `http://host:port`. Compose sets `http://api:3001`. Leave empty on Railway. The hostname is resolved per request, not at nginx start |
| `API_HOST` / `API_PORT` | Web only. Used when `API_UPSTREAM` is empty. Railway wires these to the API private network |
| `NGINX_RESOLVER` | Web only. DNS server nginx uses to re-resolve the API host. Defaults to the nameserver in the container's `/etc/resolv.conf` |

Copy `.env.example` for host-side `pnpm dev`. Compose sets the variables itself. Production values stay in the host, not in git.

## Railway

`.railway/railway.ts` describes three resources that share one Railway project. Nothing in that file is a production secret, and applying it is a manual step after you link a project you already created.

- `postgres` — Railway Postgres. The API takes `DATABASE_URL` from it.
- `api` — image from `/apps/api/Dockerfile`.
- `web` — image from `/apps/web/Dockerfile`. Nginx listens on `PORT` and proxies `/api` to the API over the private network, so the session cookie stays on the web origin. The API hostname is resolved on each request (`resolver` and a variable `proxy_pass`). A Railway redeploy can change the API’s private IP; web keeps working without a restart.

Both services use the repository root as their root directory. Do not set the root to `apps/api` or `apps/web`: the Dockerfiles copy the pnpm workspace from the root. `RAILWAY_DOCKERFILE_PATH` selects the Dockerfile.

```bash
railway login
railway link
railway config plan
railway config apply
```

Then connect `github.com/jharrisonio/hearth` to the `api` and `web` services and deploy `main`. Set these on the API in the Railway dashboard before that first deploy:

| Variable | Value |
| --- | --- |
| `SESSION_SECRET` | Random string, at least 16 characters |
| `GOOGLE_CLIENT_ID` | Google OAuth client, or leave empty |
| `GOOGLE_CLIENT_SECRET` | Matching secret, or leave empty |
| `DEV_AUTH` | `0`. The API refuses to start on Railway when this is `1` |
| `SEED` | `0` |
| `PUBLIC_URL` | Only if you use a custom domain. Otherwise the API uses `https://` plus the web service’s public domain |

Google’s redirect URI is `https://<web-domain>/api/auth/google/callback`.

`SESSION_SECRET` and the Google credentials are `preserve()` in the Railway file, so a later `railway config apply` does not overwrite the dashboard. `CORS_ORIGINS` stays empty unless a browser on another origin calls the API host directly.

## Auth

Humans send the `hearth_session` cookie (set by dev sign-in or Google). Bots send `Authorization: Bearer hth_…`. A token is scoped to one team. Owners create and revoke tokens in team settings. The secret is returned once and only its hash is stored.

On first sign-in, the user gets a personal team. Households are created explicitly. An owner adds a member by email after that person has signed in at least once. Personal teams have no extra members.

## HTTP API

The web app prefixes these paths with `/api`. The API port serves them at the root. Bodies are strict JSON. Errors look like `{ "error": { "code": "…", "message": "…" } }`.

These are the task operations the MCP server binds to. It does not add task fields:

| Operation | Request |
| --- | --- |
| `createTask` | `POST /tasks` |
| `updateTask` | `PATCH /tasks/:id` (rejects `status`; completing is separate) |
| `completeTask` | `POST /tasks/:id/complete` `{ "outcome": "…" }` |
| `cancelTask` | `POST /tasks/:id/cancel` `{ "outcome": "…" }` optional; default `"cancelled"` |
| `deleteTask` | `DELETE /tasks/:id` |
| `listTasks` | `GET /tasks` |
| `listDoImmediately` | `GET /tasks/do-immediately` |

A task:

```json
{
  "id": "…",
  "teamId": "…",
  "title": "Buy oat milk",
  "detail": null,
  "status": "open",
  "owner": { "type": "user", "id": "…" },
  "important": true,
  "urgent": true,
  "action": "do_now",
  "waitingOn": null,
  "calendarEventId": null,
  "needsCalendar": false,
  "project": { "id": "…", "name": "Boiler service" },
  "area": { "id": "…", "name": "House" },
  "source": null,
  "dueAt": "2026-11-02T00:00:00.000Z",
  "outcome": null,
  "createdAt": "2026-11-01T00:00:00.000Z",
  "updatedAt": "2026-11-01T00:00:00.000Z",
  "completedAt": null,
  "cancelledAt": null,
  "sortOrder": null,
  "createdBy": { "type": "user", "id": "…" }
}
```

`action` is `do_now`, `delegate`, `schedule`, or `later`. On create, omit `action` to take the suggestion from important × urgent: both true → `do_now`, urgent only → `delegate`, important only → `schedule`, neither → `later`. Sending `action` overrides that suggestion and does not change the two flags.

`waitingOn` is required when `action` is `delegate`. On create, omit `dueAt` for a delegated task and the follow-up is set three days ahead. That date is the nudge. Sending `dueAt: null` stores no follow-up; the task joins the morning queue once it is more than three days old. `outcome` is required when the task is completed.

`status` is `open`, `done`, or `cancelled`. Cancel keeps the row: `POST /tasks/:id/cancel` sets `status` to `cancelled`, `cancelledAt`, and `outcome` (the body may omit it, and the stored value is then `cancelled`). `completedAt` stays null. A cancelled task is out of `status=open` and out of the morning queue. `GET /tasks?status=cancelled` is the audit list; a list with no status filter still includes it. Cancelling a done task is **409** `already_done`. Cancelling again, or completing a cancelled task, is **409** `already_cancelled`.

`DELETE /tasks/:id` removes the row. That is for a mistake or a duplicate. The response is `{ "id": "…", "deleted": true }`. A second delete is **404**. Deleting the task also deletes its idempotency row, so the same `Idempotency-Key` can create a new task. Another team's token gets **403**.

`calendarEventId` is an optional calendar event id. The server keeps `needsCalendar` in line with it: a `schedule` task with no id is stored with `needsCalendar` true, and any id forces `needsCalendar` false. You can omit `needsCalendar`.

`project` and `area` are `{ "id", "name" }` or null. A project is a multi-step outcome. An area is a life or work domain, such as House or Finance. They are separate. Set them with `projectId` and `areaId` (a uuid on that team, or null to clear). Omit either on update to leave it unchanged. The old free-text `project` string is rejected.

On a project, each task is one step. `do_now`, `delegate`, and `schedule` are active next actions. Several may be open on the same project; the API does not reject that. Future or dependent steps are tasks with `action` `later`. Create one task per step and set `action` explicitly when the important × urgent suggestion is not the step you want. `later` stays out of `GET /tasks/do-immediately` until the action changes. `sortOrder` is an optional integer (0 or greater) for the order of a step inside its active list or its later list. Omit it and the step sorts after numbered ones. Project `notes` are the support plan (purpose, sequence, constraints), not the step list. `area` on a project is `{ "id", "name" }` or null. Set it with `areaId`.

`source` is an optional link back to where the task came from. It is `null`, or:

```json
{
  "type": "email",
  "href": "https://mail.google.com/mail/u/0/#all/18f2c4e8a1b2c3d4",
  "label": "Re: oat milk",
  "externalId": "18f2c4e8a1b2c3d4"
}
```

`type` is `email` or `url`. `href` is an http or https URL; the web app opens it in a new tab. `label` is optional display text, such as a subject. `externalId` is optional and is the provider's own id, not the link. Omit `label` and `externalId` when you do not have them. A blank string is rejected.

Omit `source` on create to store null. On update, omit it to leave the link alone, or send `null` to clear it. Sending `source` replaces the whole object.

For Gmail, `href` is the thread URL from the Gmail address bar: `https://mail.google.com/mail/u/0/#all/<threadId>`. Use `/u/1/` (or the matching index) when that mailbox is not the first signed-in account. `#inbox/<threadId>` works the same way. Put the Gmail API message id or the thread id in `externalId` so a bot can find the message again without parsing the URL. `type` stays `email`. Any other page uses `type` `url` and the same `href`.

`create_task` and `update_task` take this same `source`. `list_tasks`, `GET /tasks`, `GET /tasks/do-immediately`, create, update, complete, cancel, delete, and the SSE `task` object all include it. On a `deleted` event from another API process, `task` is null.

`GET /tasks` query: `teamId`, `action`, `status` (`open`, `done`, or `cancelled`), `important`, `urgent`, `owner` (`user:<uuid>` or `bot:<uuid>`), `dueBefore`, `projectId`, `areaId`, `mine`. `lane` is rejected, and so is the old `project` string. Humans who omit `teamId` get every team they belong to. A bot who omits `teamId` is limited to its token's team. Passing another team returns 403.

`GET /tasks/do-immediately` returns open tasks that are `do_now`, or `schedule` and still need a calendar or have a `dueAt` in the past, or `delegate` with a follow-up at or before now (or no `dueAt` and `createdAt` more than three days ago). Done, cancelled, and `later` tasks stay out, including future steps on a project. Optional `teamId`. Order: important and urgent, then important, then urgent, then the rest; within that, `dueAt` ascending with nulls last; then `updatedAt` descending.

Other routes humans use from the app: `GET /auth/config`, `POST /auth/dev`, `GET /auth/google`, `GET /auth/me`, `POST /auth/logout`, `GET /teams`, `POST /teams`, `GET /teams/:id`, `GET /teams/:id/events`, `POST /teams/:id/members`, `GET|POST /teams/:id/bots`, `DELETE /teams/:id/bots/:botId`, `GET|POST /teams/:id/projects`, `PATCH /teams/:id/projects/:projectId`, `GET|POST /teams/:id/areas`, `PATCH /teams/:id/areas/:areaId`, `GET|POST /teams/:id/tokens`, `DELETE /teams/:id/tokens/:tokenId`.

`POST` for an area takes `{ "name": "…" }`. `POST` for a project takes `{ "name": "…", "notes": "…" }`. `notes` is optional, at most 5000 characters, and null when omitted. The same name on that team returns the existing row (200) and restores it if it was archived. Sending `notes` on that call replaces the stored notes; omit `notes` to leave them. A new row is 201. `PATCH` for an area takes `name` and/or `archived`. `PATCH` for a project also takes `notes` (`null` clears it), `areaId` (a uuid on that team, or `null` to clear), and `archived`. Setting `archived` to true completes the project. It is rejected with `409` `project_open_tasks` while any task on that project is still `open`. Complete or cancel those tasks first. The row is not deleted. `GET` omits archived rows unless `includeArchived=true`. A project in the list looks like `{ "id", "teamId", "name", "notes", "area", "archivedAt", "createdAt", "updatedAt" }`. An area has the same fields without `notes` and `area`. Archived links stay on tasks until cleared.

The API does not cap how many active steps a project has. Prefer `later` for steps that are not a current front; that is guidance, not a check.

### curl

Dev sign-in stores the session cookie. This only works while `DEV_AUTH=1`.

```bash
curl -sS -c /tmp/hearth.cj -H 'content-type: application/json' \
  -d '{"email":"james@example.com"}' \
  http://127.0.0.1:43124/auth/dev

curl -sS -b /tmp/hearth.cj http://127.0.0.1:43124/teams
```

Create, update, and complete. `TEAM` and `TASK` come from the previous responses. Updating `status` is rejected; use complete.

```bash
curl -sS -b /tmp/hearth.cj -H 'content-type: application/json' \
  -d '{"teamId":"TEAM","title":"Buy oat milk","important":true,"urgent":true,"action":"do_now","projectId":"PROJECT","areaId":"AREA"}' \
  http://127.0.0.1:43124/tasks

curl -sS -b /tmp/hearth.cj -X PATCH -H 'content-type: application/json' \
  -d '{"action":"delegate","waitingOn":"the grocer opens"}' \
  http://127.0.0.1:43124/tasks/TASK

curl -sS -b /tmp/hearth.cj -H 'content-type: application/json' \
  -d '{"outcome":"Oat milk is in the fridge"}' \
  http://127.0.0.1:43124/tasks/TASK/complete

curl -sS -b /tmp/hearth.cj -H 'content-type: application/json' \
  -d '{"outcome":"duplicate"}' \
  http://127.0.0.1:43124/tasks/TASK/cancel

curl -sS -b /tmp/hearth.cj -X DELETE http://127.0.0.1:43124/tasks/TASK

curl -sS -b /tmp/hearth.cj 'http://127.0.0.1:43124/tasks/do-immediately?teamId=TEAM'
```

Mint a bot token as a team owner (the secret is in this response only), then call as the bot:

```bash
curl -sS -b /tmp/hearth.cj -H 'content-type: application/json' \
  -d '{"label":"kitchen-bot"}' \
  http://127.0.0.1:43124/teams/TEAM/tokens

curl -sS -H 'authorization: Bearer hth_…' \
  http://127.0.0.1:43124/tasks/do-immediately
```

### Idempotent create

`POST /tasks` accepts an `Idempotency-Key` header. There is no body field. The key is 1 to 255 printable ASCII characters with no spaces. It is stored for the actor that sent it (the signed-in user, or the bot token) for 24 hours.

The first success returns **201** and the task. The same actor, key, and parsed body inside that window returns **200**, the header `Idempotent-Replayed: true`, and that same task. It does not create another. Key order and surrounding whitespace do not count as a different body. A different body with the same key returns **409** `idempotency_mismatch`. After 24 hours the key can create a new task. Omitting the header keeps the old behaviour: every call creates a task.

```bash
curl -sS -D - -b /tmp/hearth.cj -H 'content-type: application/json' \
  -H 'Idempotency-Key: oat-milk-1' \
  -d '{"teamId":"TEAM","title":"Buy oat milk","important":true,"urgent":true}' \
  http://127.0.0.1:43124/tasks
```

## Bot owners

A registered bot is an identity, not a credential. `POST /teams/:id/bots` with `{ "agentId": "…", "name": "Fin" }` creates a row and returns its id. No `hth_…` secret is minted. That id is the task owner: `{ "type": "bot", "id": "…" }`. The same agent id on the same team returns the same bot (200). A different name renames it and keeps the id. `GET /teams/:id/bots` lists them. `DELETE /teams/:id/bots/:botId` unregisters one; tasks already pointing at that id are left as they are.

Anyone who can see the team can register, including the team bot token. A random bot id is rejected with 400 `invalid_owner`. An existing per-bot token can still own a task through the API — that mint stays an escape hatch, and it is not required. The task sheet lists team members and registered bots. Waiting on stays a free-text string. Settings can register a bot so it appears there.

## Live task events

`GET /teams/:id/events` is a server-sent events stream of task creates, updates, completions, cancellations, and deletes on that team. Auth is the same as the rest of the API: `Authorization: Bearer hth_…` or the `hearth_session` cookie. A bot token only opens its own team. Anyone else gets 403 or 404.

The browser `EventSource` API cannot set an `Authorization` header. A Grok bot should stream the response with `fetch` (or `curl -N`) and send the Bearer token. A signed-in human can use `EventSource` on the web origin, which sends the cookie.

```bash
curl -N -H 'authorization: Bearer hth_…' -H 'accept: text/event-stream' \
  http://127.0.0.1:43124/teams/TEAM/events
```

Through the web proxy that is `http://127.0.0.1:43123/api/teams/TEAM/events`. On Railway, use the public HTTPS origin the same way (`https://<api-host>/teams/TEAM/events` or `https://<web-host>/api/teams/TEAM/events`).

The first message is `event: ready` with `{"teamId":"…"}` and `retry: 3000`. Each change is one message. The event name is `created`, `updated`, `completed`, `cancelled`, or `deleted`. The data is JSON:

```json
{
  "type": "created",
  "teamId": "…",
  "taskId": "…",
  "at": "2026-11-02T12:00:00.000Z",
  "task": {}
}
```

For create, update, complete, and cancel, `at` is that write's `updatedAt`. For delete, `at` is when the row was removed. `task` is the same object `GET /tasks` returns, including `source`, so a bot can apply it without a second request. On `deleted`, the process that removed the row sends that last copy. Another API process sends `task: null`, because the row is already gone; `taskId` is enough to drop it. The stream is live only: there is no backlog, and `Last-Event-ID` is not replayed. An idempotent replay of `POST /tasks` does not send another `created`.

Lines that start with `:` are keepalives, about every 20 seconds. They are not task changes. Access is checked when the stream opens and again on each keepalive.

Railway's public HTTP proxy closes a request after 5 minutes with no bytes, and after 15 minutes even when bytes are flowing. WebSockets are exempt; this stream is not. The keepalive stays under that idle limit and under nginx's default 60 second read timeout. The API closes the stream itself after 14 minutes with `event: reconnect` and `{"reason":"max_duration"}`. Open the URL again, and call `GET /tasks` (or MCP `list_tasks`) for anything missed while disconnected. A revoked token or a removed member gets `{"reason":"access_ended"}`. The next connection is then 401 or 403; stop in that case.

`SSE_HEARTBEAT_MS` (default 20000, clamped to 200–30000) and `SSE_MAX_MS` (default 840000, clamped to 200–840000) override those intervals.

Every API process listens on Postgres. The process that wrote the task sends the event with that row. Other processes send the same type and time with the row they read when the notice arrives. A delete has no row left to read, so those processes send `task: null`. The notice itself is only ids, because Postgres caps a notify payload at 8000 bytes.

The web nginx proxy turns off response buffering for `/api/` and waits up to 15 minutes between chunks, so a bot can subscribe through the web origin. Outbound webhooks are not in this version. A subscription would make the API call a URL a bot supplies, and this stream already covers a bot that can hold a connection.

## MCP

The API serves a stateless MCP endpoint at `POST /mcp` (Streamable HTTP, JSON responses, no SSE stream). Other methods get 405. Auth is the bot Bearer token, the same `Authorization: Bearer hth_…` header as the REST API. A session cookie is not accepted here.

Tools call the task routes above: `create_task` (one step per call; pass `idempotencyKey`; it is sent as `Idempotency-Key`; `owner` can be a registered bot; `projectId` and `areaId` link a project or an area; set `action` to `later` for a future project step, or `do_now`, `delegate`, or `schedule` for an active front; `source` is the email or URL link), `update_task` (change `action` to bring a later step forward or park an active one; null clears a project, area, or source link), `complete_task`, `cancel_task` (optional `outcome`), `delete_task`, `list_tasks` (filter `projectId` and `action` to separate active steps from later ones), and `list_do_immediately` (excludes `later`, done, and cancelled). List filters match `GET /tasks`. Returned tasks include `action`, `source`, `project`, `area`, and `sortOrder`. `create_project` and `update_project` take optional `notes`. `update_project` also takes `areaId` and `archived`. Archiving is rejected while any step is still open. `list_projects` returns `notes` and `area`. `create_area` and `list_areas` manage areas. `register_bot`, `list_bots`, and `unregister_bot` manage bot owners. Omit `teamId` on those when the token belongs to one team.

`POST /mcp` does not stream task changes. The server instructions and the `hearth://task-events` resource point at `GET /teams/:id/events`. See Live task events above.

Direct API URL: `http://127.0.0.1:43124/mcp`. Through the web proxy that is `http://127.0.0.1:43123/api/mcp`. A hosted bot needs the public HTTPS API origin, for example `https://<api-host>/mcp`. Grok Bot connects from Cursor's network, so localhost will not work there.

Cursor, in `~/.cursor/mcp.json` or the project's `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "hearth": {
      "url": "https://<api-host>/mcp",
      "headers": {
        "Authorization": "Bearer hth_…"
      }
    }
  }
}
```

Grok Bot: Settings → Plugins → add a custom MCP server. Name it Hearth, set the URL to `https://<api-host>/mcp`, and set the header `Authorization` to `Bearer hth_…`. Attach the plugin in the bot chat. Use a static bearer token. This server does not use OAuth.

An Agent SDK connection file is the same URL and header:

```ts
export default defineConnection({
  url: "https://<api-host>/mcp",
  headers: { Authorization: "Bearer ${HEARTH_BOT_TOKEN}" },
});
```

## Layout

- `apps/api` — Hono, Drizzle, Postgres. Migrations in `apps/api/drizzle`.
- `apps/web` — Vite, React, Tailwind. Installable PWA (manifest and a generated service worker).
- `packages/shared` — the task and team types, plus the Zod bodies the API parses.
- `infra/terraform` — deploy placeholder. Local running does not need it.
- `scripts/isolation-check.ts` — the access check above.

Schema changes need a new SQL file under `apps/api/drizzle` and a matching entry in `drizzle/meta/_journal.json`. The Drizzle schema in `apps/api/src/schema.ts` is what queries use.

`0005_projects.sql` copies each non-empty `tasks.project` string into a team-scoped project and sets `project_id`, then drops the text column. Strings that are area names (House, Home, Finance, Work, Kitchen, Shed, Admin, Errands, Personal, Health, Family, Career, any case) are left unlinked. Areas are not invented from those strings.

`0006_cancel.sql` adds `cancelled` to task status and `cancelled_at`. `0007_project_notes.sql` adds nullable `projects.notes` (at most 5000 characters) for the support plan. `0008_project_detail.sql` adds `projects.area_id` and `tasks.sort_order`. Neither moves tasks.

## Not in v1

File attachments, live Google Calendar create/sync, outbound webhooks, and native apps. A task can store a calendar event id, a source link (email or any http(s) URL), and a project and an area. Railway config is in the repo; this repo does not create or deploy the Railway project.
