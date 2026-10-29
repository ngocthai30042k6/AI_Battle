import React, { useEffect, useRef, useState } from 'react';
import Peer from 'peerjs';
import {
  Maximize2,
  Minimize2,
  Pause,
  Play,
  Radio,
  RotateCcw,
  Tv,
  Unplug,
} from 'lucide-react';
import {
  OTTGameEngine,
  PIECE_VIET_NAMES,
  SPRINT_RULE_PRESETS,
  buildRulesFromPreset,
  type GameState,
} from '../core/ottEngine';
import { Board9x9 } from '../components/Board9x9';
import { MascotRulesLegend } from '../components/HalloweenPieces';
import { useToast } from '../components/ToastProvider';

interface MultiWatchViewProps {
  themeMode: 'halloween' | 'standard';
}

interface WatchSlotConfig {
  id: number;
  title: string;
  presetKey: string;
  p1Label: string;
  p2Label: string;
  initialSeed: number;
}

const INITIAL_SLOTS: WatchSlotConfig[] = [
  {
    id: 1,
    title: 'Bàn 01 · Bàn chuẩn',
    presetKey: 'standard',
    p1Label: 'Phantom Hunter',
    p2Label: 'Minimax Tactical',
    initialSeed: 810201,
  },
  {
    id: 2,
    title: 'Bàn 02 · Chướng ngại trung tâm',
    presetKey: 'center_blockers',
    p1Label: 'AlphaRPS VN',
    p2Label: 'Reaper Bot',
    initialSeed: 810202,
  },
  {
    id: 3,
    title: 'Bàn 03 · Bàn vát góc',
    presetKey: 'clipped_corners',
    p1Label: 'Greedy Rush',
    p2Label: 'NightOwl AI',
    initialSeed: 810203,
  },
  {
    id: 4,
    title: 'Bàn 04 · Hành lang vật cản',
    presetKey: 'corridor',
    p1Label: 'BloodMoon AI',
    p2Label: 'Sentinel v3',
    initialSeed: 810204,
  },
];

