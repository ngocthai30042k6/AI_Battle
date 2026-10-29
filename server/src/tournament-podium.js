const publicFinalist = user => user ? ({ id:user.id, display_name:user.display_name,
  avatar_id:user.avatar_id, avatar_url:user.avatar_url || null }) : null;

export function localTournamentPodium(fixtures, users) {
  const knockout = fixtures.filter(f => f.phase === 'knockout');
  const lastRound = Math.max(0, ...knockout.map(f => Number(f.round_number)));
  const finals = knockout.filter(f => Number(f.round_number) === lastRound);
  const final = finals[0];
  if (finals.length !== 1 || final.status !== 'completed' || !final.winner_id ||
      ![final.player1_id,final.player2_id].includes(final.winner_id)) return {};
  const runnerId = final.winner_id === final.player1_id ? final.player2_id : final.player1_id;
  return { champion:publicFinalist(users.find(u=>u.id===final.winner_id)),
    runner_up:publicFinalist(users.find(u=>u.id===runnerId)) };
}

// Fetch all completed tournament podiums together; never infer the champion
// from Elo, group rank, or an individual game inside the final BO3 series.
export async function getTournamentPodiums(pool, tournamentIds) {
  if (!tournamentIds.length) return new Map();
  const { rows } = await pool.query(`WITH rounds AS (
    SELECT f.tournament_id,f.round_number,f.match_number,f.status,f.player1_id,f.player2_id,f.winner_id,
      count(*) OVER(PARTITION BY f.tournament_id,f.round_number) AS round_size,
      row_number() OVER(PARTITION BY f.tournament_id ORDER BY f.round_number DESC,f.match_number) AS position
    FROM tournament_fixtures f JOIN tournaments t ON t.id=f.tournament_id
    WHERE f.tournament_id=ANY($1::uuid[]) AND f.phase='knockout' AND t.status='completed'
  ) SELECT f.tournament_id,
    json_build_object('id',w.id,'display_name',w.display_name,'avatar_id',w.avatar_id,'avatar_url',w.avatar_url) AS champion,
    json_build_object('id',r.id,'display_name',r.display_name,'avatar_id',r.avatar_id,'avatar_url',r.avatar_url) AS runner_up
    FROM rounds f JOIN users w ON w.id=f.winner_id
    JOIN users r ON r.id=CASE WHEN f.winner_id=f.player1_id THEN f.player2_id ELSE f.player1_id END
    WHERE f.position=1 AND f.round_size=1 AND f.status='completed'
      AND f.winner_id IN (f.player1_id,f.player2_id)`, [tournamentIds]);
  return new Map(rows.map(({tournament_id,...podium})=>[tournament_id,podium]));
}
