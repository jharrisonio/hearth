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
| `API_UPSTREAM` | Web only. Full API URL. Compose sets `http://api:3001`. Leave empty on Railway |
| `API_HOST` / `API_PORT` | Web only. Used when `API_UPSTREAM` is empty. Railway wires these to the API private network |

Copy `.env.example` for host-side `pnpm dev`. Compose sets the variables itself. Production values stay in the host, not in git.

## Railway

`.railway/railway.ts` describes three resources that share one Railway project. Nothing in that file is a production secret, and applying it is a manual step after you link a project you already created.

- `postgres` — Railway Postgres. The API takes `DATABASE_URL` from it.
- `api` — image from `/apps/api/Dockerfile`.
- `web` — image from `/apps/web/Dockerfile`. Nginx listens on `PORT` and proxies `/api` to the API over the private network, so the session cookie stays on the web origin.

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

These are the task operations a future MCP wrapper can bind to without adding fields:

| Operation | Request |
| --- | --- |
| `createTask` | `POST /tasks` |
| `updateTask` | `PATCH /tasks/:id` (rejects `status`; completing is separate) |
| `completeTask` | `POST /tasks/:id/complete` `{ "outcome": "…" }` |
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
  "project": "Kitchen",
  "dueAt": "2026-11-02T00:00:00.000Z",
  "outcome": null,
  "createdAt": "2026-11-01T00:00:00.000Z",
  "updatedAt": "2026-11-01T00:00:00.000Z",
  "completedAt": null,
  "createdBy": { "type": "user", "id": "…" }
}
```

`action` is `do_now`, `delegate`, `schedule`, or `later`. On create, omit `action` to take the suggestion from important × urgent: both true → `do_now`, urgent only → `delegate`, important only → `schedule`, neither → `later`. Sending `action` overrides that suggestion and does not change the two flags.

`waitingOn` is required when `action` is `delegate`. On create, omit `dueAt` for a delegated task and the follow-up is set three days ahead. That date is the nudge. Sending `dueAt: null` stores no follow-up; the task joins the morning queue once it is more than three days old. `outcome` is required when the task is completed.

`calendarEventId` is an optional calendar event id. The server keeps `needsCalendar` in line with it: a `schedule` task with no id is stored with `needsCalendar` true, and any id forces `needsCalendar` false. You can omit `needsCalendar`.

`GET /tasks` query: `teamId`, `action`, `status` (`open` or `done`), `important`, `urgent`, `owner` (`user:<uuid>` or `bot:<uuid>`), `dueBefore`, `project`, `mine`. `lane` is rejected. Humans who omit `teamId` get every team they belong to. A bot who omits `teamId` is limited to its token's team. Passing another team returns 403.

`GET /tasks/do-immediately` returns open tasks that are `do_now`, or `schedule` and still need a calendar or have a `dueAt` in the past, or `delegate` with a follow-up at or before now (or no `dueAt` and `createdAt` more than three days ago). Optional `teamId`. Order: important and urgent, then important, then urgent, then the rest; within that, `dueAt` ascending with nulls last; then `updatedAt` descending.

Other routes humans use from the app: `GET /auth/config`, `POST /auth/dev`, `GET /auth/google`, `GET /auth/me`, `POST /auth/logout`, `GET /teams`, `POST /teams`, `GET /teams/:id`, `POST /teams/:id/members`, `GET|POST /teams/:id/tokens`, `DELETE /teams/:id/tokens/:tokenId`.

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
  -d '{"teamId":"TEAM","title":"Buy oat milk","important":true,"urgent":true,"action":"do_now","project":"Kitchen"}' \
  http://127.0.0.1:43124/tasks

curl -sS -b /tmp/hearth.cj -X PATCH -H 'content-type: application/json' \
  -d '{"action":"delegate","waitingOn":"the grocer opens"}' \
  http://127.0.0.1:43124/tasks/TASK

curl -sS -b /tmp/hearth.cj -H 'content-type: application/json' \
  -d '{"outcome":"Oat milk is in the fridge"}' \
  http://127.0.0.1:43124/tasks/TASK/complete

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

## Layout

- `apps/api` — Hono, Drizzle, Postgres. Migrations in `apps/api/drizzle`.
- `apps/web` — Vite, React, Tailwind. Installable PWA (manifest and a generated service worker).
- `packages/shared` — the task and team types, plus the Zod bodies the API parses.
- `infra/terraform` — deploy placeholder. Local running does not need it.
- `scripts/isolation-check.ts` — the access check above.

Schema changes need a new SQL file under `apps/api/drizzle` and a matching entry in `drizzle/meta/_journal.json`. The Drizzle schema in `apps/api/src/schema.ts` is what queries use.

## Not in v1

Attachments, email links, live Google Calendar create/sync, a Project entity, and native apps. A task can store a calendar event id. Railway config is in the repo; this repo does not create or deploy the Railway project.
