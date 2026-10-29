export async function registerMatchSessionKey(pool, userId, packet, deliver) {
  const key = packet.publicKey;
  if (!packet.matchId || key?.kty !== 'EC' || key.crv !== 'P-256' || typeof key.x !== 'string' || typeof key.y !== 'string') {
    throw new Error('Only ECDSA P-256 session keys are accepted');
  }
  const found = (await pool.query("SELECT player1_id,player2_id FROM matches WHERE id=$1 AND status IN ('active','pending')", [packet.matchId])).rows[0];
  if (!found || ![found.player1_id,found.player2_id].includes(userId)) throw new Error('Player is not part of this active match');
  const column = userId === found.player1_id ? 'player1_key' : 'player2_key';
  // UPDATE serializes concurrent registrations and returns the peer key from the
  // current row, including when that peer registered before this client mounted.
  const match = (await pool.query(`UPDATE matches SET ${column}=$1::jsonb
    WHERE id=$2 AND status IN ('active','pending') AND (${column} IS NULL OR ${column}=$1::jsonb)
    RETURNING player1_id,player2_id,player1_key,player2_key`, [JSON.stringify(key),packet.matchId])).rows[0];
  if (!match) throw new Error('Match ended or this session key has already been locked');
  const otherId = userId === match.player1_id ? match.player2_id : match.player1_id;
  const otherKey = userId === match.player1_id ? match.player2_key : match.player1_key;
  await deliver(otherId,'peer-session-key',{ matchId:packet.matchId,playerId:userId,publicKey:key });
  if (otherKey) await deliver(userId,'peer-session-key',{ matchId:packet.matchId,playerId:otherId,publicKey:otherKey });
}
