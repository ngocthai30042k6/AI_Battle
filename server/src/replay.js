import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { OTTGameEngine } = require('../../shared/OTTGameEngine.js');

const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` :
  value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value);
const sha256 = value => createHash('sha256').update(canonical(value)).digest('hex');
export const hashCanonical = value => sha256(value);
export const hashReplayState = state => sha256(statePayload(state));

function isTerminalWinner(winner) {
  return winner === 0 || winner === 1 || winner === 2;
}

function webCryptoSignatureToDer(raw) {
  const bytes = Buffer.from(raw, 'hex');
  if (bytes.length !== 64) throw new Error('ECDSA P-256 signature must be 64 bytes');
  const integer = part => {
    let value = Buffer.from(part);
    while (value.length > 1 && value[0] === 0) value = value.subarray(1);
    if (value[0] & 0x80) value = Buffer.concat([Buffer.from([0]), value]);
    return Buffer.concat([Buffer.from([0x02, value.length]), value]);
  };
  const r = integer(bytes.subarray(0, 32));
  const s = integer(bytes.subarray(32));
  const body = Buffer.concat([r, s]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

export function verifySessionProof(jwk, proof, signature) {
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !proof || typeof signature !== 'string') return false;
  try {
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    return verifySignature('sha256', Buffer.from(canonical(proof)), key, webCryptoSignatureToDer(signature));
  } catch {
    return false;
  }
}

export function verifyReplay(replay, expectedSeed, expectedMatchId, expectedRules = null) {
  if (!replay || replay.format !== 'ottv2-replay-v1' || replay.matchId !== expectedMatchId || replay.seed !== expectedSeed || !Array.isArray(replay.moves)) {
    throw new Error('Replay metadata does not match the registered match');
  }
  let state = OTTGameEngine.deserialize(replay.initialState);
  if (state.seed !== expectedSeed || state.stepCount !== 0 || isTerminalWinner(state.winner)) {
    throw new Error('Replay initial state is invalid');
  }
  const generated = OTTGameEngine.createGame(expectedSeed, state.pieceCount, expectedRules);
  if (canonical(state.rules || null) !== canonical(generated.rules || null)) {
    throw new Error('Replay rules do not match the rules locked for this match');
  }
  const initialHash = sha256(statePayload(state));
  const generatedHash = sha256(statePayload(generated));
  if (initialHash !== generatedHash) throw new Error('Replay initial board does not match deterministic seed');
  for (let index = 0; index < replay.moves.length; index++) {
    const entry = replay.moves[index];
    if (!entry || entry.stepCount !== index + 1 || ![1, 2].includes(entry.player) || entry.player !== state.turn ||
        !entry.move || !Number.isInteger(entry.move.from) || !Number.isInteger(entry.move.to) || typeof entry.nonce !== 'string') {
      throw new Error(`Replay step ${index + 1} has invalid metadata`);
    }
    const expectedCommit = sha256({ matchId: expectedMatchId, stepCount: index, player: entry.player, move: entry.move, nonce: entry.nonce });
    if (expectedCommit !== entry.commit) throw new Error(`Replay step ${index + 1} commit hash is invalid`);
    state = OTTGameEngine.applyMove(state, { from: entry.move.from, to: entry.move.to });
    const stateHash = sha256(statePayload(state));
    if (stateHash !== entry.stateHash) throw new Error(`Replay state hash mismatch at step ${index + 1}`);
  }
  if (!isTerminalWinner(state.winner)) throw new Error('Replay has no completed terminal state');
  const finalHash = sha256(statePayload(state));
  return { state, finalHash, winner: state.winner, drawReason: state.drawReason || null, stepCount: state.stepCount };
}

export function verifyConsensusDispute(evidence, match) {
  if (!evidence || evidence.format !== 'ottv2-consensus-dispute-v1' ||
      !Array.isArray(evidence.moves) || evidence.moves.length > 2000 ||
      evidence.matchId !== match.id || evidence.seed !== match.seed) {
    throw new Error('Consensus dispute evidence is malformed');
  }
  const keyForSeat = seat => seat === 1 ? match.player1_key : seat === 2 ? match.player2_key : null;
  const verifyAttestation = (attestation, expectedPayload, seat) =>
    attestation && canonical(attestation.payload) === canonical(expectedPayload) &&
    verifySessionProof(keyForSeat(seat), attestation.payload, attestation.signature);
  const initial = OTTGameEngine.createGame(match.seed, 9, match.tournament_rules || null);
  const initialState = OTTGameEngine.deserialize(evidence.initialState);
  if (initialState.seed !== match.seed || initialState.pieceCount !== 9 ||
      initialState.stepCount !== 0 || isTerminalWinner(initialState.winner) ||
      canonical(statePayload(initialState)) !== canonical(statePayload(initial))) {
    throw new Error('Consensus dispute initial state does not match the registered match');
  }

  // Replay all mutually acknowledged prior steps
  let state = initialState;
  for (let index = 0; index < evidence.moves.length; index++) {
    const entry = evidence.moves[index];
    const stepCount = index;
    const player = state.turn;
    const commitPayload = {
      kind: 'move-commit', matchId: match.id, stepCount, player, hash: entry?.commit
    };
    const revealPayload = {
      kind: 'move-reveal', matchId: match.id, stepCount, player,
      move: entry?.move, nonce: entry?.nonce, commit: entry?.commit
    };
    if (!entry || entry.stepCount !== stepCount + 1 || entry.player !== player ||
        !entry.move || !Number.isInteger(entry.move.from) || !Number.isInteger(entry.move.to) ||
        canonical(Object.keys(entry.move).sort()) !== canonical(['from', 'to']) ||
        typeof entry.nonce !== 'string' ||
        sha256({ matchId: match.id, stepCount, player, move: entry.move, nonce: entry.nonce }) !== entry.commit ||
        !verifyAttestation(entry.commitAttestation, commitPayload, player) ||
        !verifyAttestation(entry.revealAttestation, revealPayload, player)) {
      throw new Error(`Consensus dispute has invalid move evidence at step ${stepCount + 1}`);
    }
    state = OTTGameEngine.applyMove(state, entry.move);
    const expectedHash = sha256(statePayload(state));
    const isFinalMoveBeforeProofDispute =
      evidence.faultType === 'final-proof-mismatch' &&
      index === evidence.moves.length - 1 &&
      isTerminalWinner(state.winner);
    const requiredAckCount = isFinalMoveBeforeProofDispute ? 1 : 2;
    if (entry.stateHash !== expectedHash || !Array.isArray(entry.acknowledgements) ||
        entry.acknowledgements.length < requiredAckCount || entry.acknowledgements.length > 2) {
      throw new Error(`Consensus dispute history is incomplete at step ${stepCount + 1}`);
    }
    const seatsToVerify = entry.acknowledgements.length === 2
      ? [1, 2]
      : [entry.acknowledgements[0]?.payload?.player].filter(s => s === 1 || s === 2);
    if (seatsToVerify.length < requiredAckCount) {
      throw new Error(`Consensus dispute history has invalid acknowledgement at step ${stepCount + 1}`);
    }
    for (const seat of seatsToVerify) {
      const attestation = entry.acknowledgements.find(item => item?.payload?.player === seat);
      const ackPayload = {
        kind: 'state-ack', matchId: match.id, stepCount: stepCount + 1,
        player: seat, moveCommit: entry.commit, stateHash: expectedHash
      };
      if (!verifyAttestation(attestation, ackPayload, seat)) {
        throw new Error(`Consensus dispute history has invalid acknowledgement at step ${stepCount + 1}`);
      }
    }
  }

  // Fault Mode A: Signed Final Proof mismatch after verified terminal state
  if (evidence.faultType === 'final-proof-mismatch' && evidence.disputedFinalProof) {
    if (!isTerminalWinner(state.winner)) {
      throw new Error('Cannot adjudicate final proof mismatch before terminal game state');
    }
    const expectedHash = sha256(statePayload(state));
    const fp = evidence.disputedFinalProof;
    const peerSeat = fp.seat;
    if (![1, 2].includes(peerSeat) || !fp.proof || typeof fp.signature !== 'string') {
      throw new Error('Malformed disputed final proof');
    }
    if (!verifySessionProof(keyForSeat(peerSeat), fp.proof, fp.signature)) {
      throw new Error('Disputed final proof does not carry a valid peer signature');
    }
    if (fp.proof.matchId !== match.id) {
      throw new Error('Disputed final proof belongs to a different match');
    }
    const matchesCanonical = fp.proof.stateHash === expectedHash &&
      fp.proof.stepCount === state.stepCount &&
      fp.proof.winner === state.winner;
    if (matchesCanonical) {
      throw new Error('Disputed final proof actually matches canonical replay');
    }
    return {
      adjudicated: true,
      offenderSeat: peerSeat,
      expectedHash,
      stepCount: state.stepCount,
      reason: 'signed-final-proof-mismatch'
    };
  }

  // Fault Mode B: Signed Reveal fault (commit/nonce hash mismatch or illegal move signed by active turn player)
  if (evidence.faultType === 'reveal-fault' && evidence.disputedReveal) {
    const revAttestation = evidence.disputedReveal;
    const revPayload = revAttestation?.payload;
    const stepCount = evidence.moves.length;
    const player = state.turn;
    if (!revPayload || revPayload.kind !== 'move-reveal' || revPayload.matchId !== match.id ||
        revPayload.stepCount !== stepCount || revPayload.player !== player ||
        !verifySessionProof(keyForSeat(player), revPayload, revAttestation.signature)) {
      throw new Error('Disputed reveal does not carry a valid signature from active turn player');
    }
    let faultReason = null;
    if (evidence.commitAttestation) {
      const cPayload = evidence.commitAttestation?.payload;
      if (cPayload && cPayload.kind === 'move-commit' && cPayload.matchId === match.id &&
          cPayload.stepCount === stepCount && cPayload.player === player &&
          verifySessionProof(keyForSeat(player), cPayload, evidence.commitAttestation.signature)) {
        if (cPayload.hash !== revPayload.commit) {
          faultReason = 'signed-commit-reveal-mismatch';
        }
      }
    }
    if (!faultReason) {
      const expectedCommit = sha256({
        matchId: match.id,
        stepCount,
        player,
        move: revPayload.move,
        nonce: revPayload.nonce
      });
      if (expectedCommit !== revPayload.commit) {
        faultReason = 'signed-reveal-hash-mismatch';
      }
    }
    if (!faultReason) {
      try {
        OTTGameEngine.applyMove(state, revPayload.move);
      } catch {
        faultReason = 'signed-illegal-move';
      }
    }
    if (!faultReason) {
      throw new Error('Disputed reveal is completely valid and legal');
    }
    return {
      adjudicated: true,
      offenderSeat: player,
      expectedHash: sha256(statePayload(state)),
      stepCount: stepCount + 1,
      reason: faultReason
    };
  }

  // Fault Mode C (Default): Signed State-Ack Hash Mismatch at disputedStep
  if (!evidence.disputedStep) {
    throw new Error('Consensus dispute evidence is missing disputedStep');
  }
  const entry = evidence.disputedStep;
  const stepCount = evidence.moves.length;
  const player = state.turn;
  const commitPayload = {
    kind: 'move-commit', matchId: match.id, stepCount, player, hash: entry?.commit
  };
  const revealPayload = {
    kind: 'move-reveal', matchId: match.id, stepCount, player,
    move: entry?.move, nonce: entry?.nonce, commit: entry?.commit
  };
  if (!entry || entry.stepCount !== stepCount + 1 || entry.player !== player ||
      !entry.move || !Number.isInteger(entry.move.from) || !Number.isInteger(entry.move.to) ||
      canonical(Object.keys(entry.move).sort()) !== canonical(['from', 'to']) ||
      typeof entry.nonce !== 'string' ||
      sha256({ matchId: match.id, stepCount, player, move: entry.move, nonce: entry.nonce }) !== entry.commit ||
      !verifyAttestation(entry.commitAttestation, commitPayload, player) ||
      !verifyAttestation(entry.revealAttestation, revealPayload, player) ||
      !Array.isArray(entry.acknowledgements) || entry.acknowledgements.length !== 2) {
    throw new Error('Consensus dispute does not contain a complete signed disputed step');
  }

  state = OTTGameEngine.applyMove(state, entry.move);
  const expectedHash = sha256(statePayload(state));
  const acknowledgements = [];
  for (const seat of [1, 2]) {
    const attestation = entry.acknowledgements.find(item => item?.payload?.player === seat);
    const payload = attestation?.payload;
    const expectedPayload = {
      kind: 'state-ack', matchId: match.id, stepCount: stepCount + 1,
      player: seat, moveCommit: entry.commit, stateHash: payload?.stateHash
    };
    if (!payload ||
        !verifyAttestation(attestation, expectedPayload, seat)) {
      throw new Error('Consensus dispute has invalid or non-conflicting signed acknowledgements');
    }
    acknowledgements.push({ seat, stateHash: payload.stateHash });
  }
  if (acknowledgements[0].stateHash === acknowledgements[1].stateHash) {
    throw new Error('Consensus dispute acknowledgements do not conflict');
  }
  if (!acknowledgements.some(ack => ack.stateHash === entry.stateHash)) {
    throw new Error('Consensus dispute local state does not match either signed acknowledgement');
  }
  const incorrectSeats = acknowledgements.filter(ack => ack.stateHash !== expectedHash).map(ack => ack.seat);
  const correctSeats = acknowledgements.filter(ack => ack.stateHash === expectedHash).map(ack => ack.seat);
  const offenderSeat = incorrectSeats.length === 1 && correctSeats.length === 1 ? incorrectSeats[0] : null;
  return {
    adjudicated: offenderSeat !== null,
    offenderSeat,
    expectedHash,
    stepCount: stepCount + 1,
    reason: offenderSeat === null ? 'conflicting-valid-signatures-without-a-unique-fault' : 'signed-state-hash-mismatch'
  };
}

function statePayload(state) {
  return {
    board: Array.from(state.board), turn: state.turn, stepCount: state.stepCount,
    winner: state.winner === 0 ? 0 : (state.winner || null), seed: state.seed, pieceCount: state.pieceCount,
    lastMove: state.lastMove || null,
    ...(state.rules ? { rules: state.rules } : {})
  };
}
