export async function persistMatchRelay(pool, match, senderSeat, p, createInitialConsensusState) {
  let ackReceipt = null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query(
      'SELECT match_type,status,consensus_state FROM matches WHERE id=$1 FOR UPDATE',
      [match.id]
    );
    const lockedMatch = locked.rows[0];
    if (lockedMatch?.status === 'active') {
      const cs = lockedMatch.consensus_state || createInitialConsensusState(lockedMatch.match_type);
      const now = Date.now();
      cs.lastActivityAt = now;
      if (p.type === 'BOT_READY' || (p.type === 'CONSENSUS_HELLO' && p.autoStart)) {
        if (senderSeat === 1 && !cs.p1ReadyAt) cs.p1ReadyAt = now;
        if (senderSeat === 2 && !cs.p2ReadyAt) cs.p2ReadyAt = now;
        if (cs.p1ReadyAt && cs.p2ReadyAt && !cs.bothReadyAt) {
          cs.bothReadyAt = now;
          cs.stepStartedAt = now;
        }
      } else if (p.type === 'CONSENSUS_REVEAL' && p.attestation?.payload) {
        cs.lastRevealStep = p.attestation.payload.stepCount;
        cs.lastRevealSeat = senderSeat;
        cs.lastRevealAt = now;
        cs.lastRevealCommit = p.attestation.payload.commit;
      } else if (p.type === 'CONSENSUS_ACK' && p.attestation?.payload) {
        const ackPayload = p.attestation.payload;
        const ackStep = Number(ackPayload.stepCount);
        const currentStep = Number(cs.currentStep || 0);
        if (
          Number.isSafeInteger(ackStep) &&
          ackStep >= 1 &&
          ackStep <= currentStep + 1 &&
          ackPayload.matchId === match.id &&
          typeof ackPayload.moveCommit === 'string' &&
          typeof ackPayload.stateHash === 'string'
        ) {
          ackReceipt = {
            matchId: match.id,
            stepCount: ackStep,
            stateHash: ackPayload.stateHash,
          };
        }
        if (ackStep === currentStep + 1 && ackReceipt) {
          cs.acksForPendingStep = cs.acksForPendingStep || {};
          cs.acksForPendingStep[senderSeat] = ackPayload.stateHash;
          if (
            cs.acksForPendingStep[1] &&
            cs.acksForPendingStep[2] &&
            cs.acksForPendingStep[1] === cs.acksForPendingStep[2]
          ) {
            cs.currentStep = ackStep;
            cs.acksForPendingStep = {};
            cs.lastRevealStep = null;
            cs.stepStartedAt = now;
          }
        }
      } else if (p.type === 'FINAL_PROOF' && p.proof) {
        cs.finalProofs = cs.finalProofs || {};
        cs.finalProofAt = cs.finalProofAt || {};
        cs.finalProofs[senderSeat] = { proof: p.proof, signature: p.signature };
        cs.finalProofAt[senderSeat] = now;
      }
      await client.query('UPDATE matches SET consensus_state=$1::jsonb WHERE id=$2', [JSON.stringify(cs), match.id]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return ackReceipt;
}
