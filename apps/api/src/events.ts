import { taskEventTypes, type Task, type TaskEvent, type TaskEventType } from "@hearth/shared";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import pg from "pg";
import { z } from "zod";
import { assertActorCurrent, type AppEnv } from "./actor.js";
import { pool, poolConfig } from "./db.js";
import { HttpError } from "./errors.js";
import { loadTaskView } from "./task-json.js";

/**
 * Postgres NOTIFY payload cap is 8000 bytes, so the notice is only ids.
 * `origin` lets the writing process ignore its own notice: that process
 * already handed subscribers the row it just wrote. Other API processes
 * load the row when the notice arrives.
 *
 * Railway's public HTTP edge closes a request after 5 minutes with no
 * bytes, and after 15 minutes even while bytes are flowing. WebSockets
 * are exempt; this stream is not. Keepalives stay under nginx's default
 * 60s read timeout. The handler ends the response before the 15 minute cap.
 */
const CHANNEL = "hearth_task_events";
const DEFAULT_HEARTBEAT_MS = 20_000;
const DEFAULT_MAX_MS = 14 * 60 * 1000;
const MAX_QUEUED = 100;

export const taskEventOrigin = crypto.randomUUID();

const notifySchema = z
  .object({
    origin: z.string().min(1).max(80),
    type: z.enum(taskEventTypes),
    teamId: z.string().uuid(),
    taskId: z.string().uuid(),
    at: z.string().datetime({ offset: true }),
  })
  .strict();

type Listener = (event: TaskEvent) => void;

const subscribers = new Map<string, Set<Listener>>();
let listenClient: pg.Client | null = null;
let starting: Promise<void> | null = null;
let shuttingDown = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

export function ensureTaskEvents(): Promise<void> {
  shuttingDown = false;
  if (listenClient) return Promise.resolve();
  if (!starting) {
    starting = connectListener().finally(() => {
      starting = null;
    });
  }
  return starting;
}

export async function closeTaskEvents() {
  shuttingDown = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const current = listenClient;
  listenClient = null;
  if (!current) return;
  current.removeAllListeners();
  await current.end().catch(() => undefined);
}

export async function publishTaskEvent(type: TaskEventType, task: Task, at = task.updatedAt) {
  deliverLocal({
    type,
    teamId: task.teamId,
    taskId: task.id,
    at,
    task,
  });
  const payload = JSON.stringify({
    origin: taskEventOrigin,
    type,
    teamId: task.teamId,
    taskId: task.id,
    at,
  });
  try {
    await pool.query("select pg_notify($1, $2)", [CHANNEL, payload]);
  } catch (err) {
    console.error("task event notify failed", err);
  }
}

/** Used by the LISTEN client and by tests standing in for another API process. */
export async function handleRemoteNotification(payload: string) {
  let note: z.infer<typeof notifySchema>;
  try {
    note = notifySchema.parse(JSON.parse(payload) as unknown);
  } catch {
    return;
  }
  if (note.origin === taskEventOrigin) return;
  if (!subscribers.get(note.teamId)?.size) return;
  if (note.type === "deleted") {
    const task = await loadTaskView(note.taskId);
    deliverLocal({
      type: "deleted",
      teamId: note.teamId,
      taskId: note.taskId,
      at: note.at,
      task: task && task.teamId === note.teamId ? task : null,
    });
    return;
  }
  const task = await loadTaskView(note.taskId);
  if (!task || task.teamId !== note.teamId) return;
  deliverLocal({
    type: note.type,
    teamId: note.teamId,
    taskId: note.taskId,
    at: note.at,
    task,
  });
}

