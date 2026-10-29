import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
import WebSocket from 'ws';
import { startServer } from '../../server.ts';

const require = createRequire(import.meta.url);
const { OTTGameEngine } = require('../../shared/OTTGameEngine.js');
const encoder = new TextEncoder();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function canonical(value) {
  return Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object'
    ? `{${Object.keys(value)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
        .join(',')}}`
    : JSON.stringify(value);
}

const sha256 = (value) => createHash('sha256').update(canonical(value)).digest('hex');

function statePayload(state) {
  return {
    board: Array.from(state.board),
    turn: state.turn,
    stepCount: state.stepCount,
    winner: state.winner === 0 ? 0 : state.winner || null,
    seed: state.seed,
    pieceCount: state.pieceCount,
    lastMove: state.lastMove || null,
    ...(state.rules ? { rules: state.rules } : {}),
  };
}

async function makeSessionIdentity() {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  return {
    privateKey: keys.privateKey,
    publicKey: await webcrypto.subtle.exportKey('jwk', keys.publicKey),
  };
}

async function signPayload(identity, payload) {
  const sig = await webcrypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    identity.privateKey,
    encoder.encode(canonical(payload))
  );
  return Buffer.from(sig).toString('hex');
}

async function attest(identity, payload) {
  return { payload, signature: await signPayload(identity, payload) };
}

async function createTestHarness() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ottv2-e2e-'));
  const dbPath = path.join(tmpDir, 'test-db.json');
  const srv = await startServer({
    port: 0,
    dbPath,
    skipVite: true,
    testAdminEmails: ['admin@ottv2.local'],
    timeouts: {
      disconnectForfeitMs: 140,
      setupTimeoutMs: 180,
      setupPeerReadyTimeoutMs: 120,
      ackTimeoutMs: 120,
      botAckTimeoutMs: 260,
      botTurnTimeoutMs: 1000,
      sweepIntervalMs: 40,
    },
  });
  const addr = srv.httpServer.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/ws`;
  const openSockets = new Set();

  async function api(method, route, token = null, body = undefined) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${baseUrl}${route}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, data: json };
  }

  async function registerUser(label, saveBot = true) {
    const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.local`;
    const reg = await api('POST', '/api/auth/register', null, {
      email,
      password: 'password12345',
      displayName: label,
    });
    assert.equal(reg.status, 201, `Failed registering ${label}: ${JSON.stringify(reg.data)}`);
    if (saveBot) {
      const botRes = await api('POST', '/api/bots/me', reg.data.token, {
        code: `def get_next_move(my_player_id, game_state):\n    moves = game_state.get('validMoves', [])\n    return moves[0] if moves else None\n`,
      });
      assert.equal(botRes.status, 201);
    }
    const me = await api('GET', '/api/me', reg.data.token);
    return { token: reg.data.token, user: me.data.user };
  }

  async function loginAdmin() {
    const res = await api('POST', '/api/auth/login', null, {
      email: 'admin@ottv2.local',
      password: 'halloween2026',
    });
    assert.equal(res.status, 200);
    return { token: res.data.token, user: res.data.user };
  }

  async function connectWs(token) {
    const ws = new WebSocket(wsUrl);
    openSockets.add(ws);
    const inbox = [];
    const waiters = [];

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      for (let i = 0; i < waiters.length; i++) {
        if (waiters[i].pred(msg)) {
          const w = waiters.splice(i, 1)[0];
          clearTimeout(w.timer);
          w.resolve(msg);
          return;
        }
      }
      inbox.push(msg);
    });

    ws.on('close', () => openSockets.delete(ws));

    function waitFor(predOrType, timeoutMs = 4000) {
      const pred =
        typeof predOrType === 'string' ? (m) => m.type === predOrType : predOrType;
      const idx = inbox.findIndex(pred);
      if (idx >= 0) {
        return Promise.resolve(inbox.splice(idx, 1)[0]);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const pos = waiters.findIndex((w) => w.timer === timer);
          if (pos >= 0) waiters.splice(pos, 1);
          reject(new Error(`Timed out waiting for WS packet (${String(predOrType)})`));
        }, timeoutMs);
        waiters.push({ pred, resolve, timer });
      });
    }

    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    ws.send(JSON.stringify({ type: 'auth', token }));
    await waitFor('authenticated');

    return {
      ws,
      send: (pkt) => ws.send(JSON.stringify(pkt)),
      waitFor,
      close: () => ws.close(),
    };
  }

  async function pairBotMatch(u1, u2) {
    const c1 = await connectWs(u1.token);
    const c2 = await connectWs(u2.token);
    c1.send({ type: 'find-bot-match' });
    await c1.waitFor('searching');
    c2.send({ type: 'find-bot-match' });
    const [m1, m2] = await Promise.all([c1.waitFor('match-found'), c2.waitFor('match-found')]);
    assert.equal(m1.match.id, m2.match.id);
    const matchId = m1.match.id;

    const id1 = await makeSessionIdentity();
    const id2 = await makeSessionIdentity();
    c1.send({ type: 'session-key', matchId, publicKey: id1.publicKey });
    c2.send({ type: 'session-key', matchId, publicKey: id2.publicKey });
    await Promise.all([
      c1.waitFor('session-key-accepted'),
      c2.waitFor('session-key-accepted'),
      c1.waitFor('peer-session-key'),
      c2.waitFor('peer-session-key'),
    ]);

    const seat1 = m1.seat === 1 ? { client: c1, user: u1, id: id1, match: m1.match } : { client: c2, user: u2, id: id2, match: m2.match };
    const seat2 = m1.seat === 2 ? { client: c1, user: u1, id: id1, match: m1.match } : { client: c2, user: u2, id: id2, match: m2.match };
    return { matchId, seed: m1.match.seed, rules: m1.match.rules || null, seat1, seat2 };
  }

  async function markBothBotsReady(paired) {
    paired.seat1.client.send({
      type: 'match-relay',
      matchId: paired.matchId,
      payload: { type: 'BOT_READY' },
    });
    paired.seat2.client.send({
      type: 'match-relay',
      matchId: paired.matchId,
      payload: { type: 'BOT_READY' },
    });
    await Promise.all([
      paired.seat1.client.waitFor((m) => m.type === 'match-relay' && m.payload?.type === 'BOT_READY'),
      paired.seat2.client.waitFor((m) => m.type === 'match-relay' && m.payload?.type === 'BOT_READY'),
    ]);
  }

  async function cleanup() {
    for (const s of openSockets) {
      try {
        s.close();
      } catch {}
    }
    await srv.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  return { api, registerUser, loginAdmin, connectWs, pairBotMatch, markBothBotsReady, dbPath, cleanup };
}

