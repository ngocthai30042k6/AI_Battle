# OTTv2 backend (Phase 4)

## Server-run group stage

After publishing groups, the organizer presses **Khởi chạy vòng bảng**. Every entrant must
have a saved Python bot. The server snapshots that code and runs the scheduled double
round robin: each pair plays twice, with `player1` (the first mover) swapped in the return leg.
Players can close their browsers. Results, Elo, group points and replays are stored in
PostgreSQL; the group stage becomes complete after the last fixture finishes.

Python runs in a Runno WebAssembly/WASI virtual filesystem without host filesystem or
network access. Bot initialization has a 15-second limit and each move has a 2-second
limit. Invalid moves, Python errors and move timeouts forfeit the game; if both bots fail
to load, the game is drawn. A 1,000-ply or 60-second match ceiling results in a draw.
Only one match runs at a time to fit the small hosting instance. Code changes after
launch do not affect that tournament. A database session lock prevents duplicate runs;
an interrupted fixture is replayed from the beginning after a restart, without applying
partial results. Points are ordered descending, then move differential descending.

This requires Node 22+ and installed dependencies in `server/`. Free hosting can suspend
the process while idle; queued work resumes when the service is awake. Continuous
unattended tournaments require an always-on host. Knock-out browser play is unchanged.

This service adds account authentication, Redis Elo matchmaking, WebSocket signaling relay, PostgreSQL match ledger, signed result verification, Elo updates, and replay storage. The clients still send game traffic directly over a WebRTC DataChannel after signaling completes.

## Start with Docker Compose

From this directory:

1. Copy `.env.example` to `.env`.
2. Replace `JWT_SECRET` with a random secret of at least 32 characters and change the database password.
3. Run `docker compose --env-file .env up --build`.
4. Serve the project root over HTTP on port 8000, then open `http://localhost:8000/` (or `http://localhost:8000/#tournaments`) in two browsers. From the project root, run `python3 -m http.server 8000`. If your terminal is in this `server/` directory, run `python3 -m http.server 8000 --directory ..` instead. Do not add `/AI_battle_platform/` to the URL: the HTTP server maps URLs relative to its serving directory. In the lobby, register two accounts and use **Tìm trận**.

The migration runs automatically at backend startup. For browser development, set `PUBLIC_ORIGIN` to the exact origin serving `index.html`. The lobby defaults to `http://localhost:8787`; for a remote deployment, set the backend's public base URL in **Cài đặt & tài khoản → Kết nối backend**. The URL is saved only in that browser.

## Routes

- `POST /api/auth/register` and `POST /api/auth/login`
- `GET /api/me`
- `GET /api/matches` and `GET /api/matches/:id/replay`
- `POST /api/match/submit-result`
- WebSocket `/ws`: authenticate first, then use `find-match` for human matches or `find-bot-match` for bot-versus-bot matches, plus `cancel-match`, `session-key`, and `signal` messages.

Bot matches use a separate Elo matchmaking queue. Each selected Python bot runs in a browser Web Worker using Pyodide; only validated game moves are exchanged over the match DataChannel. The browser downloads the Python runtime from jsDelivr on first use, so the first bot start needs internet access. Signed replay verification applies to both match types, but account Elo changes only for bot-versus-bot games (including tournament bot games); human-versus-human results are recorded with no Elo change.

## Tournament beta

Tournament creation stores a `format` key. `ranked_weekly` is currently the only supported format: the UI shows future formats as unavailable, and the API rejects unknown or unsupported keys. Add a format only after its matchmaking, lifecycle, scoring, and standings behavior is implemented server-side.

Tournament registration and matchmaking operate on individual player accounts. Press **Tham gia** to register; a saved Python bot is not required. During registration, participants can play practice matches using a built-in sample bot or a saved bot. Practice matches update account Elo but do not change tournament rank, stars, or season points. When registration closes (or the player limit is reached), account Elo determines the starting rank: Bronze below 1350, Silver from 1350 through 1599, or Gold from 1600 upward. Starting rank is capped at Gold.

