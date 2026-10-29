export async function updateGroupEntryScore(client, match, score1) {
  const entries = await client.query('SELECT player_id FROM tournament_entries WHERE tournament_id=$1 AND player_id=ANY($2::uuid[]) ORDER BY player_id FOR UPDATE',
    [match.tournament_id,[match.player1_id,match.player2_id]]);
  if (entries.rowCount !== 2) throw Object.assign(new Error('Tournament entry missing for this fixture'), { status: 409 });
  for (const [id, score] of [[match.player1_id,score1],[match.player2_id,1-score1]]) {
    await client.query(`UPDATE tournament_entries SET matches_played=matches_played+1,
      wins=wins+CASE WHEN $3::numeric=1 THEN 1 ELSE 0 END,
      draws=draws+CASE WHEN $3::numeric=0.5 THEN 1 ELSE 0 END,
      losses=losses+CASE WHEN $3::numeric=0 THEN 1 ELSE 0 END,
      points=points+CASE WHEN $3::numeric=1 THEN 3 WHEN $3::numeric=0.5 THEN 1 ELSE 0 END
      WHERE tournament_id=$1 AND player_id=$2`, [match.tournament_id,id,score]);
  }
}
