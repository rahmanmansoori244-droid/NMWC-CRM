# 08 — The knowledge graph of the repository

`graphify-out/` holds a knowledge graph of this repository, rebuilt on 2026-10-04
from `main` at `9d0fd61`. It answers "where does X live, and what is it connected
to?" faster than reading the tree, and it is the quickest way for a newcomer (or an
AI assistant) to find the right files before changing anything.

| File | What it is | Open it with |
|---|---|---|
| [`graphify-out/GRAPH_REPORT.md`](../../graphify-out/GRAPH_REPORT.md) | The summary: the 226 clusters ("communities") with plain-language names, the most connected nodes, surprising cross-links, and suggested questions | Any Markdown viewer |
| [`graphify-out/wiki/index.md`](../../graphify-out/wiki/index.md) | One article per cluster and per highly connected node (236 articles), linked to each other. **Start here** if you are reading, or if you point an AI assistant at the repo | Any Markdown viewer, Obsidian |
| `graphify-out/graph.html` | The interactive graph: search, zoom, click a node to see its neighbours | A web browser, online (it loads the vis-network library from unpkg.com) |
| `graphify-out/graph.json` | The graph itself (nodes, edges, communities) for tools | `graphify` CLI, scripts |
| `graphify-out/manifest.json`, `.graphify_labels.json` | What was scanned, and the cluster names | Used by `graphify --update` |

## What is in it — and what is not

- **4,602 nodes, 10,495 links, 226 clusters.**
- **Code** (`app/`, `components/`, `lib/`, `services/`, `scripts/`, `prisma/`,
  `tests/`, configuration): 478 of 492 code files produced structural nodes
  (imports, calls, definitions); the other 14 yielded none.
- **Documents** (`docs/`, `qa/`, `AUDITOR-BRIEF.md`, `AGENTS.md`, `CLAUDE.md`,
  `CHANGELOG.md`, workflows): all 120 were read for concepts, findings, decisions and
  their rationale, and linked to the code they describe. 94% of links are taken
  directly from the source; 6% are inferred (marked, with a confidence score).
- **Not included:** the 8 PDFs in `docs/guide/` (they duplicate the HTML guides
  next to them) and the 21 screenshots. The role guides in `docs/guide/` are
  stale (see [04-PENDING-WORK](04-PENDING-WORK.md)); the graph shows what they say,
  not what is true.
- **No private material.** The graph was built from a clean export of the tracked
  files only: no `.env`, no `golive-data/`, no customer data, no local paths. Node
  labels were checked for passwords, tokens and connection strings.

## Useful ways in

- **"Where is the approval engine?"** → `GRAPH_REPORT.md` → cluster *Edit submit and
  approval engine*, *Approval chains and detail page*, *Approval decision UI and bulk*.
- **"Why is it built this way?"** → the document clusters carry the rationale:
  *Phase 2 design notes*, *Phase 2 spec contract*, *Auditor brief*, *Standing rules
  (CLAUDE.md, AGENTS.md)*, *Enterprise readiness assessment*.
- **"What touches photos?"** → *Photo upload and R2*, *Photo attach routes*,
  *Photos and completeness scoring*, *Photo client upload tests*.
- **"What runs on a schedule?"** → *Cron heartbeats*, *Cron scheduler (cron-job.org)*,
  *Operations runbook*.

With the `graphify` command-line tool installed (Python; the graph was built with
version 0.8.44: `uv tool install graphifyy==0.8.44`):

```bash
graphify query "how does a salesman's edit reach the database" --graph graphify-out/graph.json
graphify explain "approveEditCore" --graph graphify-out/graph.json
graphify path "EnrichmentForm" "writeAudit" --graph graphify-out/graph.json
```

`explain` and `path` target exact node names and are the most reliable; `query` is
free-form and can drift into a neighbouring cluster.

## Keeping it current

The graph is a snapshot. After significant changes, rebuild it from a clean export of
the tracked files, so nothing private or machine-specific gets in, and without the
previous graph (otherwise the old report and wiki are read back in as documents). In
Git Bash, macOS or Linux, from the repository root:

```bash
rm -rf ../graph-src && mkdir -p ../graph-src
git archive HEAD -- . ':!graphify-out' | tar -x -C ../graph-src   # tracked files only
cd ../graph-src && graphify .                                      # full run
```

Then copy `GRAPH_REPORT.md`, `graph.json`, `graph.html`, `manifest.json`,
`.graphify_labels.json` and `wiki/` back into `graphify-out/`. Before committing, check
that none of them contains an absolute path from your machine (the tool records source
paths; rewrite them to repository-relative ones) or anything secret: this repository
is public.

Two practical notes from the 2026-10-04 build on Windows: the parallel code parser
crashed part-way (only 181 of 492 files) and was re-run sequentially; and the
document pass was done in 6 chunks of 20 files by separate AI sub-agents.