After registration closes, participants can select a bot and find Bot-versus-Bot ranked matches. Account Elo no longer changes tournament rank; rank progress comes from verified results. A win adds one star, a draw changes nothing, and a loss removes one point on the cumulative rank ladder. Crossing below a rank's zero-star threshold demotes the player to the previous rank; Bronze cannot demote further. Promotion thresholds are 10 stars from Bronze, 20 from Silver, 30 from Gold, and 40 from Master. Matchmaking pairs players in the same rank and Sprint where possible.

Each Sprint lasts seven days. Board rules rotate through the standard board, central blockers, clipped corners, and corridor obstacles, repeating after four layouts. Future Sprint rules remain private until that Sprint begins. The selected rules are stored on each match and used by the bot, client consensus, and server-verified replay. The board remains a 9×9 grid; blocked cells are unavailable to pieces and shown as obstacles.

At Challenger, stars continue to increase or decrease on wins and losses. Wins add one season point; losses subtract one point down to zero; draws do not change points. Dropping from Challenger resets season points, and promotion back starts at zero. Before publication, players can see only their own progress and match results. The previous Sprint's temporary standings are shown during the first 24 hours of the next Sprint: Challenger players are ordered by season points, while other ranks show final rank and stars. Final standings become public when the tournament ends.

The result service accepts a tournament result only if it is verified and submitted before its registration (for practice), Sprint (for ranked), or tournament deadline. Incomplete or late matches are abandoned and do not change tournament progress. The detail API filters match history to the authenticated participant; public standings are returned only during the specified reveal window or after completion.

New accounts are regular users. There is no in-app way to grant admin access.

For the local JSON development server on Windows, grant or revoke access from the project directory with `npm.cmd run admin:local -- grant organizer@example.com` or `npm.cmd run admin:local -- revoke organizer@example.com`. This updates `data/local-db.json` (or the file selected by `OTTV2_DB_PATH`); restart the dev server afterward.

For PostgreSQL, first register the organizer account, then run `docker compose exec postgres psql -U ott -d ottv2 -c "UPDATE users SET is_admin=TRUE WHERE email='organizer@example.com';"` from the `server` directory, replacing the example email. To revoke access, use the same command with `is_admin=FALSE`. Only organizers can create tournaments or manually open their qualifying stage. Tournament dates transition registration and qualifying status automatically when the API is accessed.

The queue uses an Elo range beginning at ±100 and expands in timed intervals up to the configured maximum. PostgreSQL owns the authoritative account rating and result ledger. Result submission locks the match and both rating rows in one transaction, verifies both account-bound P-256 signatures, replays every committed move through `shared/OTTGameEngine.js`, compares the final state, then applies the configured FIDE-style K-factor calculation. Repeated submissions for a completed match are idempotent.

Replay JSON is stored in PostgreSQL by default. When S3-compatible credentials are configured, it is uploaded to the configured bucket and the API returns a short-lived signed download URL to an authorized player.

During normal play, clients exchange signed commit, reveal, and state-acknowledgement messages directly; the server does not receive every move. If the clients detect a state-hash disagreement, either can submit the signed transcript to the consensus-dispute endpoint. The server replays the transcript and verifies each signature against the match's registered session keys. If exactly one signed acknowledgement conflicts with the deterministic replay, its signer forfeits and the result is applied transactionally. If the evidence does not identify one responsible player, the match is marked disputed and no Elo or tournament progress is awarded. Dispute evidence is retained in PostgreSQL for audit.

## Important deployment settings

- Use HTTPS/WSS for public deployment and configure `PUBLIC_ORIGIN` to the exact frontend origin.
- Put PostgreSQL, Redis, and the backend behind private network rules; expose only the HTTPS/WebSocket reverse proxy.
- Provide a TURN service for restrictive NATs. The current browser client uses a public STUN server as a development default.
- `FIDE_K_FACTOR` defaults to 20. The account model currently does not collect age or FIDE game-count data, so FIDE's special K-factor eligibility rules are not inferred.
- A backend match is forfeited if the server observes one player's connection missing for 10 seconds while the opponent remains connected. If both players are offline after the grace period, the match is abandoned without a winner, Elo, or tournament progress. A reconnect during the grace period cancels the disconnect timer. Client-submitted disconnect claims remain subject to review and cannot award Elo by themselves. This lifecycle is shared by human-versus-human and Bot-versus-Bot matches.
