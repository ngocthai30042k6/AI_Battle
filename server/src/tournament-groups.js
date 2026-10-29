import { distributeTournamentGroups, iterateDoubleRoundRobinFixtures } from './tournament-format.js';

// The caller owns the transaction. The tournament lock also serializes signup
// and duplicate organize requests, so publishing groups is all-or-nothing.
export async function organizeTournamentGroups(client, tournamentId, groupCount) {
  const tournament = (await client.query(
    'SELECT id,status,format,group_count FROM tournaments WHERE id=$1 FOR UPDATE', [tournamentId]
  )).rows[0];
  if (tournament?.format === 'group_knockout' && tournament.status === 'group_stage' && tournament.group_count === groupCount) {
    const count = await client.query("SELECT count(*)::int AS count FROM tournament_fixtures WHERE tournament_id=$1 AND phase='group'", [tournamentId]);
    return { groupCount, fixtureCount: count.rows[0].count };
  }
  if (!tournament || tournament.format !== 'group_knockout' || !['registration', 'grouping'].includes(tournament.status)) {
    throw Object.assign(new Error('Giải không ở trạng thái mở đăng ký hoặc chờ chia bảng.'), { status: 409 });
  }
  const entries = await client.query(`SELECT player_id,registered_at FROM tournament_entries
    WHERE tournament_id=$1 AND player_id IS NOT NULL ORDER BY registered_at,player_id FOR UPDATE`, [tournamentId]);
  let groups;
  try { groups = distributeTournamentGroups(entries.rows, groupCount); }
  catch (error) { throw Object.assign(error, { status: 400 }); }
  const assignments = groups.flatMap(group => group.entrants.map(entry => [entry.player_id, group.number]));
  await client.query(`UPDATE tournament_entries e SET group_number=a.group_number
    FROM unnest($2::uuid[],$3::int[]) AS a(player_id,group_number)
    WHERE e.tournament_id=$1 AND e.player_id=a.player_id`,
  [tournamentId, assignments.map(a => a[0]), assignments.map(a => a[1])]);
  let batch = [], fixtureCount = 0;
  const flush = async () => {
    await client.query(`INSERT INTO tournament_fixtures
      (tournament_id,phase,group_number,round_number,match_number,leg,player1_id,player2_id,status)
      SELECT $1,'group',v.g,v.r,v.m,v.l,v.p1::uuid,v.p2::uuid,'pending'
      FROM jsonb_to_recordset($2::jsonb) AS v(g int,r int,m int,l int,p1 text,p2 text)`,
    [tournamentId, JSON.stringify(batch)]);
    batch = [];
  };
  for (const fixture of iterateDoubleRoundRobinFixtures(groups)) {
    batch.push({ g: fixture.groupNumber, r: fixture.roundNumber, m: ++fixtureCount,
      l: fixture.leg, p1: fixture.player1Id, p2: fixture.player2Id });
    if (batch.length === 10000) await flush();
  }
  if (batch.length) await flush();
  await client.query("UPDATE tournaments SET status='group_stage',group_count=$2,registration_closes_at=now() WHERE id=$1", [tournamentId, groupCount]);
  return { groupCount, fixtureCount };
}

// Return one row per entrant, rather than materializing the entire round-robin
// schedule in Node and sending it to every visitor on each refresh.
export async function getTournamentGroupEntries(client, tournamentId) {
  return (await client.query(`WITH completed AS MATERIALIZED (
      SELECT player1_id,player2_id,winner_id,COALESCE(move_count,0) AS moves
      FROM tournament_fixtures WHERE tournament_id=$1 AND phase='group' AND status='completed'
    ), sides AS (
      SELECT player1_id AS player_id,winner_id,moves FROM completed
      UNION ALL SELECT player2_id,winner_id,moves FROM completed
    ), scores AS (
      SELECT player_id,count(*)::int AS played,
        count(*) FILTER (WHERE winner_id=player_id)::int AS wins,
        count(*) FILTER (WHERE winner_id IS NULL)::int AS draws,
        count(*) FILTER (WHERE winner_id IS NOT NULL AND winner_id<>player_id)::int AS losses,
        sum(CASE WHEN winner_id=player_id THEN -moves WHEN winner_id IS NOT NULL THEN moves ELSE 0 END)::int AS difference
      FROM sides GROUP BY player_id
    ) SELECT e.player_id,e.group_number,e.registered_at,u.display_name,u.elo,u.avatar_id,u.avatar_url,
      COALESCE(s.played,0) AS "matchesPlayed",COALESCE(s.played,0) AS matches_played,
      COALESCE(s.wins,0) AS wins,COALESCE(s.draws,0) AS draws,COALESCE(s.losses,0) AS losses,
      COALESCE(s.wins*3+s.draws,0) AS points,COALESCE(s.difference,0) AS "moveDifference"
    FROM tournament_entries e JOIN users u ON u.id=e.player_id LEFT JOIN scores s ON s.player_id=e.player_id
    WHERE e.tournament_id=$1 AND e.group_number IS NOT NULL
    ORDER BY e.group_number,points DESC,"moveDifference" DESC,e.registered_at,e.player_id`, [tournamentId])).rows;
}

export async function getTournamentFixturePreview(client, tournamentId) {
  return (await client.query(`WITH visible_fixtures AS (
      (SELECT * FROM tournament_fixtures WHERE tournament_id=$1 AND phase='group' ORDER BY match_number LIMIT 100)
      UNION ALL (SELECT * FROM tournament_fixtures WHERE tournament_id=$1 AND phase='knockout')
    ) SELECT fixture.*,p1.display_name AS player1,p2.display_name AS player2,winner.display_name AS winner
    FROM visible_fixtures fixture JOIN users p1 ON p1.id=fixture.player1_id
    JOIN users p2 ON p2.id=fixture.player2_id LEFT JOIN users winner ON winner.id=fixture.winner_id
    ORDER BY fixture.phase,fixture.group_number NULLS LAST,fixture.round_number,fixture.match_number,fixture.leg`, [tournamentId])).rows;
}
