# B3 fix (review of b587754): count the rows the DUMP actually contains.
#
# Two bugs are fixed by this one pass.
#
# 1. The row-count manifest used to come from a `psql` session taken BEFORE
#    pg_dump opened its own snapshot. Any write to production in that window
#    made the restore verifier's exact comparison fail on a byte-perfect
#    restore — the dump window (02:00–06:00 UTC) overlaps the start of the
#    Oman working day, so that is an ordinary occurrence, not a corner case.
#    Counting from the dump removes the race entirely: what the dump contains
#    is exactly what a correct restore must reproduce.
#
# 2. The table-presence check used `gunzip -c file | grep -q PATTERN`. Under
#    `set -o pipefail`, `grep -q` exits on the first match, gunzip dies of
#    SIGPIPE with 141, and the pipeline reports failure on a GOOD dump — which
#    aborted the job before the upload, every night. Nothing here exits early:
#    awk consumes the whole stream, so the writer always finishes.
#
# Reads a plain-format pg_dump on stdin, writes `<table>\t<rows>` per table.
# Portable across gawk and mawk: no 3-argument match(), no gensub().
#
#   gunzip -c dump.sql.gz | awk -f scripts/ops/dump-rowcounts.awk

# Anchored on the full header form, so a data row that merely begins with the
# text "COPY public." cannot be mistaken for one, and a quoted identifier
# containing a space is read whole rather than truncated at the space.
/^COPY public\.("[^"]+"|[A-Za-z_][A-Za-z0-9_$]*) .*FROM stdin;$/ {
  line = $0
  sub(/^COPY public\./, "", line)        # "Customer" (id, ...) FROM stdin;
  if (substr(line, 1, 1) == "\"") {
    end = index(substr(line, 2), "\"")    # up to the closing quote
    table = substr(line, 2, end - 1)
  } else {
    sub(/ .*/, "", line)
    table = line
  }
  rows = 0
  in_copy = 1
  next
}

in_copy && $0 == "\\." {            # end-of-data marker
  print table "\t" rows
  in_copy = 0
  next
}

in_copy { rows++ }

# pg_dump's own terminal line — proof the stream was not truncated.
/^-- PostgreSQL database dump complete/ { complete = 1 }

END {
  if (in_copy) {
    print "ERROR unterminated COPY block for " table > "/dev/stderr"
    exit 2
  }
  if (!complete) {
    print "ERROR dump has no completion marker — it was truncated" > "/dev/stderr"
    exit 3
  }
}