test('Profile settings: store uploaded avatar and require matching password confirmation', async () => {
  const h = await createTestHarness();
  try {
    const player = await h.registerUser('ProfileSettings', false);
    const pngDataUrl =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jPzsAAAAASUVORK5CYII=';

    const avatarUpdate = await h.api('PATCH', '/api/me', player.token, {
      avatarDataUrl: pngDataUrl,
    });
    assert.equal(avatarUpdate.status, 200, JSON.stringify(avatarUpdate.data));
    assert.equal(avatarUpdate.data.user.avatarUrl, pngDataUrl);
    const persistedProfile = await h.api('GET', '/api/me', player.token);
    assert.equal(persistedProfile.data.user.avatarUrl, pngDataUrl);

    const largePngBytes = Buffer.alloc(5 * 1024 * 1024);
    Buffer.from('89504e470d0a1a0a', 'hex').copy(largePngBytes);
    const largeAvatarDataUrl = `data:image/png;base64,${largePngBytes.toString('base64')}`;
    const largeAvatarUpdate = await h.api('PATCH', '/api/me', player.token, {
      avatarDataUrl: largeAvatarDataUrl,
    });
    assert.equal(largeAvatarUpdate.status, 200, JSON.stringify(largeAvatarUpdate.data));
    assert.equal(largeAvatarUpdate.data.user.avatarUrl, largeAvatarDataUrl);

    const oversizedPngBytes = Buffer.alloc(5 * 1024 * 1024 + 1);
    Buffer.from('89504e470d0a1a0a', 'hex').copy(oversizedPngBytes);
    const oversizedAvatarUpdate = await h.api('PATCH', '/api/me', player.token, {
      avatarDataUrl: `data:image/png;base64,${oversizedPngBytes.toString('base64')}`,
    });
    assert.equal(oversizedAvatarUpdate.status, 400);

    const backgroundChoice = await h.api('PATCH', '/api/me', player.token, {
      profileBackgroundId: 'moonlight',
    });
    assert.equal(backgroundChoice.status, 200, JSON.stringify(backgroundChoice.data));
    assert.equal(backgroundChoice.data.user.profileBackgroundId, 'moonlight');
    const persistedBackgroundChoice = await h.api('GET', '/api/me', player.token);
    assert.equal(persistedBackgroundChoice.data.user.profileBackgroundId, 'moonlight');

    const changedBackgroundChoice = await h.api('PATCH', '/api/me', player.token, {
      profileBackgroundId: 'aurora',
    });
    assert.equal(changedBackgroundChoice.status, 200, JSON.stringify(changedBackgroundChoice.data));
    assert.equal(changedBackgroundChoice.data.user.profileBackgroundId, 'aurora');

    const invalidBackgroundChoice = await h.api('PATCH', '/api/me', player.token, {
      profileBackgroundId: 'not-a-background',
    });
    assert.equal(invalidBackgroundChoice.status, 400);

    const addedAvatarChoice = await h.api('PATCH', '/api/me', player.token, {
      avatarId: 'dragon',
    });
    assert.equal(addedAvatarChoice.status, 200, JSON.stringify(addedAvatarChoice.data));
    assert.equal(addedAvatarChoice.data.user.avatarId, 'dragon');
    assert.equal(addedAvatarChoice.data.user.avatarUrl, null);

    const backgroundUpdate = await h.api('PATCH', '/api/me', player.token, {
      profileBackgroundDataUrl: pngDataUrl,
    });
    assert.equal(backgroundUpdate.status, 200, JSON.stringify(backgroundUpdate.data));
    assert.equal(backgroundUpdate.data.user.profileBackgroundUrl, pngDataUrl);
    const persistedBackground = await h.api('GET', '/api/me', player.token);
    assert.equal(persistedBackground.data.user.profileBackgroundUrl, pngDataUrl);

    const resetBackgroundChoice = await h.api('PATCH', '/api/me', player.token, {
      profileBackgroundId: 'aurora',
    });
    assert.equal(resetBackgroundChoice.status, 200, JSON.stringify(resetBackgroundChoice.data));
    assert.equal(resetBackgroundChoice.data.user.profileBackgroundId, 'aurora');
    assert.equal(resetBackgroundChoice.data.user.profileBackgroundUrl, null);

    const invalidAvatar = await h.api('PATCH', '/api/me', player.token, {
      avatarDataUrl: 'data:image/png;base64,SGVsbG8=',
    });
    assert.equal(invalidAvatar.status, 400);

    const mismatchedPassword = await h.api('PATCH', '/api/me', player.token, {
      currentPassword: 'password12345',
      newPassword: 'changed-password',
      confirmNewPassword: 'different-password',
    });
    assert.equal(mismatchedPassword.status, 400);

    const changedPassword = await h.api('PATCH', '/api/me', player.token, {
      currentPassword: 'password12345',
      newPassword: 'changed-password',
      confirmNewPassword: 'changed-password',
    });
    assert.equal(changedPassword.status, 200, JSON.stringify(changedPassword.data));

    const oldPasswordLogin = await h.api('POST', '/api/auth/login', null, {
      email: player.user.email,
      password: 'password12345',
    });
    assert.equal(oldPasswordLogin.status, 401);
    const newPasswordLogin = await h.api('POST', '/api/auth/login', null, {
      email: player.user.email,
      password: 'changed-password',
    });
    assert.equal(newPasswordLogin.status, 200);
  } finally {
    await h.cleanup();
  }
});

