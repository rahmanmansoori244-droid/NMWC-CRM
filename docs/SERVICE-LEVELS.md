# Service levels

Item 9 of the re-benchmark (2026-09-24): *no SLOs, no dashboard.* Nobody could say
what "working" meant, so the first sign of trouble was a user complaining.

This page is the promise. The **Service status** page in the app (menu → Service
status; Data Steward and Managers) is the measurement, taken live from what the
system records. The targets and thresholds below are also in
`lib/service-levels.ts`, and `tests/unit/service-levels.test.ts` fails if this
page and the code disagree on any of them.

Targets were set on 2026-09-27 as engineering proposals the owner accepted ("go
with your recommendations"). Change them in both places together.

## The objectives

| Objective | Target | How it is measured |
|---|---|---|
| **The app answers** | 99.5% of slots, 30 days | Every 4 minutes from 07:00 to 19:00 Oman, the keep-warm probe calls the app, which queries its database. A 4-minute slot is good when a probe in it succeeded. A slot with no probe at all counts against the target, because when the app or its database is down the probe cannot record anything, so an outage looks exactly like silence. 99.5% allows 27 four-minute slots in 30 days: about 108 minutes of outage between 07:00 and 19:00. |
| **Approvals decided within their SLA** | 90% of decisions, 30 days | Every approval step approved or sent back, compared with the time that step was due. The due time is set on the Sunday–Thursday 08:00–17:00 working calendar from the budget frozen when the request was submitted. Reactivations count as the Manager tier. |
| **The SLA escalation sweep runs** | 95% of half-hours, 30 days | The sweep is due at :15 and :45 from 07:15 to 18:45 Oman. Each half-hour is good when a sweep in it succeeded. If the sweep stops, overdue approvals stop being escalated. |
| **A backup every night** | 29 of every 30 days | A successful off-Neon database dump on each UTC day. Today is not judged until it is over. |
| **The ERP hand-off is current** | Nothing waiting over 7 days | The oldest customer waiting for the Temix upload, in the same queue the Temix page counts. |
| **No import is stuck** | Nothing stuck | No customer-master promote interrupted and waiting to be resumed, none stalled for more than an hour, and no upload in the last day still being read after 10 minutes. An interrupted promote, one whose run failed or which was refused because another promote was running, counts at once: it is exactly what the Data Steward's Work items list shows, and nothing records how long it has waited. A promote that simply went quiet counts after an hour. An upload whose request died stops counting a day after it started, because the app has no way to clear it. |

An objective shows **Met**, **At risk** (still on target, but less than a quarter of
its error budget is left), **Missed**, or **Not measured yet**.

**The error budget** is how much can go wrong in the 30-day window before the
target is missed. At 99.5%, that is 27 of the 5,400 slots. For backups it is one
night. When the budget runs out, reliability work comes before new features until
the window recovers.

**The first 30 days** are judged against the whole window's budget, not a budget
shrunk to the days measured so far. One missed backup in the first week is "At
risk", because 30 days allow one. It is not "Missed" for the rest of the month.
Approvals have no fixed count, so they are judged on the decisions actually made.

## Where the numbers come from

- **Scheduled runs:** the `CronRun` table, one row per run of every scheduled job,
  kept for 90 days.
- **Approvals:** each approval decision records the stage it decided: when that
  stage started, when it was due, and the working minutes it took (`EditApproval`).
- **Open queues:** the approvals, the Temix queue and the import batches as they
  stand right now.

**It started on 2026-09-27.** Scheduled runs and approval steps from before that
date carry none of this. Each window therefore starts at its first measurement,
and the card says "measuring since …" until the window is full. Approval steps
decided earlier are listed as not counted; they are never guessed. Reactivations
are the exception: their change request has kept its due time and its decision
time since July 2026, so they are counted from those records, and "measuring
since" gives the earliest decision counted.

## What this does not measure

- **Sign-in, page speed on a phone, photo uploads.** The availability probe proves
  that the app and its database answered. It does not open a page. Latency shown
  on the page is the probe's warm database round trip, not what a user waits for.
- **Errors a user saw.** Those are in Vercel → Logs, kept 30 days with Observability
  Plus: paste the Reference from the error screen into the search. If the
  Reference contains `@`, search the part before it. They are also in Sentry,
  tagged `digest:<that part>`.
- **Anything outside 07:00–19:00 Oman.** Nobody probes the app then.
- **Public holidays.** The working calendar has none, so a holiday counts as a
  working day and makes the approvals figure look worse that week.

## Who sees it

The Data Steward and the Managers. The page names no customer and shows no error
text. It reports company-wide counts and durations, which is why a Manager scoped
to one region may see it.

Per-step figures are the exception, because some steps have a single holder. The
General Manager step and the Finance Manager step each have one, so their on-time
share, their median and their open queue are that one colleague's own record. A
Manager is shown a step's figures only when at least three people decide it. Smaller
steps are shown to a Manager folded into "other steps", and only if at least three
people stand behind that line together; otherwise it is left out, and the
company-wide figure still counts them. The Data Steward sees every step.

The error text of a failed job stays behind the monitor bearer on `/api/health`
(OPERATIONS.md §5d).