export function openTaskEventStream(c: Context<AppEnv>, teamId: string): Response {
  const actor = c.get("actor");
  const response = streamSSE(c, async (stream) => {
    let done = false;
    let wake: (() => void) | null = null;
    let waitTimer: ReturnType<typeof setTimeout> | null = null;
    const queue: TaskEvent[] = [];
    let overflow = false;
    const stop = () => {
      done = true;
      wake?.();
    };
    if (c.req.raw.signal.aborted) done = true;
    else c.req.raw.signal.addEventListener("abort", stop, { once: true });
    stream.onAbort(stop);

    const unsubscribe = subscribe(teamId, (event) => {
      queue.push(event);
      if (queue.length > MAX_QUEUED) overflow = true;
      wake?.();
    });

    const heartbeatMs = readBounded("SSE_HEARTBEAT_MS", DEFAULT_HEARTBEAT_MS, 200, 30_000);
    const maxMs = readBounded("SSE_MAX_MS", DEFAULT_MAX_MS, 200, DEFAULT_MAX_MS);
    const started = Date.now();
    let nextBeat = started + heartbeatMs;

    try {
      if (done) return;
      await stream.writeSSE({
        event: "ready",
        data: JSON.stringify({ teamId }),
        retry: 3000,
      });
      while (!done && !stream.aborted && !stream.closed) {
        if (Date.now() - started >= maxMs) {
          await stream.writeSSE({ event: "reconnect", data: JSON.stringify({ reason: "max_duration" }) });
          break;
        }
        if (overflow) {
          await stream.writeSSE({ event: "reconnect", data: JSON.stringify({ reason: "overflow" }) });
          break;
        }
        const next = queue.shift();
        if (next) {
          await stream.writeSSE({
            event: next.type,
            id: `${next.taskId}@${next.at}`,
            data: JSON.stringify(next),
          });
          continue;
        }
        const waitMs = Math.max(0, Math.min(nextBeat, started + maxMs) - Date.now());
        await new Promise<void>((resolve) => {
          let settled = false;
          waitTimer = setTimeout(finish, waitMs);
          wake = finish;
          if (done || queue.length > 0) finish();

          function finish() {
            if (settled) return;
            settled = true;
            if (waitTimer) clearTimeout(waitTimer);
            waitTimer = null;
            resolve();
          }
        });
        wake = null;
        if (done || stream.aborted || stream.closed) break;
        if (Date.now() < nextBeat) continue;
        try {
          await assertActorCurrent(actor, teamId);
        } catch (err) {
          if (!(err instanceof HttpError)) console.error(err);
          if (!stream.aborted && !stream.closed) {
            await stream.writeSSE({ event: "reconnect", data: JSON.stringify({ reason: "access_ended" }) });
          }
          break;
        }
        await stream.write(": ping\n\n");
        nextBeat = Date.now() + heartbeatMs;
      }
    } catch (err) {
      if (!done && !c.req.raw.signal.aborted) console.error(err);
    } finally {
      unsubscribe();
      if (waitTimer) clearTimeout(waitTimer);
      waitTimer = null;
      wake = null;
    }
  });
  response.headers.set("Cache-Control", "no-cache, no-transform");
  response.headers.set("X-Accel-Buffering", "no");
  return response;
}

function subscribe(teamId: string, listener: Listener) {
  let set = subscribers.get(teamId);
  if (!set) {
    set = new Set();
    subscribers.set(teamId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) subscribers.delete(teamId);
  };
}

function deliverLocal(event: TaskEvent) {
  const set = subscribers.get(event.teamId);
  if (!set) return;
  for (const listener of [...set]) {
    try {
      listener(event);
    } catch (err) {
      console.error("task event listener failed", err);
    }
  }
}

async function connectListener() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const next = new pg.Client(poolConfig(connectionString));
  next.on("error", (err) => {
    console.error("task event listen failed", err);
    if (listenClient === next) listenClient = null;
    scheduleReconnect();
  });
  next.on("end", () => {
    if (listenClient === next) listenClient = null;
    scheduleReconnect();
  });
  await next.connect();
  await next.query(`listen ${CHANNEL}`);
  next.on("notification", (message) => {
    if (message.channel !== CHANNEL || !message.payload) return;
    void handleRemoteNotification(message.payload);
  });
  if (shuttingDown) {
    next.removeAllListeners();
    await next.end().catch(() => undefined);
    return;
  }
  listenClient = next;
}

function scheduleReconnect() {
  if (shuttingDown || starting || listenClient || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void ensureTaskEvents().catch((err) => console.error("task event listen failed", err));
  }, 1000);
  reconnectTimer.unref();
}

function readBounded(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return fallback;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