test('Bot-vs-Bot E2E: full signed consensus match + draw & win submission + Elo updates', async () => {
  const h = await createTestHarness();
  try {
    const u1 = await h.registerUser('BotAlpha');
    const u2 = await h.registerUser('BotBeta');
    const paired = await h.pairBotMatch(u1, u2);
    await h.markBothBotsReady(paired);

    // Play a clean 8-ply 3-fold repetition draw via signed consensus relay
    let state = OTTGameEngine.createGame(paired.seed, 9, paired.rules);
    const initialSerialized = OTTGameEngine.serialize(state);
    const mA = OTTGameEngine.getAllValidMoves(state).find(
      (m) => !m.isAttack && m.to !== 8 && m.to !== 72
    );
    const sA = OTTGameEngine.applyMove(state, { from: mA.from, to: mA.to });
    const mB = OTTGameEngine.getAllValidMoves(sA).find(
      (m) => !m.isAttack && m.to !== mA.from && m.to !== 8 && m.to !== 72
    );
    const cycle = [
      { from: mA.from, to: mA.to },
      { from: mB.from, to: mB.to },
      { from: mA.to, to: mA.from },
      { from: mB.to, to: mB.from },
    ];
    const plan = [...cycle, ...cycle];
    const replayMoves = [];

    for (let step = 0; step < plan.length; step++) {
      const move = plan[step];
      const activeSeat = state.turn === 1 ? paired.seat1 : paired.seat2;
      const passiveSeat = state.turn === 1 ? paired.seat2 : paired.seat1;
      const nonce = `live-nonce-${step}`;
      const commit = sha256({ matchId: paired.matchId, stepCount: step, player: state.turn, move, nonce });

      const commitAtt = await attest(activeSeat.id, {
        kind: 'move-commit',
        matchId: paired.matchId,
        stepCount: step,
        player: state.turn,
        hash: commit,
      });
      activeSeat.client.send({
        type: 'match-relay',
        matchId: paired.matchId,
        payload: { type: 'CONSENSUS_COMMIT', attestation: commitAtt },
      });
      await passiveSeat.client.waitFor(
        (m) => m.type === 'match-relay' && m.payload?.type === 'CONSENSUS_COMMIT'
      );

      const revealAtt = await attest(activeSeat.id, {
        kind: 'move-reveal',
        matchId: paired.matchId,
        stepCount: step,
        player: state.turn,
        move,
        nonce,
        commit,
      });
      activeSeat.client.send({
        type: 'match-relay',
        matchId: paired.matchId,
        payload: { type: 'CONSENSUS_REVEAL', attestation: revealAtt },
      });
      await passiveSeat.client.waitFor(
        (m) => m.type === 'match-relay' && m.payload?.type === 'CONSENSUS_REVEAL'
      );

      state = OTTGameEngine.applyMove(state, move);
      const stateHash = sha256(statePayload(state));

      const ack1 = await attest(paired.seat1.id, {
        kind: 'state-ack',
        matchId: paired.matchId,
        stepCount: step + 1,
        player: 1,
        moveCommit: commit,
        stateHash,
      });
      const ack2 = await attest(paired.seat2.id, {
        kind: 'state-ack',
        matchId: paired.matchId,
        stepCount: step + 1,
        player: 2,
        moveCommit: commit,
        stateHash,
      });
      paired.seat1.client.send({
        type: 'match-relay',
        matchId: paired.matchId,
        payload: { type: 'CONSENSUS_ACK', attestation: ack1 },
      });
      paired.seat2.client.send({
        type: 'match-relay',
        matchId: paired.matchId,
        payload: { type: 'CONSENSUS_ACK', attestation: ack2 },
      });
      const [receipt1, receipt2] = await Promise.all([
        paired.seat1.client.waitFor('consensus-ack-received'),
        paired.seat2.client.waitFor('consensus-ack-received'),
      ]);
      assert.equal(receipt1.stepCount, step + 1);
      assert.equal(receipt1.stateHash, stateHash);
      assert.equal(receipt2.stepCount, step + 1);
      assert.equal(receipt2.stateHash, stateHash);
      await Promise.all([
        paired.seat1.client.waitFor(
          (m) => m.type === 'match-relay' && m.payload?.type === 'CONSENSUS_ACK'
        ),
        paired.seat2.client.waitFor(
          (m) => m.type === 'match-relay' && m.payload?.type === 'CONSENSUS_ACK'
        ),
      ]);

      replayMoves.push({
        stepCount: step + 1,
        player: step % 2 === 0 ? 1 : 2,
        move,
        nonce,
        commit,
        stateHash,
      });
    }

    assert.equal(state.winner, 0);
    const replay = {
      format: 'ottv2-replay-v1',
      matchId: paired.matchId,
      seed: paired.seed,
      initialState: initialSerialized,
      moves: replayMoves,
    };
    const finalHash = sha256(statePayload(state));
    const proofPayload = {
      matchId: paired.matchId,
      roomId: paired.matchId,
      stepCount: state.stepCount,
      stateHash: finalHash,
      winner: 0,
    };
    const p1Proof = { proof: proofPayload, signature: await signPayload(paired.seat1.id, proofPayload) };
    const p2Proof = { proof: proofPayload, signature: await signPayload(paired.seat2.id, proofPayload) };

    const submit = await h.api('POST', '/api/match/submit-result', paired.seat1.user.token, {
      matchId: paired.matchId,
      replay,
      proofs: { player1: p1Proof, player2: p2Proof },
    });
    assert.equal(submit.status, 200, JSON.stringify(submit.data));
    assert.equal(submit.data.winner, 0);
    assert.equal(submit.data.winnerId, null);
    assert.equal(submit.data.drawReason, 'threefold-repetition');
    assert.equal(submit.data.eloUpdated, true);

    // Now play a second Bot-vs-Bot match to a decisive win (seat 1 marches to goal cell 8) and verify Elo updates + replay retrieval
    const pairedWin = await h.pairBotMatch(u1, u2);
    await h.markBothBotsReady(pairedWin);

    let winState = OTTGameEngine.createGame(pairedWin.seed, 9, pairedWin.rules);
    const winInitialSerialized = OTTGameEngine.serialize(winState);
    const winReplayMoves = [];

    for (let step = 0; step < 80 && !OTTGameEngine.isGameOver(winState); step++) {
      const legal = OTTGameEngine.getAllValidMoves(winState);
      let chosen;
      if (winState.turn === 1) {
        // Seat 1 marches toward its goal square 8 (row 0, col 8)
        chosen = legal
          .slice()
          .sort((a, b) => {
            const da = Math.floor(a.to / 9) + Math.abs((a.to % 9) - 8);
            const db = Math.floor(b.to / 9) + Math.abs((b.to % 9) - 8);
            return da - db;
          })[0];
      } else {
        // Seat 2 makes a safe non-goal move so Seat 1 reaches its goal cleanly
        chosen = legal
          .filter((m) => !m.isAttack && m.to !== 8 && m.to !== 72)
          .sort((a, b) => {
            const da = Math.floor(a.to / 9) + Math.abs((a.to % 9) - 8);
            const db = Math.floor(b.to / 9) + Math.abs((b.to % 9) - 8);
            return db - da;
          })[0] || legal[0];
      }
      const move = { from: chosen.from, to: chosen.to };
      const activeSeat = winState.turn === 1 ? pairedWin.seat1 : pairedWin.seat2;
      const passiveSeat = winState.turn === 1 ? pairedWin.seat2 : pairedWin.seat1;
      const nonce = `win-nonce-${step}`;
      const commit = sha256({
        matchId: pairedWin.matchId,
        stepCount: step,
        player: winState.turn,
        move,
        nonce,
      });

      const commitAtt = await attest(activeSeat.id, {
        kind: 'move-commit',
        matchId: pairedWin.matchId,
        stepCount: step,
        player: winState.turn,
        hash: commit,
      });
      activeSeat.client.send({
        type: 'match-relay',
        matchId: pairedWin.matchId,
        payload: { type: 'CONSENSUS_COMMIT', attestation: commitAtt },
      });
      await passiveSeat.client.waitFor(
        (m) => m.type === 'match-relay' && m.payload?.type === 'CONSENSUS_COMMIT'
      );

      const revealAtt = await attest(activeSeat.id, {
        kind: 'move-reveal',
        matchId: pairedWin.matchId,
        stepCount: step,
        player: winState.turn,
        move,
        nonce,
        commit,
      });
      activeSeat.client.send({
        type: 'match-relay',
        matchId: pairedWin.matchId,
        payload: { type: 'CONSENSUS_REVEAL', attestation: revealAtt },
      });
      await passiveSeat.client.waitFor(
        (m) => m.type === 'match-relay' && m.payload?.type === 'CONSENSUS_REVEAL'
      );

      const moverPlayer = winState.turn;
      winState = OTTGameEngine.applyMove(winState, move);
      const stateHash = sha256(statePayload(winState));

      const ack1 = await attest(pairedWin.seat1.id, {
        kind: 'state-ack',
        matchId: pairedWin.matchId,
        stepCount: step + 1,
        player: 1,
        moveCommit: commit,
        stateHash,
      });
      const ack2 = await attest(pairedWin.seat2.id, {
        kind: 'state-ack',
        matchId: pairedWin.matchId,
        stepCount: step + 1,
        player: 2,
        moveCommit: commit,
        stateHash,
      });
      pairedWin.seat1.client.send({
        type: 'match-relay',
        matchId: pairedWin.matchId,
        payload: { type: 'CONSENSUS_ACK', attestation: ack1 },
      });
      pairedWin.seat2.client.send({
        type: 'match-relay',
        matchId: pairedWin.matchId,
        payload: { type: 'CONSENSUS_ACK', attestation: ack2 },
      });
      await Promise.all([
        pairedWin.seat1.client.waitFor(
          (m) => m.type === 'match-relay' && m.payload?.type === 'CONSENSUS_ACK'
        ),
        pairedWin.seat2.client.waitFor(
          (m) => m.type === 'match-relay' && m.payload?.type === 'CONSENSUS_ACK'
        ),
      ]);

      winReplayMoves.push({
        stepCount: step + 1,
        player: moverPlayer,
        move,
        nonce,
        commit,
        stateHash,
      });
    }

    assert.equal(winState.winner, 1);
    const winFinalHash = sha256(statePayload(winState));
    const winProofPayload = {
      matchId: pairedWin.matchId,
      roomId: pairedWin.matchId,
      stepCount: winState.stepCount,
      stateHash: winFinalHash,
      winner: 1,
    };
    const winP1Proof = {
      proof: winProofPayload,
      signature: await signPayload(pairedWin.seat1.id, winProofPayload),
    };
    const winP2Proof = {
      proof: winProofPayload,
      signature: await signPayload(pairedWin.seat2.id, winProofPayload),
    };
    const winReplay = {
      format: 'ottv2-replay-v1',
      matchId: pairedWin.matchId,
      seed: pairedWin.seed,
      initialState: winInitialSerialized,
      moves: winReplayMoves,
    };

    const submitWin = await h.api(
      'POST',
      '/api/match/submit-result',
      pairedWin.seat1.user.token,
      {
        matchId: pairedWin.matchId,
        replay: winReplay,
        proofs: { player1: winP1Proof, player2: winP2Proof },
      }
    );
    assert.equal(submitWin.status, 200, JSON.stringify(submitWin.data));
    assert.equal(submitWin.data.winner, 1);
    assert.equal(submitWin.data.winnerId, pairedWin.seat1.user.user.id);
    assert.equal(submitWin.data.eloUpdated, true);
    assert.ok(submitWin.data.elo.player1.after > submitWin.data.elo.player1.before);
    assert.ok(submitWin.data.elo.player2.after < submitWin.data.elo.player2.before);

    const matchHistory = await h.api('GET', '/api/matches', pairedWin.seat1.user.token);
    assert.equal(matchHistory.status, 200);
    const recordedWin = matchHistory.data.matches.find((match) => match.id === pairedWin.matchId);
    assert.equal(recordedWin.elo_updated, true);
    assert.equal(recordedWin.is_sparring, false);
    assert.equal(
      recordedWin.elo_delta,
      submitWin.data.elo.player1.after - submitWin.data.elo.player1.before
    );
    assert.equal(recordedWin.elo_before, submitWin.data.elo.player1.before);
    assert.equal(recordedWin.elo_after, submitWin.data.elo.player1.after);
    assert.equal(recordedWin.replay_available, true);
    const opponentHistory = await h.api('GET', '/api/matches', pairedWin.seat2.user.token);
    const recordedLoss = opponentHistory.data.matches.find((match) => match.id === pairedWin.matchId);
    assert.equal(recordedLoss.elo_delta, submitWin.data.elo.player2.after - submitWin.data.elo.player2.before);
    assert.equal(recordedLoss.elo_before, submitWin.data.elo.player2.before);
    assert.equal(recordedLoss.elo_after, submitWin.data.elo.player2.after);
    const updatedProfile = await h.api('GET', '/api/me', pairedWin.seat1.user.token);
    assert.equal(
      updatedProfile.data.user.highestElo,
      Math.max(submitWin.data.elo.player1.before, submitWin.data.elo.player1.after)
    );

    const replayFetch = await h.api(
      'GET',
      `/api/matches/${pairedWin.matchId}/replay`,
      pairedWin.seat1.user.token
    );
    assert.equal(replayFetch.status, 200);
    assert.equal(replayFetch.data.replay.moves.length, winState.stepCount);
  } finally {
    await h.cleanup();
  }
});

