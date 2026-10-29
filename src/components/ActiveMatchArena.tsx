import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  CheckCircle2,
  Copy,
  Download,
  Loader2,
  Play,
  RotateCcw,
  ShieldCheck,
  Swords,
} from 'lucide-react';
import {
  OTTGameEngine,
  PIECE_VIET_NAMES,
  type BoardRules,
  type DrawReason,
  type GameState,
  type ValidMove,
} from '../core/ottEngine';
import {
  createNonce,
  digest,
  generateIdentity,
  hashMove,
  hashState,
  importPublicKey,
  signPayload,
  verifyPayload,
  type ConsensusIdentity,
} from '../core/consensusCrypto';
import { BotRunner } from '../core/botRunner';
import { SAMPLE_BOTS, type SampleBotKey } from '../core/sampleBots';
import { backendClient } from '../core/backendClient';
import { soundFx } from '../core/soundFx';
import { Board9x9 } from './Board9x9';
import { MascotCountsInline } from './HalloweenPieces';
import { useToast } from './ToastProvider';

const BOT_MATCH_TLE_MS = 20_000;

export interface ActiveMatchSession {
  source: 'backend' | 'p2p';
  matchId: string;
  roomCode?: string;
  seed: number;
  pieceCount: number;
  mode: 'human' | 'bot';
  mySeat: 1 | 2 | null; // null = spectator
  isHost?: boolean;
  player1Name: string;
  player2Name: string;
  player1Elo?: number;
  player2Elo?: number;
  rules: BoardRules | null;
  tournamentId?: string | null;
  tournamentPhase?: 'practice' | 'ranked' | 'group' | 'knockout' | null;
  isSparring?: boolean;
  lockedBotCode?: string | null;
  lockedBotVersion?: number;
  // For P2P rooms (PeerJS data channel wrapper)
  p2pSend?: (payload: any) => void;
  subscribePeerData?: (cb: (payload: any) => void) => () => void;
  onHostResetRoom?: () => void;
}

interface ActiveMatchArenaProps {
  session: ActiveMatchSession;
  customEditorCode: string;
  savedBotCode: string;
  hasSavedBot: boolean;
  themeMode: 'halloween' | 'standard';
  onExit: () => void;
  onOpenReplay: (replay: any, p1: string, p2: string) => void;
}

interface MoveLogEntry {
  step: number;
  text: string;
  isCapture?: boolean;
  elapsedMs?: number;
}

interface SignedAttestation {
  payload: any;
  signature: string;
}

interface ConsensusStepRecord {
  stepCount: number;
  player: 1 | 2;
  move: { from: number; to: number };
  nonce: string;
  commit: string;
  stateHash: string;
  commitAttestation: SignedAttestation | null;
  revealAttestation: SignedAttestation | null;
  acknowledgements: SignedAttestation[];
}

interface TechnicalResolution {
  winner: 0 | 1 | 2;
  reasonCode: string;
  message: string;
}

function describeDrawReason(reason?: DrawReason | null): string {
  if (reason === 'threefold-repetition') return 'Hòa cờ do lặp lại thế cờ 3 lần';
  if (reason === 'fifty-move-rule') return 'Hòa cờ do 50 nước liên tiếp không ăn quân';
  if (reason === 'stalemate') return 'Hòa cờ do bên tới lượt không còn nước đi hợp lệ';
  return 'Ván đấu kết thúc với kết quả Hòa';
}

