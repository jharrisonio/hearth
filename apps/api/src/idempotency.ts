import { createHash } from "node:crypto";
import {
  IDEMPOTENCY_TTL_MS,
  idempotencyKeySchema,
  type CreateTaskInput,
} from "@hearth/shared";
import { and, eq, sql } from "drizzle-orm";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { Actor } from "./actor.js";
import { db } from "./db.js";
import { HttpError } from "./errors.js";
import * as schema from "./schema.js";
import { idempotencyKeys, tasks } from "./schema.js";

type TaskRow = typeof tasks.$inferSelect;
export type DbTx = PgTransaction<
  NodePgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

/**
 * Missing header means a normal create. A present header must be a short printable token.
 * The value is trimmed; surrounding spaces are not part of the key.
 */
export function parseIdempotencyKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parsed = idempotencyKeySchema.safeParse(value);
  if (!parsed.success) {
    throw new HttpError(
      400,
      "invalid_idempotency_key",
      "Idempotency-Key must be 1 to 255 printable ASCII characters with no spaces.",
    );
  }
  return parsed.data;
}

/**
 * Run `insert` once per actor and key inside the replay window.
 * The advisory lock is held for the whole transaction, so two retries cannot
 * both insert a task before either stores the key. The unique constraint is
 * the backstop. `insert` must use `tx` only, so it does not take a second pool
 * connection while this one is held.
 */
export async function withCreateIdempotency(
  actor: Actor,
  key: string | undefined,
  body: CreateTaskInput,
  insert: (tx: DbTx) => Promise<TaskRow>,
): Promise<{ row: TaskRow; replayed: boolean }> {
  if (key === undefined) {
    const row = await db.transaction((tx) => insert(tx));
    return { row, replayed: false };
  }

  const requestHash = hashCreateBody(body);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockId(actor, key)}, 0))`);
    const [existing] = await tx
      .select()
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.actorType, actor.type),
          eq(idempotencyKeys.actorId, actor.id),
          eq(idempotencyKeys.idempotencyKey, key),
        ),
      )
      .limit(1);

    if (existing && isFresh(existing.createdAt)) {
      if (existing.requestHash !== requestHash) {
        throw new HttpError(
          409,
          "idempotency_mismatch",
          "This Idempotency-Key was already used for a different request.",
        );
      }
      const [row] = await tx.select().from(tasks).where(eq(tasks.id, existing.taskId)).limit(1);
      if (!row) throw new HttpError(404, "not_found", "Task not found.");
      return { row, replayed: true };
    }

    const row = await insert(tx);
    if (existing) {
      await tx
        .update(idempotencyKeys)
        .set({ requestHash, taskId: row.id, createdAt: new Date() })
        .where(eq(idempotencyKeys.id, existing.id));
    } else {
      await tx.insert(idempotencyKeys).values({
        actorType: actor.type,
        actorId: actor.id,
        idempotencyKey: key,
        requestHash,
        taskId: row.id,
        createdAt: new Date(),
      });
    }
    return { row, replayed: false };
  });
}

function lockId(actor: Actor, key: string) {
  return `hearth:idempotency:${actor.type}:${actor.id}:${key}`;
}

function isFresh(createdAt: Date | string) {
  const at = createdAt instanceof Date ? createdAt.getTime() : new Date(createdAt).getTime();
  return Date.now() - at < IDEMPOTENCY_TTL_MS;
}

/** Parsed body, not the raw bytes: key order and trimmed strings do not count as a different request. */
export function hashCreateBody(body: CreateTaskInput) {
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([entryKey, entry]) => `${JSON.stringify(entryKey)}:${canonicalJson(entry)}`).join(",")}}`;
}
