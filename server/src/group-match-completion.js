import { createHash } from 'node:crypto';

// Caller owns the transaction and the tournament row lock. All writes are
// dependent on a newly inserted result, making retries unable to double-score.
export async function completeServerGroupMatch(client, match, result) {
  const replay = JSON.stringify(result.replay);
  const winner = result.winner === 1 ? match.player1_id : result.winner === 2 ? match.player2_id : null;
  const score = result.winner === 1 ? 1 : result.winner === 2 ? 0 : 0.5;
  const written = await client.query(`WITH ready AS MATERIALIZED (
      SELECT id FROM tournament_fixtures WHERE id=$1 AND tournament_id=$2
        AND phase='group' AND status='active' AND match_id=$3 FOR UPDATE
    ), players AS MATERIALIZED (
      SELECT id,elo FROM users WHERE id=ANY($4::uuid[]) ORDER BY id FOR UPDATE
    ), entries AS MATERIALIZED (
      SELECT player_id FROM tournament_entries WHERE tournament_id=$2 AND player_id=ANY($4::uuid[])
      ORDER BY player_id FOR UPDATE
    ), scored AS (
      INSERT INTO match_results(match_id,player1_elo_before,player2_elo_before,player1_elo_after,player2_elo_after,result_player1)
      SELECT $3,a.elo,b.elo,a.elo,b.elo,$5 FROM players a,players b
      WHERE a.id=($4::uuid[])[1] AND b.id=($4::uuid[])[2] AND (SELECT count(*) FROM entries)=2 AND EXISTS(SELECT 1 FROM ready)
      ON CONFLICT(match_id) DO NOTHING RETURNING match_id
    ), updated_entries AS (
      UPDATE tournament_entries e SET matches_played=e.matches_played+1,
        wins=e.wins+CASE WHEN e.player_id=$6 THEN 1 ELSE 0 END,
        draws=e.draws+CASE WHEN $6::uuid IS NULL THEN 1 ELSE 0 END,
        losses=e.losses+CASE WHEN $6::uuid IS NOT NULL AND e.player_id<>$6 THEN 1 ELSE 0 END,
        points=e.points+CASE WHEN e.player_id=$6 THEN 3 WHEN $6::uuid IS NULL THEN 1 ELSE 0 END
      WHERE e.tournament_id=$2 AND e.player_id IN (SELECT player_id FROM entries)
        AND EXISTS(SELECT 1 FROM scored) RETURNING e.player_id
    ), finished_fixture AS (
      UPDATE tournament_fixtures SET status='completed',winner_id=$6,move_count=$7
      WHERE id=$1 AND EXISTS(SELECT 1 FROM scored) RETURNING id
    ), finished_match AS (
      UPDATE matches SET status='completed',winner_id=$6,final_step_count=$7,final_state_hash=$8,
        replay_json=$9::jsonb,replay_sha256=$10,completed_at=clock_timestamp()
      WHERE id=$3 AND EXISTS(SELECT 1 FROM finished_fixture) RETURNING id
    ), finished_stage AS (
      UPDATE tournaments SET status='group_complete' WHERE id=$2 AND status='group_running'
        AND EXISTS(SELECT 1 FROM finished_fixture)
        AND NOT EXISTS(SELECT 1 FROM tournament_fixtures WHERE tournament_id=$2 AND phase='group'
          AND status<>'completed' AND id<>$1) RETURNING id
    ) SELECT (SELECT count(*)::int FROM updated_entries) AS entries,
      (SELECT count(*)::int FROM finished_match) AS matches`,
  [match.tournament_fixture_id,match.tournament_id,match.id,[match.player1_id,match.player2_id],
    score,winner,result.moveCount,result.finalHash,replay,createHash('sha256').update(replay).digest('hex')]);
  if (written.rows[0]?.entries !== 2 || written.rows[0]?.matches !== 1) {
    throw new Error('Group result was already recorded or its fixture/players are unavailable');
  }
}