export const ActiveMatchArena: React.FC<ActiveMatchArenaProps> = ({
  session,
  customEditorCode,
  savedBotCode,
  hasSavedBot,
  themeMode,
  onExit,
  onOpenReplay,
}) => {
  const { notify } = useToast();

  const [gameState, setGameState] = useState<GameState>(() =>
    OTTGameEngine.createGame(session.seed, session.pieceCount, session.rules)
  );
  const stateRef = useRef<GameState>(gameState);
  stateRef.current = gameState;

  const initialSerializedRef = useRef<any>(
    OTTGameEngine.serialize(
      OTTGameEngine.createGame(session.seed, session.pieceCount, session.rules)
    )
  );

  const [selectedCell, setSelectedCell] = useState<number | null>(null);
  const [validMoves, setValidMoves] = useState<ValidMove[]>([]);
  const [logs, setLogs] = useState<MoveLogEntry[]>([]);
  const [leavingMatch, setLeavingMatch] = useState(false);
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);

  // Bot Ready State (for online Bot vs Bot)
  const isBotMatch = session.mode === 'bot' && session.mySeat !== null;
  const isTournamentBotMatch = Boolean(session.tournamentId) && isBotMatch;
  const [selectedBotSource, setSelectedBotSource] = useState<string>(
    hasSavedBot ? 'saved' : 'phantom_hunter'
  );
  const [myBotReady, setMyBotReady] = useState(!isBotMatch);
  const [peerBotReady, setPeerBotReady] = useState(!isBotMatch);
  const [loadingPyodide, setLoadingPyodide] = useState(false);
  const [botThinking, setBotThinking] = useState(false);
  const [setupRemainingSec, setSetupRemainingSec] = useState(15);

  // Consensus Cryptographic State
  const identityRef = useRef<ConsensusIdentity | null>(null);
  const peerPubKeyRef = useRef<CryptoKey | null>(null);
  const [consensusReady, setConsensusReady] = useState(session.mySeat === null);
  const pendingPeerCommitRef = useRef<{
    stepCount: number;
    hash: string;
    attestation: SignedAttestation;
  } | null>(null);
  const consensusStepsRef = useRef<ConsensusStepRecord[]>([]);
  const pendingPeerAcksRef = useRef(new Map<number, SignedAttestation>());
  const reconcilePendingPeerAckRef = useRef<(stepCount: number) => void>(() => {});
  const [ackedStepCount, setAckedStepCount] = useState<number>(0);
  const replayMovesRef = useRef<any[]>([]);
  const myFinalProofRef = useRef<{ proof: any; signature: string } | null>(null);
  const peerFinalProofRef = useRef<{ proof: any; signature: string } | null>(null);
  const submittedResultRef = useRef(false);
  const disputeSentRef = useRef(false);
  const resolvedRef = useRef(false);
  const botRunnerRef = useRef<BotRunner | null>(null);
  const steppingBotRef = useRef(false);
  const packetQueueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(
    () => () => {
      botRunnerRef.current?.destroy();
      botRunnerRef.current = null;
    },
    []
  );

  // Technical resolution (forfeit / disconnect / timeout / hash dispute)
  const [technicalResolution, setTechnicalResolution] = useState<TechnicalResolution | null>(null);

  // Post-match result summary
  const [resultSummary, setResultSummary] = useState<{
    eloBefore?: number;
    eloAfter?: number;
    eloUpdated?: boolean;
    tournamentUpdate?: { tier: string; stars: number; seasonPoints: number; phase: string } | null;
    verified?: boolean;
  } | null>(null);

  const effectiveWinner: 0 | 1 | 2 | null =
    technicalResolution !== null ? technicalResolution.winner : gameState.winner;
  const isMatchFinished =
    technicalResolution !== null || OTTGameEngine.isGameOver(gameState);

  const sendMessageToPeer = useCallback(
    (payload: unknown) => {
      if (session.source === 'backend') {
        try {
          backendClient.sendPeerMessage(session.matchId, payload, true);
        } catch {
          // Socket may be closing during resolution
        }
      } else if (session.p2pSend) {
        session.p2pSend(payload);
      }
    },
    [session]
  );

  const applyTechnicalOutcome = useCallback(
    (
      winnerSeat: 0 | 1 | 2,
      reasonCode: string,
      message: string,
      summary?: {
        eloBefore?: number;
        eloAfter?: number;
        eloUpdated?: boolean;
        tournamentUpdate?: {
          tier: string;
          stars: number;
          seasonPoints: number;
          phase: string;
        } | null;
      }
    ) => {
      if (resolvedRef.current) return;
      resolvedRef.current = true;
      submittedResultRef.current = true;
      botRunnerRef.current?.destroy();
      setTechnicalResolution({ winner: winnerSeat, reasonCode, message });
      if (summary) {
        setResultSummary({
          eloBefore: summary.eloBefore,
          eloAfter: summary.eloAfter,
          eloUpdated: summary.eloUpdated,
          tournamentUpdate: summary.tournamentUpdate || null,
          verified: true,
        });
      }
      if (session.mySeat !== null) {
        if (winnerSeat === session.mySeat) {
          soundFx.playVictory();
          notify(message, 'success');
        } else if (winnerSeat === 0) {
          notify(message, 'info');
        } else {
          soundFx.playDefeat();
          notify(message, 'error');
        }
      } else {
        notify(message, 'info');
      }
    },
    [notify, session.mySeat]
  );

  // Raise signed consensus dispute to backend when peer sends bad hash / illegal move / conflicting proof
  const raiseConsensusDispute = useCallback(
    async (params: {
      faultType: 'state-ack-mismatch' | 'reveal-fault' | 'final-proof-mismatch';
      stepCount: number;
      disputedStep?: ConsensusStepRecord;
      disputedReveal?: SignedAttestation;
      commitAttestation?: SignedAttestation | null;
      disputedFinalProof?: { seat: number; proof: any; signature: string };
      localHash?: string;
      remoteHash?: string;
    }) => {
      if (disputeSentRef.current || resolvedRef.current || session.mySeat === null) return;
      disputeSentRef.current = true;

      if (session.source !== 'backend' || !identityRef.current) {
        const oppSeat = session.mySeat;
        applyTechnicalOutcome(
          oppSeat,
          params.faultType,
          'Phát hiện dữ liệu đồng thuận hoặc mã băm trạng thái sai lệch từ đối thủ — Xử thắng kỹ thuật!'
        );
        return;
      }

      try {
        const priorMoves =
          params.faultType === 'final-proof-mismatch'
            ? consensusStepsRef.current.map((s) => ({
                stepCount: s.stepCount,
                player: s.player,
                move: s.move,
                nonce: s.nonce,
                commit: s.commit,
                stateHash: s.stateHash,
                commitAttestation: s.commitAttestation,
                revealAttestation: s.revealAttestation,
                acknowledgements: s.acknowledgements,
              }))
            : consensusStepsRef.current
                .filter(
                  (s) =>
                    s.acknowledgements.length === 2 &&
                    (!params.disputedStep || s.stepCount < params.disputedStep.stepCount)
                )
                .map((s) => ({
                  stepCount: s.stepCount,
                  player: s.player,
                  move: s.move,
                  nonce: s.nonce,
                  commit: s.commit,
                  stateHash: s.stateHash,
                  commitAttestation: s.commitAttestation,
                  revealAttestation: s.revealAttestation,
                  acknowledgements: s.acknowledgements,
                }));

        const evidence: Record<string, unknown> = {
          format: 'ottv2-consensus-dispute-v1',
          matchId: session.matchId,
          seed: session.seed,
          initialState: initialSerializedRef.current,
          moves: priorMoves,
          faultType: params.faultType,
          ...(params.disputedStep ? { disputedStep: params.disputedStep } : {}),
          ...(params.disputedReveal ? { disputedReveal: params.disputedReveal } : {}),
          ...(params.commitAttestation ? { commitAttestation: params.commitAttestation } : {}),
          ...(params.disputedFinalProof ? { disputedFinalProof: params.disputedFinalProof } : {}),
        };

        const evidenceHash = await digest(evidence);
        const reportPayload: Record<string, unknown> = {
          kind: 'consensus-dispute',
          matchId: session.matchId,
          claimantSeat: session.mySeat,
          stepCount: params.stepCount,
          evidenceHash,
          ...(params.faultType === 'state-ack-mismatch'
            ? { localHash: params.localHash, remoteHash: params.remoteHash }
            : {}),
        };
        const signature = await signPayload(identityRef.current, reportPayload);
        const res = await backendClient.submitConsensusDispute({
          report: { payload: reportPayload, signature },
          evidence,
        });

        if (res?.resolved && res?.winnerPlayer) {
          applyTechnicalOutcome(
            res.winnerPlayer as 1 | 2,
            res.reason || params.faultType,
            res.message ||
              'Phát hiện sai lệch mã băm trạng thái (Hash Mismatch) từ đối thủ — Bạn được xử thắng kỹ thuật ngay lập tức!',
            {
              eloBefore: res.eloBefore,
              eloAfter: res.eloAfter,
              eloUpdated: res.eloUpdated,
              tournamentUpdate: res.tournamentUpdate || null,
            }
          );
        }
      } catch (err: any) {
        disputeSentRef.current = false;
        notify(err.message || 'Không thể gửi biên bản phân xử đồng thuận.', 'error');
      }
    },
    [applyTechnicalOutcome, notify, session.matchId, session.mySeat, session.seed, session.source]
  );

  // Submit result once both signed final proofs arrive
  const trySubmitBackendResult = useCallback(async () => {
    if (
      session.source !== 'backend' ||
      session.mySeat === null ||
      submittedResultRef.current ||
      resolvedRef.current ||
      !myFinalProofRef.current ||
      !peerFinalProofRef.current
    ) {
      return;
    }
    submittedResultRef.current = true;
    resolvedRef.current = true;
    const p1Proof = session.mySeat === 1 ? myFinalProofRef.current : peerFinalProofRef.current;
    const p2Proof = session.mySeat === 2 ? myFinalProofRef.current : peerFinalProofRef.current;

    const replayPayload = {
      format: 'ottv2-replay-v1',
      matchId: session.matchId,
      seed: session.seed,
      initialState: initialSerializedRef.current,
      moves: replayMovesRef.current,
    };

    try {
      const res = await backendClient.submitMatchResult({
        matchId: session.matchId,
        proofs: { player1: p1Proof, player2: p2Proof },
        replay: replayPayload,
      });
      const myEloObj = session.mySeat === 1 ? res.elo?.player1 : res.elo?.player2;
      setResultSummary({
        eloBefore: myEloObj?.before,
        eloAfter: myEloObj?.after,
        eloUpdated: res.eloUpdated,
        tournamentUpdate: res.tournamentUpdate || null,
        verified: true,
      });
      notify('Kết quả trận đấu đã được xác minh chữ ký P-256 và lưu lên hệ thống!', 'success');
    } catch (err: any) {
      submittedResultRef.current = false;
      resolvedRef.current = false;
      notify(err.message || 'Không thể gửi kết quả xác minh lên máy chủ.', 'error');
    }
  }, [notify, session]);

  const signAndBroadcastFinalProof = useCallback(
    async (finalState: GameState) => {
      if (
        !identityRef.current ||
        session.mySeat === null ||
        !OTTGameEngine.isGameOver(finalState)
      ) {
        return;
      }
      const stateHash = await hashState(finalState);
      const proof = {
        matchId: session.matchId,
        roomId: session.matchId,
        stepCount: finalState.stepCount,
        stateHash,
        winner: finalState.winner,
      };
      const signature = await signPayload(identityRef.current, proof);
      myFinalProofRef.current = { proof, signature };
      sendMessageToPeer({
        type: 'FINAL_PROOF',
        seat: session.mySeat,
        proof,
        signature,
      });
      await trySubmitBackendResult();
    },
    [sendMessageToPeer, session.matchId, session.mySeat, trySubmitBackendResult]
  );

  // Propose our own move (Human click or Local BotRunner output)
  const proposeMyMove = useCallback(
    async (move: { from: number; to: number }, elapsedMs?: number) => {
      const current = stateRef.current;
      if (
        !identityRef.current ||
        session.mySeat === null ||
        resolvedRef.current ||
        OTTGameEngine.isGameOver(current) ||
        current.turn !== session.mySeat ||
        ackedStepCount < current.stepCount
      ) {
        return false;
      }

      const stepIdx = current.stepCount;
      const nonce = createNonce();
      const commit = await hashMove({
        matchId: session.matchId,
        stepCount: stepIdx,
        player: session.mySeat,
        move: { from: move.from, to: move.to },
        nonce,
      });

      const commitPayload = {
        kind: 'move-commit',
        matchId: session.matchId,
        stepCount: stepIdx,
        player: session.mySeat,
        hash: commit,
      };
      const commitSig = await signPayload(identityRef.current, commitPayload);
      const commitAttestation: SignedAttestation = {
        payload: commitPayload,
        signature: commitSig,
      };
      sendMessageToPeer({
        type: 'CONSENSUS_COMMIT',
        attestation: commitAttestation,
      });

      const revealPayload = {
        kind: 'move-reveal',
        matchId: session.matchId,
        stepCount: stepIdx,
        player: session.mySeat,
        move: { from: move.from, to: move.to },
        nonce,
        commit,
      };
      const revealSig = await signPayload(identityRef.current, revealPayload);
      const revealAttestation: SignedAttestation = {
        payload: revealPayload,
        signature: revealSig,
      };

      const nextState = OTTGameEngine.applyMove(current, { from: move.from, to: move.to });
      const stateHash = await hashState(nextState);
      const ackPayload = {
        kind: 'state-ack',
        matchId: session.matchId,
        stepCount: nextState.stepCount,
        player: session.mySeat,
        moveCommit: commit,
        stateHash,
      };
      const ackSig = await signPayload(identityRef.current, ackPayload);
      const myAckAttestation: SignedAttestation = {
        payload: ackPayload,
        signature: ackSig,
      };

      consensusStepsRef.current.push({
        stepCount: nextState.stepCount,
        player: session.mySeat,
        move: { from: move.from, to: move.to },
        nonce,
        commit,
        stateHash,
        commitAttestation,
        revealAttestation,
        acknowledgements: [myAckAttestation],
      });
      reconcilePendingPeerAckRef.current(nextState.stepCount);

      replayMovesRef.current.push({
        stepCount: nextState.stepCount,
        player: session.mySeat,
        move: { from: move.from, to: move.to },
        nonce,
        commit,
        stateHash,
      });

      stateRef.current = nextState;
      setGameState(nextState);
      setSelectedCell(null);
      setValidMoves([]);

      if (nextState.lastMove?.isAttack) soundFx.playCapture();
      else soundFx.playMove();

      const pName = nextState.lastMove ? PIECE_VIET_NAMES[nextState.lastMove.piece] : 'Quân';
      setLogs((prev) => [
        ...prev,
        {
          step: nextState.stepCount,
          text: `P${session.mySeat} ${pName} ${OTTGameEngine.toAlgebraic(
            move.from
          )} → ${OTTGameEngine.toAlgebraic(move.to)}${
            nextState.lastMove?.isAttack ? ' · Ăn quân' : ''
          }`,
          isCapture: nextState.lastMove?.isAttack,
          elapsedMs,
        },
      ]);

      sendMessageToPeer({
        type: 'CONSENSUS_REVEAL',
        attestation: revealAttestation,
      });
      sendMessageToPeer({
        type: 'CONSENSUS_ACK',
        attestation: myAckAttestation,
      });

      if (OTTGameEngine.isGameOver(nextState)) {
        if (nextState.winner === session.mySeat) soundFx.playVictory();
        else if (nextState.winner && nextState.winner !== session.mySeat) soundFx.playDefeat();
        await signAndBroadcastFinalProof(nextState);
      }
      return true;
    },
    [ackedStepCount, sendMessageToPeer, session.matchId, session.mySeat, signAndBroadcastFinalProof]
  );

  // Setup Consensus Identity, Sequential Peer Message Queue & Server Adjudication Listeners
  useEffect(() => {
    let active = true;
    let helloInterval: ReturnType<typeof setInterval> | null = null;

    (async () => {
      if (session.mySeat !== null) {
        const id = identityRef.current || await generateIdentity();
        if (!active) return;
        identityRef.current = id;
        if (peerPubKeyRef.current) setConsensusReady(true);
        if (session.source === 'backend') {
          try {
            backendClient.registerSessionKey(session.matchId, id.publicJwk);
          } catch {
            // ignore if socket reconnecting
          }
        }
        const sendHello = () => {
          sendMessageToPeer({
            type: 'CONSENSUS_HELLO',
            seat: session.mySeat,
            publicKey: id.publicJwk,
            autoStart: !isBotMatch,
          });
        };
        sendHello();
        helloInterval = setInterval(() => {
          if (!peerPubKeyRef.current && !resolvedRef.current) sendHello();
          else if (helloInterval) clearInterval(helloInterval);
        }, 1000);
      }
    })();

    const processPeerPacket = async (packet: any) => {
      if (!active || !packet || resolvedRef.current) return;

      if (packet.type === 'PLAYER_FORFEIT' && packet.seat !== session.mySeat) {
        const winnerSeat: 1 | 2 = packet.seat === 1 ? 2 : 1;
        applyTechnicalOutcome(
          winnerSeat,
          packet.reason || 'player-left-match',
          packet.reason === 'bot-fault'
            ? 'Bot của đối thủ gặp lỗi hoặc quá thời gian (TLE) — Bạn được xử thắng kỹ thuật ngay lập tức!'
            : 'Đối thủ đã thoát khỏi bàn đấu — Bạn được xử thắng kỹ thuật ngay lập tức!'
        );
        return;
      }

      if (packet.type === 'SPECTATE_SYNC' && packet.serializedState) {
        const synced = OTTGameEngine.deserialize(packet.serializedState);
        stateRef.current = synced;
        setGameState(synced);
        return;
      }

      if (packet.type === 'CONSENSUS_HELLO' && packet.publicKey && packet.seat !== session.mySeat) {
        if (!peerPubKeyRef.current) {
          try {
            peerPubKeyRef.current = await importPublicKey(packet.publicKey);
            if (identityRef.current) setConsensusReady(true);
          } catch (err) {
            console.error('Failed to import peer public key from CONSENSUS_HELLO:', err);
          }
        }
        if (identityRef.current && session.mySeat !== null && !packet.isAck) {
          sendMessageToPeer({
            type: 'CONSENSUS_HELLO',
            seat: session.mySeat,
            publicKey: identityRef.current.publicJwk,
            autoStart: !isBotMatch,
            isAck: true,
          });
        }
        return;
      }

      if (packet.type === 'BOT_READY') {
        setPeerBotReady(true);
        return;
      }

      if (packet.type === 'CONSENSUS_COMMIT' && packet.attestation) {
        const payload = packet.attestation.payload;
        if (!payload || payload.player === session.mySeat) return;
        if (peerPubKeyRef.current) {
          const validCommitSig = await verifyPayload(
            peerPubKeyRef.current,
            payload,
            packet.attestation.signature
          );
          if (!validCommitSig) return;
        }
        pendingPeerCommitRef.current = {
          stepCount: payload.stepCount,
          hash: payload.hash,
          attestation: packet.attestation,
        };
        return;
      }

      if (packet.type === 'CONSENSUS_REVEAL' && packet.attestation) {
        const payload = packet.attestation.payload;
        if (!payload || payload.player === session.mySeat) return;
        const curr = stateRef.current;
        if (payload.stepCount !== curr.stepCount) return;

        if (peerPubKeyRef.current) {
          const validSig = await verifyPayload(
            peerPubKeyRef.current,
            payload,
            packet.attestation.signature
          );
          if (!validSig) {
            notify('Phát hiện chữ ký nước đi không hợp lệ từ đối thủ!', 'error');
            return;
          }
        }

        const priorCommit =
          pendingPeerCommitRef.current?.stepCount === curr.stepCount
            ? pendingPeerCommitRef.current
            : null;

        if (priorCommit && priorCommit.hash !== payload.commit) {
          await raiseConsensusDispute({
            faultType: 'reveal-fault',
            stepCount: curr.stepCount + 1,
            disputedReveal: packet.attestation,
            commitAttestation: priorCommit.attestation,
          });
          return;
        }

        const expectedCommit = await hashMove({
          matchId: session.matchId,
          stepCount: curr.stepCount,
          player: payload.player,
          move: payload.move,
          nonce: payload.nonce,
        });
        if (expectedCommit !== payload.commit) {
          await raiseConsensusDispute({
            faultType: 'reveal-fault',
            stepCount: curr.stepCount + 1,
            disputedReveal: packet.attestation,
            commitAttestation: priorCommit?.attestation || null,
          });
          return;
        }

        let nextState: GameState;
        try {
          nextState = OTTGameEngine.applyMove(curr, {
            from: payload.move.from,
            to: payload.move.to,
          });
        } catch {
          await raiseConsensusDispute({
            faultType: 'reveal-fault',
            stepCount: curr.stepCount + 1,
            disputedReveal: packet.attestation,
            commitAttestation: priorCommit?.attestation || null,
          });
          return;
        }

        const stateHash = await hashState(nextState);
        const acknowledgements: SignedAttestation[] = [];

        if (identityRef.current && session.mySeat !== null) {
          const ackPayload = {
            kind: 'state-ack',
            matchId: session.matchId,
            stepCount: nextState.stepCount,
            player: session.mySeat,
            moveCommit: payload.commit,
            stateHash,
          };
          const ackSig = await signPayload(identityRef.current, ackPayload);
          const myAck: SignedAttestation = { payload: ackPayload, signature: ackSig };
          acknowledgements.push(myAck);
          sendMessageToPeer({
            type: 'CONSENSUS_ACK',
            attestation: myAck,
          });
        }

        consensusStepsRef.current.push({
          stepCount: nextState.stepCount,
          player: payload.player,
          move: { from: payload.move.from, to: payload.move.to },
          nonce: payload.nonce,
          commit: payload.commit,
          stateHash,
          commitAttestation: priorCommit?.attestation || null,
          revealAttestation: packet.attestation,
          acknowledgements,
        });
        reconcilePendingPeerAckRef.current(nextState.stepCount);
        pendingPeerCommitRef.current = null;

        replayMovesRef.current.push({
          stepCount: nextState.stepCount,
          player: payload.player,
          move: { from: payload.move.from, to: payload.move.to },
          nonce: payload.nonce,
          commit: payload.commit,
          stateHash,
        });

        stateRef.current = nextState;
        setGameState(nextState);

        if (nextState.lastMove?.isAttack) soundFx.playCapture();
        else soundFx.playMove();

        const pName = nextState.lastMove ? PIECE_VIET_NAMES[nextState.lastMove.piece] : 'Quân';
        setLogs((prev) => [
          ...prev,
          {
            step: nextState.stepCount,
            text: `P${payload.player} ${pName} ${OTTGameEngine.toAlgebraic(
              payload.move.from
            )} → ${OTTGameEngine.toAlgebraic(payload.move.to)}${
              nextState.lastMove?.isAttack ? ' · Ăn quân' : ''
            }`,
            isCapture: nextState.lastMove?.isAttack,
          },
        ]);

        if (OTTGameEngine.isGameOver(nextState)) {
          if (nextState.winner === session.mySeat) soundFx.playVictory();
          else if (nextState.winner && nextState.winner !== session.mySeat) soundFx.playDefeat();
          await signAndBroadcastFinalProof(nextState);
        }
        return;
      }

      if (packet.type === 'CONSENSUS_ACK' && packet.attestation) {
        const ackPayload = packet.attestation.payload;
        const peerSeat = session.mySeat === 1 ? 2 : 1;
        if (
          !ackPayload ||
          ackPayload.matchId !== session.matchId ||
          ackPayload.player !== peerSeat ||
          !Number.isSafeInteger(ackPayload.stepCount) ||
          ackPayload.stepCount < 1 ||
          typeof ackPayload.moveCommit !== 'string' ||
          typeof ackPayload.stateHash !== 'string' ||
          typeof packet.attestation.signature !== 'string' ||
          !peerPubKeyRef.current
        ) return;

        const validSig = await verifyPayload(
          peerPubKeyRef.current,
          ackPayload,
          packet.attestation.signature
        );
        if (!validSig) return;

        const stepEntry = consensusStepsRef.current.find(
          (s) => s.stepCount === ackPayload.stepCount
        );
        if (!stepEntry) {
          pendingPeerAcksRef.current.set(ackPayload.stepCount, packet.attestation);
          return;
        }
        if (ackPayload.moveCommit !== stepEntry.commit) return;

        if (ackPayload.stateHash !== stepEntry.stateHash) {
          const combinedAcks = [
            ...stepEntry.acknowledgements.filter((a) => a.payload?.player !== ackPayload.player),
            packet.attestation,
          ];
          await raiseConsensusDispute({
            faultType: 'state-ack-mismatch',
            stepCount: stepEntry.stepCount,
            disputedStep: {
              ...stepEntry,
              acknowledgements: combinedAcks,
            },
            localHash: stepEntry.stateHash,
            remoteHash: ackPayload.stateHash,
          });
          return;
        }

        if (!stepEntry.acknowledgements.some((a) => a.payload?.player === ackPayload.player)) {
          stepEntry.acknowledgements.push(packet.attestation);
        }
        setAckedStepCount((previous) => {
          let contiguousStepCount = previous;
          while (true) {
            const nextStep = consensusStepsRef.current.find(
              (entry) => entry.stepCount === contiguousStepCount + 1
            );
            if (
              !nextStep?.acknowledgements.some((ack) => ack.payload?.player === 1) ||
              !nextStep.acknowledgements.some((ack) => ack.payload?.player === 2)
            ) {
              break;
            }
            contiguousStepCount += 1;
          }
          return contiguousStepCount;
        });
        return;
      }

      if (packet.type === 'FINAL_PROOF' && packet.seat !== session.mySeat) {
        if (!packet.proof || typeof packet.signature !== 'string') return;
        if (peerPubKeyRef.current) {
          const validSig = await verifyPayload(
            peerPubKeyRef.current,
            packet.proof,
            packet.signature
          );
          if (!validSig) return;
        }

        if (!myFinalProofRef.current && OTTGameEngine.isGameOver(stateRef.current)) {
          await signAndBroadcastFinalProof(stateRef.current);
        }

        const mine = myFinalProofRef.current?.proof;
        if (
          mine &&
          (packet.proof.stateHash !== mine.stateHash ||
            packet.proof.stepCount !== mine.stepCount ||
            packet.proof.winner !== mine.winner)
        ) {
          await raiseConsensusDispute({
            faultType: 'final-proof-mismatch',
            stepCount: mine.stepCount,
            disputedFinalProof: {
              seat: packet.seat,
              proof: packet.proof,
              signature: packet.signature,
            },
          });
          return;
        }

        peerFinalProofRef.current = { proof: packet.proof, signature: packet.signature };
        await trySubmitBackendResult();
      }
    };

    const enqueuePeerPacket = (pkt: any) => {
      packetQueueRef.current = packetQueueRef.current
        .then(() => processPeerPacket(pkt))
        .catch((err) => console.error('Consensus packet processing error:', err));
    };
    reconcilePendingPeerAckRef.current = (stepCount) => {
      const attestation = pendingPeerAcksRef.current.get(stepCount);
      if (!attestation) return;
      pendingPeerAcksRef.current.delete(stepCount);
      enqueuePeerPacket({ type: 'CONSENSUS_ACK', attestation });
    };

    const unsubPeerData =
      session.source === 'backend'
        ? backendClient.on('peer-data', enqueuePeerPacket)
        : session.subscribePeerData
        ? session.subscribePeerData(enqueuePeerPacket)
        : () => {};

    const unsubPeerKey =
      session.source === 'backend'
        ? backendClient.on('peer-session-key', async (pkt) => {
            if (!active || pkt?.matchId !== session.matchId || !pkt?.publicKey) return;
            if (!peerPubKeyRef.current) {
              try {
                peerPubKeyRef.current = await importPublicKey(pkt.publicKey);
                if (identityRef.current) setConsensusReady(true);
              } catch {
                // ignore
              }
            }
          })
        : () => {};

    const unsubForfeited =
      session.source === 'backend'
        ? backendClient.on('match-forfeited', (pkt) => {
            if (!active || pkt?.matchId !== session.matchId) return;
            applyTechnicalOutcome(
              pkt.winnerPlayer as 1 | 2,
              pkt.reason || 'forfeit',
              pkt.message ||
                (pkt.winnerPlayer === session.mySeat
                  ? 'Đối thủ vi phạm hoặc rời trận — Bạn được xử thắng kỹ thuật!'
                  : 'Bạn bị xử thua kỹ thuật.'),
              {
                eloBefore: pkt.eloBefore,
                eloAfter: pkt.eloAfter,
                eloUpdated: pkt.eloUpdated,
                tournamentUpdate: pkt.tournamentUpdate || null,
              }
            );
          })
        : () => {};

    const unsubDisputeResult =
      session.source === 'backend'
        ? backendClient.on('match-dispute-result', (pkt) => {
            if (!active || pkt?.matchId !== session.matchId) return;
            if (pkt.resolved && pkt.winnerPlayer) {
              applyTechnicalOutcome(
                pkt.winnerPlayer as 1 | 2,
                pkt.reason || 'consensus-dispute',
                pkt.message ||
                  (pkt.winnerPlayer === session.mySeat
                    ? 'Trọng tài máy chủ xác nhận đối thủ sai lệch dữ liệu — Bạn được xử thắng kỹ thuật!'
                    : 'Bạn bị xử thua do sai lệch dữ liệu đồng thuận.'),
                {
                  eloBefore: pkt.eloBefore,
                  eloAfter: pkt.eloAfter,
                  eloUpdated: pkt.eloUpdated,
                  tournamentUpdate: pkt.tournamentUpdate || null,
                }
              );
            } else {
              notify(pkt.message || 'Trận đấu đã đóng để kiểm tra biên bản.', 'info');
              onExit();
            }
          })
        : () => {};

    const unsubAborted =
      session.source === 'backend'
        ? backendClient.on('match-aborted', (pkt) => {
            if (pkt?.matchId && pkt.matchId !== session.matchId) return;
            resolvedRef.current = true;
            notify(pkt.message || 'Trận đấu đã bị hủy.', 'error');
            onExit();
          })
        : () => {};

    return () => {
      active = false;
      reconcilePendingPeerAckRef.current = () => {};
      if (helloInterval) clearInterval(helloInterval);
      unsubPeerData();
      unsubPeerKey();
      unsubForfeited();
      unsubDisputeResult();
      unsubAborted();
    };
  }, [
    applyTechnicalOutcome,
    isBotMatch,
    notify,
    onExit,
    raiseConsensusDispute,
    sendMessageToPeer,
    session,
    signAndBroadcastFinalProof,
    trySubmitBackendResult,
  ]);

  // Auto-load & Auto-ready submitted Bot in ALL online Bot vs Bot matches (Tournament, Arena, Private Room)
  useEffect(() => {
    if (!isBotMatch || myBotReady) return;
    let cancelled = false;
    setLoadingPyodide(true);

    (async () => {
      try {
        const code = (
          session.lockedBotCode ||
          savedBotCode ||
          customEditorCode ||
          SAMPLE_BOTS.phantom_hunter
        ).trim();

        if (!code) {
          throw new Error('Không tìm thấy mã nguồn Bot để khởi chạy.');
        }

        const botLabel = session.tournamentId
          ? (session.lockedBotVersion ? `Giải đấu v${session.lockedBotVersion}` : 'Bot Giải đấu')
          : session.lockedBotVersion
          ? `Bot v${session.lockedBotVersion}`
          : savedBotCode.trim()
          ? 'Bot của bạn'
          : 'Phantom Hunter (Mẫu)';

        const runner = new BotRunner(botLabel, BOT_MATCH_TLE_MS);
        await runner.loadBot(code, botLabel);
        if (cancelled) {
          runner.destroy();
          return;
        }
        botRunnerRef.current = runner;
        setMyBotReady(true);
      } catch (err: any) {
        if (cancelled) return;
        const msg = err.message || 'Không thể khởi tạo Bot Python.';
        notify(`Lỗi nạp Bot: ${msg}`, 'error');
        if (session.source === 'backend') {
          backendClient.abortBotSetup(session.matchId, msg);
        }
      } finally {
        if (!cancelled) setLoadingPyodide(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    customEditorCode,
    isBotMatch,
    myBotReady,
    notify,
    savedBotCode,
    session.lockedBotCode,
    session.lockedBotVersion,
    session.matchId,
    session.source,
    session.tournamentId,
  ]);

  // Broadcast BOT_READY reliably once both our Bot and P-256 session keys are ready
  useEffect(() => {
    if (!isBotMatch || !myBotReady || !consensusReady || isMatchFinished) return;
    sendMessageToPeer({ type: 'BOT_READY' });
    if (peerBotReady) return;

    const timer = setInterval(() => {
      if (!resolvedRef.current) {
        sendMessageToPeer({ type: 'BOT_READY' });
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [consensusReady, isBotMatch, isMatchFinished, myBotReady, peerBotReady, sendMessageToPeer]);

  // Setup countdown display for non-tournament Bot-vs-Bot matches
  useEffect(() => {
    if (!isBotMatch || (myBotReady && peerBotReady) || isMatchFinished) return;
    const timer = setInterval(() => {
      setSetupRemainingSec((s) => Math.max(0, s - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [isBotMatch, isMatchFinished, myBotReady, peerBotReady]);

  // Retry our signed ACK until the peer's ACK confirms it received the step.
  useEffect(() => {
    if (
      session.source !== 'backend' ||
      session.mySeat === null ||
      isMatchFinished
    ) {
      return;
    }

    const timer = setInterval(() => {
      const stepCount = ackedStepCount + 1;
      const step = consensusStepsRef.current.find((entry) => entry.stepCount === stepCount);
      const acknowledgement = step?.acknowledgements.find(
        (entry) => entry.payload?.player === session.mySeat
      );
      if (acknowledgement) {
        sendMessageToPeer({ type: 'CONSENSUS_ACK', attestation: acknowledgement });
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [
    ackedStepCount,
    isMatchFinished,
    sendMessageToPeer,
    session.mySeat,
    session.source,
  ]);

  // Server-authoritative Stall / Withheld-ACK / Turn-Timeout Watchdog
  useEffect(() => {
    if (
      session.source !== 'backend' ||
      session.mySeat === null ||
      session.isSparring ||
      isMatchFinished
    ) {
      return;
    }

    const timer = setInterval(async () => {
      if (resolvedRef.current) return;
      const curr = stateRef.current;
      const waitingOnSetup = !consensusReady || !peerBotReady;
      const waitingOnAck = ackedStepCount < curr.stepCount;
      const waitingOnFinalProof =
        OTTGameEngine.isGameOver(curr) &&
        Boolean(myFinalProofRef.current) &&
        !peerFinalProofRef.current;
      const waitingOnOpponentTurn =
        consensusReady &&
        myBotReady &&
        peerBotReady &&
        !OTTGameEngine.isGameOver(curr) &&
        curr.turn !== session.mySeat;

      if (!waitingOnSetup && !waitingOnAck && !waitingOnFinalProof && !waitingOnOpponentTurn) {
        return;
      }

      try {
        const replayPayload = waitingOnFinalProof
          ? {
              format: 'ottv2-replay-v1',
              matchId: session.matchId,
              seed: session.seed,
              initialState: initialSerializedRef.current,
              moves: replayMovesRef.current,
            }
          : undefined;
        await backendClient.claimMatchTimeout(session.matchId, replayPayload);
      } catch {
        // Ignore transient network errors; WS match-forfeited handles resolution
      }
    }, 2000);

    return () => clearInterval(timer);
  }, [
    ackedStepCount,
    consensusReady,
    isMatchFinished,
    myBotReady,
    peerBotReady,
    session.isSparring,
    session.matchId,
    session.mySeat,
    session.seed,
    session.source,
  ]);

  // Immediate forfeit if tab closes / reloads mid-match
  useEffect(() => {
    if (session.mySeat === null || isMatchFinished) return;

    const handlePageUnload = () => {
      if (resolvedRef.current) return;
      if (session.source === 'backend') {
        backendClient.leaveMatchWs(session.matchId);
        if (backendClient.token) {
          fetch(`${backendClient.baseUrl}/api/match/forfeit`, {
            method: 'POST',
            keepalive: true,
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${backendClient.token}`,
            },
            body: JSON.stringify({ matchId: session.matchId }),
          }).catch(() => {});
        }
      } else {
        sendMessageToPeer({
          type: 'PLAYER_FORFEIT',
          seat: session.mySeat,
          reason: 'player-left-match',
        });
      }
    };

    window.addEventListener('pagehide', handlePageUnload);
    window.addEventListener('beforeunload', handlePageUnload);
    return () => {
      window.removeEventListener('pagehide', handlePageUnload);
      window.removeEventListener('beforeunload', handlePageUnload);
    };
  }, [isMatchFinished, sendMessageToPeer, session.matchId, session.mySeat, session.source]);

  // Trigger BotRunner automatically when it's our turn in Bot vs Bot mode
  useEffect(() => {
    if (
      !isBotMatch ||
      !myBotReady ||
      !peerBotReady ||
      !consensusReady ||
      !identityRef.current ||
      !botRunnerRef.current?.ready ||
      isMatchFinished ||
      ackedStepCount < gameState.stepCount ||
      gameState.turn !== session.mySeat ||
      steppingBotRef.current
    ) {
      return;
    }

    steppingBotRef.current = true;
    let started = false;
    const timer = setTimeout(async () => {
      started = true;
      setBotThinking(true);
      try {
        const curr = stateRef.current;
        if (
          resolvedRef.current ||
          OTTGameEngine.isGameOver(curr) ||
          curr.turn !== session.mySeat ||
          !botRunnerRef.current
        ) {
          return;
        }
        const botState = OTTGameEngine.createBotGameState(curr, session.mySeat);
        const moveRes = await botRunnerRef.current.getMove(session.mySeat, botState);
        const moveAccepted = await proposeMyMove(
          { from: moveRes.from, to: moveRes.to },
          moveRes.elapsedMs
        );
        if (!moveAccepted) {
          throw new Error('Nước đi đã tính nhưng phiên đấu chưa sẵn sàng để gửi.');
        }
      } catch (err: any) {
        const errMsg = err.message || 'Runtime/TLE';
        notify(`Bot của bạn gặp lỗi thực thi/TLE: ${errMsg}`, 'error');
        if (session.source === 'backend') {
          backendClient.reportBotFault(session.matchId, errMsg);
        } else if (session.mySeat !== null) {
          sendMessageToPeer({
            type: 'PLAYER_FORFEIT',
            seat: session.mySeat,
            reason: 'bot-fault',
            message: errMsg,
          });
          applyTechnicalOutcome(
            session.mySeat === 1 ? 2 : 1,
            'bot-fault',
            `Bot của bạn gặp lỗi (${errMsg}) nên bị xử thua kỹ thuật.`
          );
        }
      } finally {
        setBotThinking(false);
        steppingBotRef.current = false;
      }
    }, 160);

    return () => {
      clearTimeout(timer);
      if (!started) steppingBotRef.current = false;
    };
  }, [
    ackedStepCount,
    applyTechnicalOutcome,
    consensusReady,
    gameState,
    isBotMatch,
    isMatchFinished,
    myBotReady,
    notify,
    peerBotReady,
    proposeMyMove,
    sendMessageToPeer,
    session.matchId,
    session.mySeat,
    session.source,
  ]);

  const handleConfirmBotReady = async () => {
    setLoadingPyodide(true);
    try {
      let code = '';
      if (selectedBotSource === 'saved') {
        code = savedBotCode;
      } else if (selectedBotSource === 'custom') {
        code = customEditorCode;
      } else {
        code = SAMPLE_BOTS[selectedBotSource as SampleBotKey] || SAMPLE_BOTS.minimax;
      }
      if (!code.trim()) {
        throw new Error('Không tìm thấy mã nguồn Python cho lựa chọn này.');
      }

      const runner = new BotRunner('MatchBot', BOT_MATCH_TLE_MS);
      await runner.loadBot(code, selectedBotSource);
      botRunnerRef.current = runner;
      setMyBotReady(true);
      sendMessageToPeer({ type: 'BOT_READY' });
      notify('Đã nạp Bot Python thành công! Đang đồng bộ khai cuộc…', 'success');
    } catch (err: any) {
      notify(err.message || 'Không thể khởi tạo Bot Python.', 'error');
      if (session.source === 'backend') {
        backendClient.abortBotSetup(session.matchId, err.message || 'Bot init error');
      }
    } finally {
      setLoadingPyodide(false);
    }
  };

  const handleLeaveMatchButton = async () => {
    if (!isMatchFinished && session.mySeat !== null && !resolvedRef.current) {
      setLeaveConfirmOpen(true);
      return;
    }

    onExit();
  };

  const handleConfirmLeaveMatch = async () => {
    if (leavingMatch) return;
    setLeavingMatch(true);
    try {
      if (session.source === 'backend') {
        await backendClient.forfeitMatch(session.matchId);
        resolvedRef.current = true;
        notify('Bạn đã rời bàn khi trận đấu chưa kết thúc và bị xử thua kỹ thuật.', 'error');
      } else {
        resolvedRef.current = true;
        sendMessageToPeer({
          type: 'PLAYER_FORFEIT',
          seat: session.mySeat,
          reason: 'player-left-match',
        });
      }
      setLeaveConfirmOpen(false);
      onExit();
    } catch (err) {
      notify(
        err instanceof Error
          ? `Không thể rời trận: ${err.message}`
          : 'Không thể rời trận do lỗi không xác định.',
        'error'
      );
    } finally {
      setLeavingMatch(false);
    }
  };

  const handleBoardClick = (index: number) => {
    if (
      session.mySeat === null ||
      session.mode === 'bot' ||
      !consensusReady ||
      isMatchFinished ||
      gameState.turn !== session.mySeat
    ) {
      return;
    }

    if (selectedCell !== null) {
      const candidate = validMoves.find((m) => m.to === index);
      if (candidate) {
        proposeMyMove({ from: candidate.from, to: candidate.to });
        return;
      }
    }

    const piece = gameState.board[index];
    const owner = piece ? (piece <= 3 ? 1 : 2) : null;
    if (owner === session.mySeat) {
      soundFx.playSelect();
      setSelectedCell(index);
      setValidMoves(OTTGameEngine.getValidMoves(gameState, index));
    } else {
      setSelectedCell(null);
      setValidMoves([]);
    }
  };

  const counts = OTTGameEngine.countPieces(gameState.board);
  const isMyTurn =
    session.mySeat !== null && gameState.turn === session.mySeat && !isMatchFinished;

  const exportCurrentReplay = () => {
    const replayPayload = {
      format: 'ottv2-replay-v1',
      matchId: session.matchId,
      seed: session.seed,
      initialState: initialSerializedRef.current,
      moves: replayMovesRef.current,
    };
    onOpenReplay(replayPayload, session.player1Name, session.player2Name);
  };

  const downloadReplayFile = () => {
    const replayPayload = {
      format: 'ottv2-replay-v1',
      matchId: session.matchId,
      seed: session.seed,
      initialState: initialSerializedRef.current,
      moves: replayMovesRef.current,
    };
    const blob = new Blob([JSON.stringify(replayPayload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ottv2-match-${session.matchId.slice(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const bannerIsWin =
    session.mySeat !== null && effectiveWinner === session.mySeat;
  const bannerIsDraw = effectiveWinner === 0;

  useEffect(() => {
    if (!session.tournamentId || !isMatchFinished) return;
    const timer = window.setTimeout(onExit, 5000);
    return () => window.clearTimeout(timer);
  }, [isMatchFinished, onExit, session.tournamentId]);

  return (
    <div className="space-y-5">
      {/* Top Match Control Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 p-4 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)]">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleLeaveMatchButton}
            disabled={leavingMatch}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium border border-[var(--border-subtle)] bg-[var(--bg-canvas)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap shrink-0"
          >
            <ArrowLeft className="w-4 h-4" />
            {leavingMatch
              ? 'Đang rời bàn…'
              : isMatchFinished || session.mySeat === null
                ? 'Rời bàn đấu'
                : 'Rời bàn (Chịu thua)'}
          </button>
          <div>
            <div className="flex items-center gap-2 text-sm font-bold text-[var(--text-primary)]">
              <Swords className="w-4 h-4 text-[var(--accent-primary)]" />
              <span>
                {session.mySeat === null
                  ? 'Chế độ Khán giả Trực tiếp'
                  : session.tournamentId
                  ? session.tournamentPhase === 'knockout'
                    ? 'Giải Đấu · Vòng Knock-out (Bot tự động)'
                    : 'Giải Đấu · Vòng Bảng (Bot tự động)'
                  : session.mode === 'bot'
                  ? 'Đấu Trường Bot vs Bot'
                  : 'Đối Kháng Trực Tiếp 1v1'}
              </span>
            </div>
            <div className="text-xs text-[var(--text-secondary)] tabular-nums">
              {session.rules?.title || 'Bàn chuẩn 9×9'} · Seed {session.seed}
              {session.roomCode ? ` · Mã phòng: ${session.roomCode}` : ''}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {session.roomCode && (
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(session.roomCode!);
                notify(`Đã sao chép mã phòng ${session.roomCode}`, 'success');
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-mono border border-[var(--border-subtle)] bg-[var(--bg-canvas)] text-[var(--text-primary)] hover:border-[var(--accent-primary)] cursor-pointer whitespace-nowrap shrink-0"
            >
              <Copy className="w-3.5 h-3.5 text-[var(--accent-primary)]" />
              {session.roomCode}
            </button>
          )}
          <div className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
            <ShieldCheck
              className={`w-4 h-4 ${consensusReady ? 'text-emerald-400' : 'text-amber-400'}`}
            />
            <span>{consensusReady ? 'Đồng thuận P-256 sẵn sàng' : 'Đang bắt tay khóa phiên…'}</span>
          </div>
        </div>
      </div>

      {/* Unified Auto-Bot Readiness Banner for All Bot vs Bot Matches */}
      {isBotMatch && !isMatchFinished && (!myBotReady || !peerBotReady) && (
        <div className="p-5 rounded-2xl border border-[var(--border-accent)] bg-[var(--bg-panel)] flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Loader2 className="w-5 h-5 text-[var(--accent-primary)] animate-spin shrink-0" />
            <div>
              <h3 className="text-sm font-bold text-[var(--text-primary)]">
                {!myBotReady
                  ? 'Đang tự động nạp Bot Python vào Web Worker sandbox…'
                  : 'Bot của bạn đã sẵn sàng! Đang kết nối và đồng bộ với Bot đối thủ…'}
              </h3>
              <p className="text-xs text-[var(--text-secondary)] mt-0.5 tabular-nums">
                {!myBotReady
                  ? 'Hệ thống đang khởi chạy runtime Pyodide và nạp mã nguồn Bot đã lưu…'
                  : 'Đang đợi Bot đối thủ hoàn tất nạp để tự động bắt đầu ván đấu.'}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border ${
                myBotReady
                  ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                  : 'bg-amber-500/10 text-amber-400 border-amber-500/30'
              }`}
            >
              {myBotReady ? '✓ Bot bạn: Sẵn sàng' : '⏳ Bot bạn: Đang nạp…'}
            </span>
            <span
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border ${
                peerBotReady
                  ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                  : 'bg-amber-500/10 text-amber-400 border-amber-500/30'
              }`}
            >
              {peerBotReady ? '✓ Đối thủ: Sẵn sàng' : '⏳ Đối thủ: Đang nạp…'}
            </span>
          </div>
        </div>
      )}

      {/* Main Clean 1v1 Layout: Board Center + Match Log Right */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-8 space-y-4">
          {/* Dual Player HUD */}
          <div className="grid grid-cols-1 sm:grid-cols-11 gap-3 items-center p-4 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)]">
            {/* Player 1 */}
            <div
              className={`sm:col-span-5 p-3 rounded-xl border transition-colors ${
                gameState.turn === 1 && !isMatchFinished
                  ? 'border-[var(--p1-border)] bg-[var(--p1-bg)]'
                  : 'border-[var(--border-subtle)] bg-[var(--bg-canvas)]'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-bold text-[var(--p1-main)] truncate">
                  {session.player1Name} {session.mySeat === 1 ? '(Bạn)' : ''}
                </span>
                {session.player1Elo && (
                  <span className="text-xs font-mono text-[var(--text-secondary)] tabular-nums">
                    {session.player1Elo} Elo
                  </span>
                )}
              </div>
              <div className="mt-1.5">
                <MascotCountsInline counts={counts[1]} team={1} />
              </div>
            </div>

            {/* Turn Center Indicator */}
            <div className="sm:col-span-1 flex flex-col items-center justify-center text-center">
              <span className="text-xs font-mono font-bold text-[var(--text-muted)]">VS</span>
              <span className="text-[11px] font-mono text-[var(--accent-primary)] tabular-nums">
                #{gameState.stepCount}
              </span>
            </div>

            {/* Player 2 */}
            <div
              className={`sm:col-span-5 p-3 rounded-xl border transition-colors ${
                gameState.turn === 2 && !isMatchFinished
                  ? 'border-[var(--p2-border)] bg-[var(--p2-bg)]'
                  : 'border-[var(--border-subtle)] bg-[var(--bg-canvas)]'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-bold text-[var(--p2-main)] truncate">
                  {session.player2Name} {session.mySeat === 2 ? '(Bạn)' : ''}
                </span>
                {session.player2Elo && (
                  <span className="text-xs font-mono text-[var(--text-secondary)] tabular-nums">
                    {session.player2Elo} Elo
                  </span>
                )}
              </div>
              <div className="mt-1.5">
                <MascotCountsInline counts={counts[2]} team={2} />
              </div>
            </div>
          </div>

          {/* Turn Banner / Victory, Draw or Technical Forfeit Banner */}
          {isMatchFinished ? (
            <div
              className={`p-5 rounded-2xl border flex flex-wrap items-center justify-between gap-4 ${
                bannerIsDraw
                  ? 'border-amber-400/40 bg-amber-950/20'
                  : session.mySeat === null || bannerIsWin
                  ? 'border-emerald-500/40 bg-emerald-950/25'
                  : 'border-red-500/40 bg-red-950/25'
              }`}
            >
              <div className="space-y-1">
                <h3
                  className={`text-lg font-bold flex items-center gap-2 ${
                    bannerIsDraw
                      ? 'text-amber-300'
                      : session.mySeat === null || bannerIsWin
                      ? 'text-emerald-300'
                      : 'text-red-300'
                  }`}
                >
                  {technicalResolution && !bannerIsWin && session.mySeat !== null && (
                    <AlertTriangle className="w-5 h-5 shrink-0" />
                  )}
                  <span>
                    {bannerIsDraw
                      ? describeDrawReason(gameState.drawReason)
                      : session.mySeat === null
                      ? `${effectiveWinner === 1 ? session.player1Name : session.player2Name} giành chiến thắng!`
                      : bannerIsWin
                      ? technicalResolution
                        ? 'Chiến thắng kỹ thuật! Đã ghi nhận kết quả cho bạn'
                        : 'Chiến thắng thuyết phục!'
                      : technicalResolution
                      ? 'Xử thua kỹ thuật — Trận đấu đã khép lại'
                      : 'Trận đấu khép lại — Đối thủ thắng!'}
                  </span>
                </h3>

                {technicalResolution && (
                  <p className="text-xs text-[var(--text-primary)]">{technicalResolution.message}</p>
                )}

                <div className="text-xs text-[var(--text-secondary)] tabular-nums">
                  {technicalResolution
                    ? `Kết thúc tại nước #${gameState.stepCount}`
                    : `Hoàn tất sau ${gameState.stepCount} nước đi`}
                  {resultSummary?.eloUpdated &&
                    resultSummary.eloBefore !== undefined &&
                    resultSummary.eloAfter !== undefined && (
                      <>
                        {' · '}Elo: {resultSummary.eloBefore} →{' '}
                        <strong className="text-[var(--text-primary)]">
                          {resultSummary.eloAfter}
                        </strong>{' '}
                        ({resultSummary.eloAfter - resultSummary.eloBefore >= 0 ? '+' : ''}
                        {resultSummary.eloAfter - resultSummary.eloBefore})
                      </>
                    )}

                </div>
                {session.tournamentId && (
                  <p className="text-xs text-[var(--text-muted)]">
                    Tự động quay lại giải sau 5 giây để tiếp tục lịch đấu.
                  </p>
                )}
              </div>

              <div className="flex items-center gap-2.5">
                {gameState.stepCount > 0 && replayMovesRef.current.length > 0 && (
                  <button
                    type="button"
                    onClick={exportCurrentReplay}
                    className="px-4 py-2 rounded-xl text-xs font-semibold border border-[var(--border-subtle)] bg-[var(--bg-panel)] text-[var(--text-primary)] hover:border-[var(--accent-primary)] cursor-pointer whitespace-nowrap shrink-0"
                  >
                    Xem lại Replay
                  </button>
                )}
                {session.source === 'p2p' && session.isHost && session.onHostResetRoom && (
                  <button
                    type="button"
                    onClick={session.onHostResetRoom}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold text-white bg-[var(--accent-primary)] hover:bg-[var(--accent-primary-hover)] cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    Ván mới
                  </button>
                )}
                <button
                  type="button"
                  onClick={onExit}
                  className="px-4 py-2 rounded-xl text-xs font-semibold text-white bg-[var(--accent-primary)] hover:bg-[var(--accent-primary-hover)] cursor-pointer whitespace-nowrap shrink-0"
                >
                  Về sảnh
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between px-4 py-2.5 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-subtle)] text-xs">
              <span className="font-semibold text-[var(--text-primary)]">
                {session.mySeat === null
                  ? `Đang tới lượt: ${gameState.turn === 1 ? session.player1Name : session.player2Name}`
                  : ackedStepCount < gameState.stepCount
                  ? 'Đang đối chiếu xác nhận mã băm trạng thái (ACK) từ đối thủ…'
                  : isMyTurn
                  ? session.mode === 'bot'
                    ? !myBotReady
                      ? 'Đang nạp Bot của bạn…'
                      : !peerBotReady
                      ? 'Đang chờ Bot đối thủ sẵn sàng…'
                      : !consensusReady
                      ? 'Đang đồng bộ khóa xác minh…'
                      : ackedStepCount < gameState.stepCount
                      ? 'Đang xác nhận nước đi trước…'
                      : botThinking
                      ? 'Bot của bạn đang tính toán nước đi…'
                      : 'Bot của bạn đang chuẩn bị nước đi…'
                    : 'Lượt của bạn — Hãy chọn quân cờ để di chuyển'
                  : 'Đang chờ nước đi của đối thủ…'}
              </span>
              <span className="text-[var(--text-secondary)] hidden sm:inline">
                Bí Ngô (Đấm) ăn Dơi (Kéo) · Dơi ăn Bé Ma (Lá) · Bé Ma ăn Bí Ngô
              </span>
            </div>
          )}

          {/* Focused 9x9 Tactical Board */}
          <div className="p-4 sm:p-6 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)]">
            <Board9x9
              state={gameState}
              selectedCell={selectedCell}
              validMoves={validMoves}
              onCellClick={handleBoardClick}
              interactive={isMyTurn && session.mode === 'human'}
              size="large"
              themeMode={themeMode}
            />
          </div>
        </div>

        {/* Right Column: Clean Algebraic Move Log & Rules Legend */}
        <div className="lg:col-span-4 space-y-4">
          <div className="p-4 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] flex flex-col h-[460px]">
            <div className="flex items-center justify-between pb-3 border-b border-[var(--border-subtle)]">
              <h3 className="text-sm font-bold text-[var(--text-primary)]">Nhật ký nước đi</h3>
              {logs.length > 0 && (
                <button
                  type="button"
                  onClick={downloadReplayFile}
                  className="inline-flex items-center gap-1 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer whitespace-nowrap"
                >
                  <Download className="w-3.5 h-3.5" />
                  Lưu JSON
                </button>
              )}
            </div>

            <div className="flex-1 overflow-y-auto mt-3 space-y-1.5 pr-1">
              {logs.length === 0 ? (
                <p className="text-xs text-[var(--text-muted)] py-8 text-center">
                  Chưa có nước đi nào được thực hiện.
                </p>
              ) : (
                logs.map((entry) => (
                  <div
                    key={entry.step}
                    className="flex items-center justify-between px-3 py-2 rounded-lg bg-[var(--bg-canvas)] text-xs font-mono tabular-nums"
                  >
                    <span
                      className={
                        entry.isCapture ? 'text-amber-300 font-medium' : 'text-[var(--text-primary)]'
                      }
                    >
                      #{String(entry.step).padStart(2, '0')} {entry.text}
                    </span>
                    {entry.elapsedMs !== undefined && (
                      <span className="text-[var(--text-muted)]">{entry.elapsedMs}ms</span>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="p-4 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] space-y-2 text-xs text-[var(--text-secondary)]">
            <h4 className="font-bold text-[var(--text-primary)]">Quy tắc thắng & bảo vệ công bằng</h4>
            <p>1. Phe Cam thắng khi chiếm ô i9; phe Tím thắng khi chiếm ô a1. Hoặc diệt sạch 1 trong 3 hệ linh vật của đối phương.</p>
            <p>
              2. Hòa cờ khi lặp thế cờ 3 lần, 50 nước không ăn quân hoặc bên tới lượt hết nước đi hợp lệ.
            </p>
            <p>
              3. Mọi hành vi thoát trận, treo máy, ngâm gói xác nhận ACK hoặc gửi sai mã băm SHA-256 đều bị xử thua kỹ thuật ngay lập tức.
            </p>
          </div>
        </div>
      </div>
      {leaveConfirmOpen && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="leave-match-title"
            aria-describedby="leave-match-description"
            className="w-full max-w-md rounded-2xl border border-amber-400/30 bg-[#161024] p-5 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="rounded-xl bg-amber-500/10 p-2 text-amber-300">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div>
                <h2 id="leave-match-title" className="text-base font-bold text-[var(--text-primary)]">
                  Rời bàn đấu?
                </h2>
                <p
                  id="leave-match-description"
                  className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]"
                >
                  Trận đấu chưa kết thúc. Nếu rời bàn, bạn sẽ bị xử thua kỹ thuật.
                </p>
              </div>
            </div>
            <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => setLeaveConfirmOpen(false)}
                disabled={leavingMatch}
                autoFocus
                className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-4 py-2 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                Quay lại trận đấu
              </button>
              <button
                type="button"
                onClick={handleConfirmLeaveMatch}
                disabled={leavingMatch}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-red-400/30 bg-red-500/15 px-4 py-2 text-sm font-semibold text-red-200 transition-colors hover:bg-red-500/25 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {leavingMatch && <Loader2 className="h-4 w-4 animate-spin" />}
                {leavingMatch ? 'Đang xử lý…' : 'Rời bàn và chịu thua'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