function pickFastExhibitionMove(state: GameState) {
  const botView = OTTGameEngine.createBotGameState(state, state.turn);
  const moves = botView.validMoves;
  if (!moves.length) return null;
  let best = moves[0];
  let bestScore = -Infinity;
  const targetRow = state.turn === 1 ? 0 : 8;
  const targetCol = state.turn === 1 ? 8 : 0;

  for (const m of moves) {
    if ((state.turn === 1 && m.to === 8) || (state.turn === 2 && m.to === 72)) {
      return { from: m.from, to: m.to };
    }
    let score = m.isAttack ? 145 : 0;
    score -= (Math.abs(m.toRow - targetRow) + Math.abs(m.toCol - targetCol)) * 10;
    score -= (Math.abs(m.toRow - 4) + Math.abs(m.toCol - 4)) * 2;
    score += (Math.random() - 0.5) * 18;
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return { from: best.from, to: best.to };
}

const WatchQuadrantCard: React.FC<{
  slot: WatchSlotConfig;
  themeMode: 'halloween' | 'standard';
  focused: boolean;
  onToggleFocus: () => void;
}> = ({ slot, themeMode, focused, onToggleFocus }) => {
  const { notify } = useToast();
  const [presetKey, setPresetKey] = useState(slot.presetKey);
  const [state, setState] = useState<GameState>(() =>
    OTTGameEngine.createGame(slot.initialSeed, 9, buildRulesFromPreset(slot.presetKey, 1))
  );
  const [autoSim, setAutoSim] = useState(true);
  const [roomInput, setRoomInput] = useState('');
  const [liveRoomCode, setLiveRoomCode] = useState<string | null>(null);
  const [p1Name, setP1Name] = useState(slot.p1Label);
  const [p2Name, setP2Name] = useState(slot.p2Label);

  const peerRef = useRef<Peer | null>(null);

  useEffect(() => {
    return () => {
      peerRef.current?.destroy();
    };
  }, []);

  // AI Exhibition Simulation Loop (when not connected to an external P2P room)
  useEffect(() => {
    if (liveRoomCode || !autoSim || OTTGameEngine.isGameOver(state)) return;
    const timer = setTimeout(() => {
      const move = pickFastExhibitionMove(state);
      if (move) {
        setState((prev) => OTTGameEngine.applyMove(prev, move));
      }
    }, 650 + slot.id * 90);
    return () => clearTimeout(timer);
  }, [autoSim, liveRoomCode, slot.id, state]);

  const handleResetExhibition = (nextPreset = presetKey) => {
    const nextSeed = Math.floor(100000 + Math.random() * 8999999);
    const rules = buildRulesFromPreset(nextPreset, 1);
    setState(OTTGameEngine.createGame(nextSeed, 9, rules));
    setAutoSim(true);
  };

  const handleConnectP2PRoom = () => {
    const code = roomInput.trim().toUpperCase().replace(/^OTT-/, '');
    if (code.length < 4) {
      notify('Nhập mã phòng hợp lệ để kết nối luồng trực tiếp.', 'error');
      return;
    }

    peerRef.current?.destroy();
    const peer = new Peer();
    peerRef.current = peer;

    peer.on('open', () => {
      const conn = peer.connect(`ottv2-room-${code.toLowerCase()}`, { reliable: true });
      conn.on('open', () => {
        conn.send({ type: 'JOIN_REQUEST', role: 'spectator', displayName: `MultiView #${slot.id}` });
      });

      conn.on('data', (raw: any) => {
        if (!raw || typeof raw !== 'object') return;
        if (raw.type === 'ROOM_WELCOME') {
          setAutoSim(false);
          setLiveRoomCode(code);
          setP1Name(raw.player1Name || 'Player 1');
          setP2Name(raw.player2Name || 'Player 2');
          setState(OTTGameEngine.createGame(raw.seed, raw.pieceCount || 9, raw.rules || null));
          notify(`Bàn 0${slot.id} đã kết nối phòng trực tiếp ${code}`, 'success');
          return;
        }
        if (raw.type === 'CONSENSUS_REVEAL' && raw.attestation?.payload?.move) {
          const mv = raw.attestation.payload.move;
          setState((curr) => {
            try {
              return OTTGameEngine.applyMove(curr, { from: mv.from, to: mv.to });
            } catch {
              return curr;
            }
          });
        }
      });
    });

    peer.on('error', () => {
      notify(`Không thể kết nối tới mã phòng ${code}.`, 'error');
    });
  };

  const handleDisconnectP2P = () => {
    peerRef.current?.destroy();
    peerRef.current = null;
    setLiveRoomCode(null);
    setP1Name(slot.p1Label);
    setP2Name(slot.p2Label);
    handleResetExhibition();
  };

  const counts = OTTGameEngine.countPieces(state.board);
  const lastMoveDesc = state.lastMove
    ? `${PIECE_VIET_NAMES[state.lastMove.piece]} ${OTTGameEngine.toAlgebraic(
        state.lastMove.from
      )}→${OTTGameEngine.toAlgebraic(state.lastMove.to)}`
    : 'Khai cuộc';

  return (
    <div className="p-4 sm:p-5 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] flex flex-col justify-between space-y-3.5">
      {/* Quadrant Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5 border-b border-[var(--border-subtle)]">
        <div>
          <div className="flex items-center gap-2 text-sm font-bold text-[var(--text-primary)]">
            {liveRoomCode ? (
              <Radio className="w-4 h-4 text-emerald-400" />
            ) : (
              <Tv className="w-4 h-4 text-[var(--accent-primary)]" />
            )}
            <span>{liveRoomCode ? `Phòng P2P · ${liveRoomCode}` : `Bàn 0${slot.id} · Biểu diễn AI`}</span>
          </div>
          <div className="text-xs text-[var(--text-secondary)] mt-0.5 tabular-nums">
            <span className="text-[var(--p1-main)] font-medium">{p1Name}</span> ({counts[1].total}){' '}
            <span className="text-[var(--text-muted)]">vs</span>{' '}
            <span className="text-[var(--p2-main)] font-medium">{p2Name}</span> ({counts[2].total}) · Lượt #
            {state.stepCount}
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          {!liveRoomCode && (
            <>
              <select
                value={presetKey}
                onChange={(e) => {
                  const val = e.target.value;
                  setPresetKey(val);
                  handleResetExhibition(val);
                }}
                aria-label="Chọn bản đồ mô phỏng"
                className="px-2 py-1 text-[11px] rounded-lg bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-[var(--text-secondary)]"
              >
                {Object.values(SPRINT_RULE_PRESETS).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>

              <button
                type="button"
                onClick={() => setAutoSim((s) => !s)}
                title={autoSim ? 'Tạm dừng' : 'Tiếp tục'}
                className="p-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-canvas)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
              >
                {autoSim ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              </button>

              <button
                type="button"
                onClick={() => handleResetExhibition()}
                title="Ván mới"
                className="p-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-canvas)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
            </>
          )}

          <button
            type="button"
            onClick={onToggleFocus}
            title={focused ? 'Thu nhỏ về lưới 4 bàn' : 'Phóng to bàn này'}
            className="p-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-canvas)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
          >
            {focused ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* Board Render */}
      <div className="py-1">
        <Board9x9
          state={state}
          size={focused ? 'large' : 'mini'}
          themeMode={themeMode}
          showCoordinates={focused}
        />
      </div>

      {/* Quadrant Footer: Status + Connect P2P Room Code */}
      <div className="pt-2.5 border-t border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="font-mono text-[var(--text-secondary)] tabular-nums">
          {OTTGameEngine.isGameOver(state)
            ? state.winner === 0
              ? 'Kết thúc: Hòa cờ!'
              : `Kết thúc: ${state.winner === 1 ? p1Name : p2Name} thắng!`
            : `Nước cuối: ${lastMoveDesc}`}
        </div>

        {liveRoomCode ? (
          <button
            type="button"
            onClick={handleDisconnectP2P}
            className="inline-flex items-center gap-1 text-red-300 hover:underline cursor-pointer"
          >
            <Unplug className="w-3.5 h-3.5" />
            Ngắt phòng {liveRoomCode}
          </button>
        ) : (
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={roomInput}
              onChange={(e) => setRoomInput(e.target.value.toUpperCase())}
              placeholder="Mã phòng P2P…"
              className="w-28 px-2.5 py-1 text-xs font-mono uppercase rounded-lg bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
            />
            <button
              type="button"
              onClick={handleConnectP2PRoom}
              className="px-2.5 py-1 rounded-lg font-medium bg-[var(--bg-panel)] border border-[var(--border-subtle)] text-[var(--text-primary)] hover:border-[var(--accent-primary)] cursor-pointer whitespace-nowrap"
            >
              Xem P2P
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export const MultiWatchView: React.FC<MultiWatchViewProps> = ({ themeMode }) => {
  const [focusedSlotId, setFocusedSlotId] = useState<number | null>(null);

  const visibleSlots =
    focusedSlotId !== null
      ? INITIAL_SLOTS.filter((s) => s.id === focusedSlotId)
      : INITIAL_SLOTS;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 p-4 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)]">
        <div>
          <h2 className="text-base font-bold text-[var(--text-primary)]">
            Trung Tâm Quan Sát 4 Trận Đấu Cùng Lúc (Multi-Arena 2×2)
          </h2>
          <p className="text-xs text-[var(--text-secondary)] mt-0.5">
            Bạn có thể nhập mã phòng P2P vào từng ô hoặc theo dõi đồng thời 4 thế trận AI.
          </p>
        </div>
        {focusedSlotId !== null && (
          <button
            type="button"
            onClick={() => setFocusedSlotId(null)}
            className="px-3.5 py-2 rounded-xl text-xs font-semibold text-white bg-[var(--accent-primary)] hover:bg-[var(--accent-primary-hover)] cursor-pointer whitespace-nowrap"
          >
            Quay lại lưới 4 bàn
          </button>
        )}
      </div>

      {focusedSlotId === null && <MascotRulesLegend compact />}

      <div
        className={`grid gap-5 ${
          focusedSlotId !== null ? 'grid-cols-1 max-w-3xl mx-auto' : 'grid-cols-1 md:grid-cols-2'
        }`}
      >
        {visibleSlots.map((slot) => (
          <WatchQuadrantCard
            key={slot.id}
            slot={slot}
            themeMode={themeMode}
            focused={focusedSlotId === slot.id}
            onToggleFocus={() =>
              setFocusedSlotId((curr) => (curr === slot.id ? null : slot.id))
            }
          />
        ))}
      </div>
    </div>
  );
};
