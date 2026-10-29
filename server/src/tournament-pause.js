// Caller owns the transaction. The same tournament row lock serializes this
// change with claiming/completing a game, so an in-flight game can finish.
export async function setTournamentPaused(client, tournamentId, paused) {
  const tournament = (await client.query('SELECT * FROM tournaments WHERE id=$1 FOR UPDATE', [tournamentId])).rows[0];
  if (!tournament) throw Object.assign(new Error('Không tìm thấy giải đấu.'), { status: 404 });
  if (tournament.format !== 'group_knockout' || tournament.execution_mode !== 'server' ||
      !['group_running', 'knockout'].includes(tournament.status) ||
      (tournament.status === 'knockout' && !tournament.knockout_started_at)) {
    throw Object.assign(new Error('Chỉ có thể tạm dừng hoặc tiếp tục vòng đấu đã khởi chạy.'), { status: 409 });
  }
  if (Boolean(tournament.execution_paused_at) === paused) return tournament;
  return (await client.query(`UPDATE tournaments SET
    ends_at=CASE WHEN NOT $2 AND execution_paused_at IS NOT NULL
      THEN ends_at+(now()-execution_paused_at) ELSE ends_at END,
    execution_paused_at=CASE WHEN $2 THEN now() ELSE NULL END
    WHERE id=$1 RETURNING *`, [tournamentId, paused])).rows[0];
}
