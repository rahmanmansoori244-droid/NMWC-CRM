# Morning-of-launch checklist — retired

**Do not follow the checklist that used to be in this file.** It was written for the
first pilot and no longer describes the system:

- it had the operator sign in with the pilot test accounts, which are kept disabled
  and must stay that way;
- the customer and photo counts it told you to expect were the pilot's;
- it named the nightly backup `db/<date>.sql.gz`, but backups are encrypted and end in
  `.sql.gz.age` (OPERATIONS §5b B) — a reader looking for the old name finds nothing
  and concludes the backup failed;
- it handed out a Supervisor guide, but the organisation chart has no Supervisor
  accounts: each Manager supervises his own salesmen (GO-LIVE-RUNBOOK §0, item 3);
- its first action for a 500 was `npx vercel --prod --yes`. That uploads and builds
  whatever tree happens to be checked out locally, and the build runs
  `prisma migrate deploy` before `next build` — so an old or unreviewed tree could
  migrate the production database and then go live without CI ever seeing it.

Use these instead:

- [OPERATIONS.md](OPERATIONS.md) — health checks, deploy and rollback (§4), finding
  an error by its Reference (§5g), common operations (§7), day-1 support (§7a) and
  the incident playbook (§8).
- [GO-LIVE-RUNBOOK.md](GO-LIVE-RUNBOOK.md) — loading the customer and account
  masters, and verifying the load.
- [HANDOVER.md](HANDOVER.md) — how a change is made, verified and merged, and how to
  read and write production safely.
