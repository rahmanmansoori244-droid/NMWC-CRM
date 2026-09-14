-- B5 (enterprise assessment, 2026-09-14): a dead-man record for every scheduled
-- job. Each cron route upserts its row when it finishes (success or failure);
-- the bearer-authenticated /api/health probe compares the rows against the
-- expected cadence and reports "stale" / "never ran" — the alarm that was
-- missing while the SLA escalation sweep silently never ran in production.
CREATE TABLE "CronHeartbeat" (
    "key"            TEXT NOT NULL,
    "lastRunAt"      TIMESTAMP(3) NOT NULL,
    "lastOk"         BOOLEAN NOT NULL DEFAULT true,
    "lastDurationMs" INTEGER,
    "lastError"      TEXT,
    "lastDetail"     JSONB,
    "runs"           INTEGER NOT NULL DEFAULT 0,
    "failures"       INTEGER NOT NULL DEFAULT 0,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CronHeartbeat_pkey" PRIMARY KEY ("key")
);