test('Bot-vs-Bot E2E: outgame (leave-match & forfeit), WS disconnect, bot-fault, and forged relay signature immediately award win + notify winner', async () => {
  const h = await createTestHarness();
  try {
    // 1. Outgame via WS leave-match
    const a1 = await h.registerUser('OutLeave1');
    const a2 = await h.registerUser('OutLeave2');
    const mLeave = await h.pairBotMatch(a1, a2);
    mLeave.seat2.client.send({ type: 'leave-match', matchId: mLeave.matchId });
    const winLeave = await mLeave.seat1.client.waitFor('match-forfeited');
    assert.equal(winLeave.winnerId, mLeave.seat1.user.user.id);
    assert.equal(winLeave.reason, 'player-left-match');
    assert.ok(winLeave.eloAfter > winLeave.eloBefore);
    assert.match(winLeave.message, /xử thắng kỹ thuật/i);

    // 2. Outgame via HTTP POST /api/match/forfeit (used by beforeunload/keepalive)
    const b1 = await h.registerUser('HttpForfeit1');
    const b2 = await h.registerUser('HttpForfeit2');
    const mHttp = await h.pairBotMatch(b1, b2);
    const fRes = await h.api('POST', '/api/match/forfeit', mHttp.seat1.user.token, {
      matchId: mHttp.matchId,
    });
    assert.equal(fRes.status, 200);
    const winHttp = await mHttp.seat2.client.waitFor('match-forfeited');
    assert.equal(winHttp.winnerId, mHttp.seat2.user.user.id);
    assert.equal(winHttp.reason, 'player-left-match');

    // 3. Abrupt WS disconnect -> peer-disconnected + automatic forfeit after grace period
    const c1 = await h.registerUser('DiscHonest');
    const c2 = await h.registerUser('DiscDropper');
    const mDisc = await h.pairBotMatch(c1, c2);
    mDisc.seat2.client.close();
    await mDisc.seat1.client.waitFor('peer-disconnected');
    const winDisc = await mDisc.seat1.client.waitFor('match-forfeited');
    assert.equal(winDisc.winnerId, mDisc.seat1.user.user.id);
    assert.equal(winDisc.reason, 'disconnect-timeout');
    assert.ok(winDisc.eloAfter > winDisc.eloBefore);

    // 4. Bot crash / TLE (bot-fault) -> immediate loss + winner notification
    const d1 = await h.registerUser('CrashHonest');
    const d2 = await h.registerUser('CrashBot');
    const mCrash = await h.pairBotMatch(d1, d2);
    mCrash.seat2.client.send({
      type: 'bot-fault',
      matchId: mCrash.matchId,
      message: 'ZeroDivisionError in get_next_move',
    });
    const winCrash = await mCrash.seat1.client.waitFor('match-forfeited');
    assert.equal(winCrash.winnerId, mCrash.seat1.user.user.id);
    assert.equal(winCrash.reason, 'bot-fault');

    // 5. Forged ECDSA signature on match-relay -> immediate technical loss at server relay
    const e1 = await h.registerUser('SigHonest');
    const e2 = await h.registerUser('SigForger');
    const mSig = await h.pairBotMatch(e1, e2);
    await h.markBothBotsReady(mSig);
    mSig.seat1.client.send({
      type: 'match-relay',
      matchId: mSig.matchId,
      payload: {
        type: 'CONSENSUS_COMMIT',
        attestation: {
          payload: {
            kind: 'move-commit',
            matchId: mSig.matchId,
            stepCount: 0,
            player: 1,
            hash: 'a'.repeat(64),
          },
          signature: 'deadbeef'.repeat(16), // invalid P-256 signature
        },
      },
    });
    const winSig = await mSig.seat2.client.waitFor('match-forfeited');
    assert.equal(winSig.winnerId, mSig.seat2.user.user.id);
    assert.equal(winSig.reason, 'invalid-relay-signature');
  } finally {
    await h.cleanup();
  }
});

