-- A bot owner is who acts, so a delegate task may omit waiting_on.
-- A human-owned delegate still names the outsider it is waiting on.
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_delegate_waiting_chk";
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_delegate_waiting_chk" CHECK (
  "action" <> 'delegate'
  OR "owner_type" = 'bot'
  OR ("waiting_on" IS NOT NULL AND length(btrim("waiting_on")) > 0)
);
