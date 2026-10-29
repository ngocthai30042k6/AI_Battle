# Tournament throughput and replay capacity

Measured on 2026-10-29. These are small local samples and storage estimates,
not a latency guarantee on the production Render service.

## Current optimizations and measurement

Each game uses two fresh, isolated Python WASI instances. Both bots load in
parallel and reuse the compiled WebAssembly module. A running tournament drains
the next fixture immediately after committing a result; its one-second timer is
only needed while idle or recovering from errors. Games still execute serially.

Run `npm run benchmark:server -- 8`. This uses two bots that choose the first
legal move, the same eight seeds and complete games, including replay generation.
It excludes database requests, queue waiting, uploads and production contention.

| Measurement | Before | After |
| --- | ---: | ---: |
| Mean of seven warm local games | 429 ms | 230 ms |
| First game including runtime compilation | 834 ms | 664 ms |
| Warm sample range | 339–586 ms | 189–356 ms |

Sample games lasted 11–67 plies. Heavier bot algorithms and longer games can take
substantially longer. Per-bot time limits and game rules are unchanged.

The live runner also issues multiple PostgreSQL requests while claiming a job,
updating Elo/standings and committing a replay. Its end-to-end latency must be
measured separately on the deployed worker. A local probe of the remote database
measured roughly 190–197 ms per round trip; that is **not** the Render-to-database
latency. Place workers near the database and batch transactional operations before
promising subsecond persisted results.

At 0.2–0.5 seconds per game, 70,000 serial games require 3h53m–9h43m of execution
alone. A large event needs dedicated always-on workers, bounded concurrency and
durable job claims. The current global advisory lock intentionally allows only
one active fixture across runner instances. Supporting multiple match workers
requires replacing it with per-job leases/claims, recovery and appropriate player
or result-order coordination; simply increasing replica count will not help.

## Replay storage estimates

A read-only sample of the latest 100 stored production replays averaged 10,385
bytes of JSON and 4,389 bytes after gzip. Size varies with game length, proofs and
bot output. Gzip estimates below describe a proposed archive format; the current
offline runner still stores JSONB replays in PostgreSQL.

| Volume | JSON payload only | Gzip payload only |
| --- | ---: | ---: |
| 70,000 games | 727 MB | 307 MB |
| 250 games visible to one user | 2.6 MB | 1.1 MB |

These totals exclude row/index overhead, fixtures, bot-code snapshots, backups
and provider billing units. In particular, copying both bot source files into
every match can occupy more space than the moves themselves.

Recommended design for a large event:

1. PostgreSQL keeps searchable match metadata: both player IDs, tournament,
   phase/round, score, first player, seed, locked bot versions/hashes, timings,
   fault reason, replay object key and SHA-256.
2. Keep immutable bot code once per content hash/version instead of duplicating
   source in every match. Preserve references needed to reproduce old games.
3. Store one complete compressed replay per game in a private S3-compatible bucket,
   for example `replays/<tournament-id>/<match-id>.json.gz`. Both users refer to the
   same object. Store initial state/rules and every executed move so replay does
   not depend on rerunning nondeterministic bots.
4. Use a durable outbox and retry uploads outside the match-completion transaction.
   Retain the database payload until the archive has been verified. Downloads use
   participant/admin authorization and short-lived signed URLs.
5. Paginate history 25–50 matches at a time with an indexed `(created_at,id)` cursor;
   download only the selected replay. The current API returns the latest 50
   matches and the ranked view renders 10 of them; those are display limits,
   not deletion policies. Full 250-game browsing needs pagination work.
6. Include technical wins, timeouts and interrupted attempts in the audit trail.
   A match-result row alone is not a complete move log. Capture accepted moves or
   checkpoints for live matches before a disconnect/forfeit, too. The existing
   offline runner records moves and faults, but some historical live forfeits
   have no replay payload to recover.

As checked on the measurement date, Neon's current plan page lists 1 GB per project
(20 GB total per account) for Free Postgres storage, and R2
Standard includes 10 GB-month, 1 million Class A operations and 10 million Class B
operations in its monthly free tier. Other usage and repeated events must also be
budgeted. Neon Object Storage is another S3-style option within an existing Neon
account: its current Free allowance is 5 GB per project, subject to supported
regions. No new storage account/bucket or paid resources were created for this
change. The existing S3 adapter is used by the online replay path; wiring an
asynchronous archive for server tournaments is still future work.

Sources:

- [Neon plans](https://neon.com/docs/introduction/plans)
- [Neon Object Storage and supported regions](https://neon.com/docs/storage/overview)
- [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Render Free service limits](https://render.com/docs/free)

Render Free sleeps after 15 minutes without inbound HTTP/WebSocket traffic and
does not support multiple instances. It is not suitable for an unattended
70,000-game tournament with a throughput deadline.