test('Bot-vs-Bot E2E: hash mismatch, illegal reveal, and withheld ACK / stall timeouts resolve immediately with winner notifications', async () => {
  const h = await createTestHarness();
  try {
    // 1. Live Consensus State-Ack Hash Mismatch -> POST /api/match/consensus-dispute -> match-dispute-result WS
    const u1 = await h.registerUser('HonestBot');
    const u2 = await h.registerUser('BadHashBot');
    const paired = await h.pairBotMatch(u1, u2);
    await h.markBothBotsReady(paired);

    const initState = OTTGameEngine.createGame(paired.seed, 9);
    const moveObj = (() => {
      const m = OTTGameEngine.getAllValidMoves(initState)[0];
      return { from: m.from, to: m.to };
    })();
    const nonce = 'step0-nonce';
    const commit = sha256({ matchId: paired.matchId, stepCount: 0, player: 1, move: moveObj, nonce });
    const commitAtt = await attest(paired.seat1.id, {
      kind: 'move-commit',
      matchId: paired.matchId,
      stepCount: 0,
      player: 1,
      hash: commit,
    });
    const revealAtt = await attest(paired.seat1.id, {
      kind: 'move-reveal',
      matchId: paired.matchId,
      stepCount: 0,
      player: 1,
      move: moveObj,
      nonce,
      commit,
    });
    const afterStep1 = OTTGameEngine.applyMove(initState, moveObj);
    const goodHash = sha256(statePayload(afterStep1));
    const badHash = 'e'.repeat(64);

    const ackGood = await attest(paired.seat1.id, {
      kind: 'state-ack',
      matchId: paired.matchId,
      stepCount: 1,
      player: 1,
      moveCommit: commit,
      stateHash: goodHash,
    });
    const ackBad = await attest(paired.seat2.id, {
      kind: 'state-ack',
      matchId: paired.matchId,
      stepCount: 1,
      player: 2,
      moveCommit: commit,
      stateHash: badHash,
    });

    const evidence = {
      format: 'ottv2-consensus-dispute-v1',
      faultType: 'state-ack-mismatch',
      matchId: paired.matchId,
      seed: paired.seed,
      initialState: OTTGameEngine.serialize(initState),
      moves: [],
      disputedStep: {
        stepCount: 1,
        player: 1,
        move: moveObj,
        nonce,
        commit,
        stateHash: goodHash,
        commitAttestation: commitAtt,
        revealAttestation: revealAtt,
        acknowledgements: [ackGood, ackBad],
      },
    };
    const reportPayload = {
      kind: 'consensus-dispute',
      matchId: paired.matchId,
      claimantSeat: 1,
      stepCount: 1,
      evidenceHash: sha256(evidence),
    };
    const report = await attest(paired.seat1.id, reportPayload);
    const dispRes = await h.api('POST', '/api/match/consensus-dispute', paired.seat1.user.token, {
      report,
      evidence,
    });
    assert.equal(dispRes.status, 200, JSON.stringify(dispRes.data));
    assert.equal(dispRes.data.resolved, true);
    assert.equal(dispRes.data.winnerId, paired.seat1.user.user.id);
    assert.equal(dispRes.data.reason, 'signed-state-hash-mismatch');

    const wsDisputeWin = await paired.seat1.client.waitFor('match-dispute-result');
    assert.equal(wsDisputeWin.winnerId, paired.seat1.user.user.id);
    assert.ok(wsDisputeWin.eloAfter > wsDisputeWin.eloBefore);

    // 2. Setup timeout when opponent never readies their Bot
    const s1 = await h.registerUser('ReadyBot');
    const s2 = await h.registerUser('StalledSetupBot');
    const mSetup = await h.pairBotMatch(s1, s2);
    mSetup.seat1.client.send({
      type: 'match-relay',
      matchId: mSetup.matchId,
      payload: { type: 'BOT_READY' },
    });
    await mSetup.seat2.client.waitFor((m) => m.type === 'match-relay' && m.payload?.type === 'BOT_READY');
    await sleep(150);
    const claimSetup = await h.api('POST', '/api/match/claim-timeout', mSetup.seat1.user.token, {
      matchId: mSetup.matchId,
    });
    assert.equal(claimSetup.status, 200);
    assert.equal(claimSetup.data.resolved, true);
    assert.equal(claimSetup.data.reason, 'setup-timeout');
    assert.equal(claimSetup.data.winnerId, mSetup.seat1.user.user.id);

    // 3. Withheld CONSENSUS_ACK timeout when opponent refuses to acknowledge a revealed move
    const w1 = await h.registerUser('AckHonest');
    const w2 = await h.registerUser('AckHoarder');
    const mAck = await h.pairBotMatch(w1, w2);
    await h.markBothBotsReady(mAck);

    const st0 = OTTGameEngine.createGame(mAck.seed, 9);
    const mv0 = (() => {
      const m = OTTGameEngine.getAllValidMoves(st0)[0];
      return { from: m.from, to: m.to };
    })();
    const nc0 = 'ack-hoard-nonce';
    const cm0 = sha256({ matchId: mAck.matchId, stepCount: 0, player: 1, move: mv0, nonce: nc0 });
    const cAtt0 = await attest(mAck.seat1.id, {
      kind: 'move-commit',
      matchId: mAck.matchId,
      stepCount: 0,
      player: 1,
      hash: cm0,
    });
    const rAtt0 = await attest(mAck.seat1.id, {
      kind: 'move-reveal',
      matchId: mAck.matchId,
      stepCount: 0,
      player: 1,
      move: mv0,
      nonce: nc0,
      commit: cm0,
    });
    const hashAfter0 = sha256(statePayload(OTTGameEngine.applyMove(st0, mv0)));
    const aAtt0 = await attest(mAck.seat1.id, {
      kind: 'state-ack',
      matchId: mAck.matchId,
      stepCount: 1,
      player: 1,
      moveCommit: cm0,
      stateHash: hashAfter0,
    });

    mAck.seat1.client.send({
      type: 'match-relay',
      matchId: mAck.matchId,
      payload: { type: 'CONSENSUS_COMMIT', attestation: cAtt0 },
    });
    mAck.seat1.client.send({
      type: 'match-relay',
      matchId: mAck.matchId,
      payload: { type: 'CONSENSUS_REVEAL', attestation: rAtt0 },
    });
    mAck.seat1.client.send({
      type: 'match-relay',
      matchId: mAck.matchId,
      payload: { type: 'CONSENSUS_ACK', attestation: aAtt0 },
    });
    await mAck.seat2.client.waitFor((m) => m.type === 'match-relay' && m.payload?.type === 'CONSENSUS_ACK');
    mAck.seat1.client.send({
      type: 'match-relay',
      matchId: mAck.matchId,
      payload: { type: 'CONSENSUS_ACK', attestation: aAtt0 },
    });
    const retriedAck = await mAck.seat2.client.waitFor(
      (m) => m.type === 'match-relay' && m.payload?.type === 'CONSENSUS_ACK'
    );
    assert.equal(retriedAck.payload.attestation.payload.stepCount, 1);
    // Seat 2 intentionally withholds its CONSENSUS_ACK!
    await sleep(150);
    const claimAck = await h.api('POST', '/api/match/claim-timeout', mAck.seat1.user.token, {
      matchId: mAck.matchId,
    });
    assert.equal(claimAck.status, 202);
    assert.equal(claimAck.data.waiting, true);
    await sleep(130);
    const expiredAck = await h.api('POST', '/api/match/claim-timeout', mAck.seat1.user.token, {
      matchId: mAck.matchId,
    });
    assert.equal(expiredAck.status, 200);
    assert.equal(expiredAck.data.resolved, true);
    assert.equal(expiredAck.data.reason, 'withheld-ack');
    assert.equal(expiredAck.data.winnerId, mAck.seat1.user.user.id);

    // 4. Turn timeout when active turn bot freezes without revealing
    const t1 = await h.registerUser('TurnFrozenBot');
    const t2 = await h.registerUser('TurnWaitingBot');
    const mTurn = await h.pairBotMatch(t1, t2);
    await h.markBothBotsReady(mTurn);
    // Seat 1's turn (step 0), Seat 1 stalls completely
    await sleep(1030);
    const claimTurn = await h.api('POST', '/api/match/claim-timeout', mTurn.seat2.user.token, {
      matchId: mTurn.matchId,
    });
    assert.equal(claimTurn.status, 200);
    assert.equal(claimTurn.data.resolved, true);
    assert.equal(claimTurn.data.reason, 'turn-timeout');
    assert.equal(claimTurn.data.winnerId, mTurn.seat2.user.user.id);
  } finally {
    await h.cleanup();
  }
});

