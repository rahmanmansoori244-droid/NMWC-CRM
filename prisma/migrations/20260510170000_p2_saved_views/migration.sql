-- P2.2 (2026-05-10): per-user saved filter views for the /customers list.
--
-- Each row is a named snapshot of the URL search-params a user composed on
-- the customers page (e.g. "region=A&route=B&minScore=70"). Recall a view by
-- selecting it from the "Saved views" dropdown to navigate to
-- `/customers?<urlParams>`.
--
-- Per-user only. Cascade-delete with the User row.

CREATE TABLE "SavedView" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "urlParams" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavedView_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SavedView_userId_createdAt_idx"
    ON "SavedView"("userId", "createdAt" DESC);

ALTER TABLE "SavedView"
    ADD CONSTRAINT "SavedView_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