test('2-Stage Individual Tournament E2E: Stage A practice (0 Star/0 Elo), Stage B placement, same-tier pairing, +1/0/-1 Stars, x2/3 Sprint reset, hidden Challenger BXH & 4 ego brackets, and completion reveal', async () => {
  const h = await createTestHarness();
  try {
    const admin = await h.loginAdmin();
    const now = Date.now();
    const createTour = await h.api('POST', '/api/tournaments', admin.token, {
      name: 'Giải Đấu Kiểm Định 2 Giai Đoạn',
      description: 'Kiểm định đầy đủ Vòng Chạy Đà & Vòng Thực Chiến Sprint',
      registrationClosesAt: new Date(now + 3600_000).toISOString(),
      endsAt: new Date(now + 86400_000 * 14).toISOString(),
      maxTeams: 64,
      sprintRules: ['standard', 'center_blockers', 'clipped_corners', 'corridor'],
    });
    assert.equal(createTour.status, 201, JSON.stringify(createTour.data));
    const tourId = createTour.data.tournament.id;
    const listedTournaments = await h.api('GET', '/api/tournaments');
    assert.ok(!listedTournaments.data.tournaments.some((tournament) => tournament.id === tourId));

    // 1. User without saved Bot is blocked from registering
    const noBotUser = await h.registerUser('NoBotPlayer', false);
    const rejectNoBot = await h.api('POST', `/api/tournaments/${tourId}/register`, noBotUser.token);
    assert.equal(rejectNoBot.status, 400);

    // 2. Register 3 players with saved Bots and set distinct starting Elos (<1350, 1450, 1650)
    const pBronzeA = await h.registerUser('BronzeKickerA', true);
    const pBronzeB = await h.registerUser('BronzeKickerB', true);
    const pGold = await h.registerUser('GoldGrandmaster', true);

    // Adjust GoldGrandmaster's initial Elo to 1650 in DB before registering/starting Stage B?
    // Wait: server holds `db` in memory, so let's win a quick match OR use seeded accounts!
    // Remember seeded accounts already have exact Elos and saved Bots:
    // - admin@ottv2.local: Elo 1685 (>= 1600 -> Gold!)
    // - linhdan@ottv2.local: Elo 1560 (1350..1599 -> Silver!)
    // - thaovy@ottv2.local: Elo 1290 (< 1350 -> Bronze!)
    const linhDanLogin = await h.api('POST', '/api/auth/login', null, {
      email: 'linhdan@ottv2.local',
      password: 'halloween2026',
    });
    const linhDan = { token: linhDanLogin.data.token, user: linhDanLogin.data.user }; // Elo 1560 (Silver)

    for (const participant of [pBronzeA, pBronzeB, linhDan, admin]) {
      const r = await h.api('POST', `/api/tournaments/${tourId}/register`, participant.token);
      assert.equal(r.status, 201);
    }

    // 3. Stage A (registration / Chạy đà): pairs across DIFFERENT Elos (1200 Bronze vs 1685 Gold!), locks botCode, and awards 0 Stars / 0 Elo!
    const wsStageA1 = await h.connectWs(pBronzeA.token);
    const wsStageA2 = await h.connectWs(admin.token);
    wsStageA1.send({ type: 'find-tournament-match', tournamentId: tourId });
    await wsStageA1.waitFor('searching');
    wsStageA2.send({ type: 'find-tournament-match', tournamentId: tourId });
    const [ma1, ma2] = await Promise.all([
      wsStageA1.waitFor('match-found'),
      wsStageA2.waitFor('match-found'),
    ]);
    assert.equal(ma1.match.id, ma2.match.id);
    assert.equal(ma1.match.tournamentPhase, 'practice');
    assert.ok(ma1.myBotCode.includes('def get_next_move'), 'Stage A match must lock submitted Bot code');

    // Forfeit Stage A match -> verify 0 Elo change and 0 Star change!
    await h.api('POST', '/api/match/forfeit', pBronzeA.token, { matchId: ma1.match.id });
    await wsStageA2.waitFor('match-forfeited');
    const meBronzeAfterPractice = await h.api('GET', '/api/me', pBronzeA.token);
    const meAdminAfterPractice = await h.api('GET', '/api/me', admin.token);
    assert.equal(meBronzeAfterPractice.data.user.elo, 1200, 'Stage A practice must NOT change Elo');
    assert.equal(meAdminAfterPractice.data.user.elo, 1685, 'Stage A practice must NOT change Elo');
    wsStageA1.close();
    wsStageA2.close();

    // 4. Start Stage B (Thực chiến — Sprint 1) -> verify initial Elo placement (<1350 Bronze, 1350-1599 Silver, >=1600 Gold)
    const startRes = await h.api('POST', `/api/tournaments/${tourId}/start`, admin.token);
    assert.equal(startRes.status, 200);
    assert.equal(startRes.data.tournament.status, 'qualifying');
    assert.equal(startRes.data.tournament.current_week, 1);
    assert.equal(startRes.data.tournament.rules_json.title, 'Bàn chuẩn');

    const detBronze = await h.api('GET', `/api/tournaments/${tourId}`, pBronzeA.token);
    const detSilver = await h.api('GET', `/api/tournaments/${tourId}`, linhDan.token);
    const detGold = await h.api('GET', `/api/tournaments/${tourId}`, admin.token);
    assert.equal(detBronze.data.myEntry.tier, 'Bronze');
    assert.equal(detBronze.data.myEntry.rank_stars, 0);
    assert.equal(detSilver.data.myEntry.tier, 'Silver');
    assert.equal(detSilver.data.myEntry.rank_stars, 0);
    assert.equal(detGold.data.myEntry.tier, 'Gold');
    assert.equal(detGold.data.myEntry.rank_stars, 0);
    assert.equal(detGold.data.leaderboardHidden, true);
    assert.deepEqual(detGold.data.standings, []);
    assert.equal(detGold.data.motivationBanner.bracket, 'gold');

    // 5. Stage B Matchmaking: strictly SAME tier! Bronze + Gold wait separately; second Bronze pairs immediately with Bronze!
    const wsB1 = await h.connectWs(pBronzeA.token);
    const wsG1 = await h.connectWs(admin.token);
    const wsB2 = await h.connectWs(pBronzeB.token);

    wsB1.send({ type: 'find-tournament-match', tournamentId: tourId });
    await wsB1.waitFor('searching');
    wsG1.send({ type: 'find-tournament-match', tournamentId: tourId });
    await wsG1.waitFor('searching'); // Must NOT match with Bronze!

    wsB2.send({ type: 'find-tournament-match', tournamentId: tourId });
    const [mb1, mb2] = await Promise.all([wsB1.waitFor('match-found'), wsB2.waitFor('match-found')]);
    assert.equal(mb1.match.id, mb2.match.id);
    assert.equal(mb1.match.tournamentPhase, 'ranked');
    assert.ok(mb1.myBotCode.includes('def get_next_move'));
    wsG1.send({ type: 'cancel-match' });
    wsG1.close();

    // Complete ranked match (pBronzeB forfeits -> pBronzeA wins +1 Star & Elo!)
    await h.api('POST', '/api/match/forfeit', pBronzeB.token, { matchId: mb1.match.id });
    const winRanked = await wsB1.waitFor('match-forfeited');
    assert.equal(winRanked.tournamentUpdate.tier, 'Bronze');
    assert.equal(winRanked.tournamentUpdate.stars, 1);

    const detBronzeB = await h.api('GET', `/api/tournaments/${tourId}`, pBronzeB.token);
    assert.equal(detBronzeB.data.myEntry.tier, 'Bronze');
    assert.equal(detBronzeB.data.myEntry.rank_stars, 0); // Bronze 0 floored on -1!
    wsB1.close();
    wsB2.close();

    // 6. Verify Sprint Reset (Gold 7 Sao -> Silver 14 Sao & Challenger 12 pts -> Master 14 Sao) on seeded Tournament 1!
    const seededTourId = '11111111-2222-4333-8444-555555555501';
    const t1Before = await h.api('GET', `/api/tournaments/${seededTourId}`, linhDan.token);
    assert.equal(t1Before.data.tournament.status, 'qualifying');
    assert.equal(t1Before.data.tournament.current_week, 2);
    assert.equal(t1Before.data.leaderboardHidden, true);
    assert.deepEqual(t1Before.data.standings, []);
    // Seeded Linh Đan is Gold with 7 stars in t1 -> verify nextSprintPreview in motivationBanner is Silver 14 Sao!
    assert.equal(t1Before.data.myEntry.tier, 'Gold');
    assert.equal(t1Before.data.myEntry.rank_stars, 7);
    assert.equal(t1Before.data.motivationBanner.currentTotal, 37);
    assert.equal(t1Before.data.motivationBanner.nextSprintTotal, 24);
    assert.equal(t1Before.data.motivationBanner.nextSprintTier, 'Silver');
    assert.equal(t1Before.data.motivationBanner.nextSprintStars, 14);

    // Advance Sprint 2 -> Sprint 3 (`clipped_corners`) and verify Linh Đan resets to Silver 14 Sao & Admin (Challenger 12 pts -> 112 * 2/3 = 74) resets to Master 14 Sao!
    const advRes = await h.api('POST', `/api/tournaments/${seededTourId}/advance-sprint`, admin.token);
    assert.equal(advRes.status, 200);
    assert.equal(advRes.data.tournament.current_week, 3);
    assert.equal(advRes.data.tournament.rules_json.title, 'Bàn vát góc');

    const t1LinhDanAfter = await h.api('GET', `/api/tournaments/${seededTourId}`, linhDan.token);
    assert.equal(t1LinhDanAfter.data.myEntry.tier, 'Silver');
    assert.equal(t1LinhDanAfter.data.myEntry.rank_stars, 14);

    const t1AdminAfter = await h.api('GET', `/api/tournaments/${seededTourId}`, admin.token);
    assert.equal(t1AdminAfter.data.myEntry.tier, 'Master');
    assert.equal(t1AdminAfter.data.myEntry.rank_stars, 14);

    // 7. Seed 22 Challenger players into a dedicated test DB state on disk, restart server, verify hidden Challenger leaderboard + 4 Challenger ego brackets + final reveal on complete!
    await h.cleanup();

    // Create a second harness pre-populated with 22 Challenger entries to test all 4 Challenger brackets (1..7, 8..12, 13..20, 21+) & completion reveal!
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ottv2-challenger-'));
    const dbPath2 = path.join(tmpDir2, 'challenger-db.json');
    const boot = await startServer({
      port: 0,
      dbPath: dbPath2,
      skipVite: true,
      testAdminEmails: ['admin@ottv2.local'],
    });
    await boot.close();

    const rawDb = JSON.parse(fs.readFileSync(dbPath2, 'utf8'));
    const challTourId = '11111111-2222-4333-8444-555555555501';
    const pwHash = rawDb.users[1].password_hash; // 'halloween2026'
    for (let rank = 1; rank <= 22; rank++) {
      const uid = `chall-user-${String(rank).padStart(2, '0')}`;
      rawDb.users.push({
        id: uid,
        email: `chall${rank}@ottv2.local`,
        password_hash: pwHash,
        display_name: `Challenger #${rank}`,
        elo: 1900 - rank * 5,
        is_admin: false,
        active_bot_version: 1,
        created_at: new Date(Date.now() - (100 - rank) * 1000).toISOString(),
      });
      rawDb.tournamentEntries.push({
        tournament_id: challTourId,
        player_id: uid,
        bot_version: 1,
        matches_played: 30,
        wins: 30 - rank,
        draws: 0,
        losses: rank,
        points: 0,
        tournament_elo: 1900 - rank * 5,
        tier: 'Challenger',
        rank_stars: 0,
        season_points: 100 - rank * 2,
        registered_at: new Date(Date.now() - (100 - rank) * 1000).toISOString(),
      });
    }
    fs.writeFileSync(dbPath2, JSON.stringify(rawDb, null, 2), 'utf8');

    const srv2 = await startServer({ port: 0, dbPath: dbPath2, skipVite: true });
    try {
      const addr2 = srv2.httpServer.address();
      const url2 = `http://127.0.0.1:${typeof addr2 === 'object' && addr2 ? addr2.port : 0}`;
      const call2 = async (method, route, token = null, body = undefined) => {
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers.Authorization = `Bearer ${token}`;
        const res = await fetch(`${url2}${route}`, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        return { status: res.status, data: await res.json() };
      };

      const checkBracket = async (rankNum, expectedBracket) => {
        const lg = await call2('POST', '/api/auth/login', null, {
          email: `chall${rankNum}@ottv2.local`,
          password: 'halloween2026',
        });
        assert.equal(lg.status, 200);
        const det = await call2('GET', `/api/tournaments/${challTourId}`, lg.data.token);
        assert.equal(det.data.leaderboardHidden, true, 'Challenger standings MUST stay hidden before tournament ends');
        assert.deepEqual(det.data.standings, []);
        assert.equal(det.data.finalStandings, null);
        assert.equal(det.data.motivationBanner.bracket, expectedBracket);
      };

      await checkBracket(1, 'top_7');
      await checkBracket(9, 'outside_top_7');
      await checkBracket(15, 'outside_top_12');
      await checkBracket(22, 'outside_top_20');

      // Complete tournament as BTC Admin -> Challenger leaderboard is now publicly revealed!
      const adminLg = await call2('POST', '/api/auth/login', null, {
        email: 'admin@ottv2.local',
        password: 'halloween2026',
      });
      const comp = await call2('POST', `/api/tournaments/${challTourId}/complete`, adminLg.data.token);
      assert.equal(comp.status, 200);

      const revealed = await call2('GET', `/api/tournaments/${challTourId}`, adminLg.data.token);
      assert.equal(revealed.data.leaderboardHidden, false);
      assert.equal(revealed.data.finalStandings.length, 23); // 22 seeded Challengers + Minh Quân · BTC
      assert.equal(revealed.data.finalStandings[0].display_name, 'Challenger #1');
      assert.equal(revealed.data.finalStandings[21].display_name, 'Challenger #22');
      assert.equal(revealed.data.finalStandings[22].display_name, 'Minh Quân');
    } finally {
      await srv2.close();
      fs.rmSync(tmpDir2, { recursive: true, force: true });
    }
    return; // already cleaned up h
  } catch (err) {
    await h.cleanup().catch(() => {});
    throw err;
  }
});

test('Group/knockout tournament creation publishes balanced groups and a two-leg fixture schedule', async () => {
  const h = await createTestHarness();
  try {
    const admin = await h.loginAdmin();
    const now = Date.now();
    const created = await h.api('POST', '/api/tournaments', admin.token, {
      name: 'Giải kiểm thử bảng đấu',
      description: 'Kiểm tra chia bảng và lịch thi đấu',
      registrationOpensAt: new Date(now - 10_000).toISOString(),
      registrationClosesAt: new Date(now + 86400000).toISOString(),
      tournamentStartsAt: new Date(now + 2 * 86400000).toISOString(),
      blockedCells: [],
      moveLimitRule: 'standard',
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const tournamentId = created.data.tournament.id;

    let firstParticipant;
    const participants = [];
    for (let index = 0; index < 32; index++) {
      const player = await h.registerUser(`GroupEntrant${index}`, true);
      if (index === 0) firstParticipant = player;
      participants.push(player);
      const registration = await h.api(
        'POST',
        `/api/tournaments/${tournamentId}/register`,
        player.token
      );
      assert.equal(registration.status, 201, JSON.stringify(registration.data));
    }

    const beforeOrganization = await h.api('GET', `/api/tournaments/${tournamentId}`, admin.token);
    assert.equal(beforeOrganization.data.tournament.status, 'registration');
    const grouped = await h.api('POST', `/api/tournaments/${tournamentId}/groups`, admin.token, {
      groupCount: 8,
    });
    assert.equal(grouped.status, 201, JSON.stringify(grouped.data));

    const detail = await h.api('GET', `/api/tournaments/${tournamentId}`, admin.token);
    assert.equal(detail.status, 200);
    assert.equal(detail.data.groups.length, 8);
    assert.equal(detail.data.tournament.status, 'group_stage');
    assert.ok(new Date(detail.data.tournament.registration_closes_at).getTime() <= Date.now());
    assert.ok(detail.data.groups.every((group) => group.members.length === 4));
    assert.equal(detail.data.fixtures.length, 96);
    assert.ok(detail.data.fixtures.every((fixture) => fixture.phase === 'group' && fixture.status === 'pending'));
    assert.equal(detail.data.groupStandingsPublished, false);

    const unauthorizedStart = await h.api(
      'POST',
      `/api/tournaments/${tournamentId}/start-groups`,
      firstParticipant.token,
      {}
    );
    assert.equal(unauthorizedStart.status, 403);
    const prematureKnockout = await h.api(
      'POST',
      `/api/tournaments/${tournamentId}/start-knockout`,
      admin.token,
      {}
    );
    assert.equal(prematureKnockout.status, 409);

    const launched = await h.api(
      'POST',
      `/api/tournaments/${tournamentId}/start-groups`,
      admin.token,
      {}
    );
    assert.equal(launched.status, 200, JSON.stringify(launched.data));
    const launchedDetail = await h.api('GET', `/api/tournaments/${tournamentId}`, admin.token);
    assert.equal(launchedDetail.data.tournament.status, 'group_running');
    assert.ok(new Date(launchedDetail.data.tournament.tournament_starts_at).getTime() <= Date.now());
    assert.equal(launchedDetail.data.groupStandingsPublished, true);

    assert.equal(launchedDetail.data.tournament.execution_mode, 'server');
    assert.ok(launchedDetail.data.fixtures.every(fixture => fixture.phase === 'group'));

    const cancelled = await h.api('POST', '/api/tournaments/cancel-all', admin.token, {});
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.data));
    assert.ok(cancelled.data.cancelledCount >= 1);
    const cancelledDetail = await h.api('GET', `/api/tournaments/${tournamentId}`, admin.token);
    assert.equal(cancelledDetail.data.tournament.status, 'cancelled');
    const visibleTournaments = await h.api('GET', '/api/tournaments');
    assert.ok(!visibleTournaments.data.tournaments.some((tournament) => tournament.id === tournamentId));
  } finally {
    await h.cleanup();
  }
});

test('admin can copy entrants and their saved bot versions into a fresh tournament', async () => {
  const h = await createTestHarness();
  try {
    const admin = await h.loginAdmin();
    const now = Date.now();
    const createTournament = (name) => h.api('POST', '/api/tournaments', admin.token, {
      name,
      description: 'Tournament roster-copy integration test',
      registrationOpensAt: new Date(now - 1000).toISOString(),
      registrationClosesAt: new Date(now + 86400000).toISOString(),
      tournamentStartsAt: new Date(now + 2 * 86400000).toISOString(),
      blockedCells: [],
      moveLimitRule: 'standard',
    });
    const source = await createTournament('Roster source');
    const target = await createTournament('Roster target');
    assert.equal(source.status, 201);
    assert.equal(target.status, 201);
    for (let index = 0; index < 16; index++) {
      const entrant = await h.registerUser(`RosterEntrant${index}`, true);
      const registration = await h.api(
        'POST',
        `/api/tournaments/${source.data.tournament.id}/register`,
        entrant.token
      );
      assert.equal(registration.status, 201);
    }

    const unauthorized = await h.api(
      'POST',
      `/api/tournaments/${target.data.tournament.id}/copy-entrants`,
      (await h.registerUser('RosterNonAdmin', false)).token,
      { sourceTournamentId: source.data.tournament.id }
    );
    assert.equal(unauthorized.status, 403);
    const copied = await h.api(
      'POST',
      `/api/tournaments/${target.data.tournament.id}/copy-entrants`,
      admin.token,
      { sourceTournamentId: source.data.tournament.id }
    );
    assert.equal(copied.status, 201, JSON.stringify(copied.data));
    assert.equal(copied.data.copiedCount, 16);

    const targetDetail = await h.api(
      'GET',
      `/api/tournaments/${target.data.tournament.id}`,
      admin.token
    );
    assert.equal(targetDetail.data.participantCount, 16);
    const storedDb = JSON.parse(fs.readFileSync(h.dbPath, 'utf8'));
    const sourceRoster = storedDb.tournamentEntries
      .filter((entry) => entry.tournament_id === source.data.tournament.id)
      .map((entry) => [entry.player_id, entry.bot_version])
      .sort(([first], [second]) => first.localeCompare(second));
    const targetRoster = storedDb.tournamentEntries
      .filter((entry) => entry.tournament_id === target.data.tournament.id)
      .map((entry) => [entry.player_id, entry.bot_version])
      .sort(([first], [second]) => first.localeCompare(second));
    assert.deepEqual(
      targetRoster,
      sourceRoster
    );
    const duplicateCopy = await h.api(
      'POST',
      `/api/tournaments/${target.data.tournament.id}/copy-entrants`,
      admin.token,
      { sourceTournamentId: source.data.tournament.id }
    );
    assert.equal(duplicateCopy.status, 409);
  } finally {
    await h.cleanup();
  }
});
