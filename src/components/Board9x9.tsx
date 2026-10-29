import React from 'react';
import {
  COLS,
  PIECE_COUNTER_HINTS,
  PIECE_TYPE_NAMES,
  PIECE_VIET_NAMES,
  SPECIAL_A1_INDEX,
  SPECIAL_I9_INDEX,
  type GameState,
  type ValidMove,
} from '../core/ottEngine';
import {
  HalloweenMascotPiece,
  HalloweenObstacleGlyph,
  HalloweenShrineGlyph,
  MascotRulesLegend,
} from './HalloweenPieces';

interface Board9x9Props {
  state: GameState | null;
  selectedCell?: number | null;
  validMoves?: ValidMove[];
  onCellClick?: (index: number) => void;
  interactive?: boolean;
  size?: 'mini' | 'normal' | 'large';
  themeMode?: 'halloween' | 'standard';
  showCoordinates?: boolean;
  showLegend?: boolean;
}

export const Board9x9: React.FC<Board9x9Props> = ({
  state,
  selectedCell = null,
  validMoves = [],
  onCellClick,
  interactive = false,
  size = 'normal',
  showCoordinates = size !== 'mini',
  showLegend = size !== 'mini',
}) => {
  const isMini = size === 'mini';
  const blockedSet = new Set(state?.rules?.blockedCells || []);
  const moveMap = new Map<number, ValidMove>();
  for (const m of validMoves) {
    moveMap.set(m.to, m);
  }

  const maxBoardClass =
    size === 'large'
      ? 'max-w-[540px]'
      : size === 'normal'
      ? 'max-w-[460px]'
      : 'max-w-[230px]';

  return (
    <div className={`w-full ${maxBoardClass} mx-auto select-none space-y-3`}>
      <div>
        {showCoordinates && (
          <div className="grid grid-cols-9 pl-6 pr-1 mb-1 text-[11px] font-mono text-[var(--text-muted)] text-center">
            {COLS.map((col) => (
              <span key={col}>{col}</span>
            ))}
          </div>
        )}

        <div className="flex items-stretch">
          {showCoordinates && (
            <div className="flex flex-col justify-around pr-2 text-[11px] font-mono text-[var(--text-muted)] tabular-nums">
              {Array.from({ length: 9 }, (_, r) => (
                <span key={r}>{9 - r}</span>
              ))}
            </div>
          )}

          <div
            role="grid"
            data-ui-feedback="off"
            aria-label="Bàn cờ chiến thuật 9x9 OTTv2"
            className="flex-1 aspect-square grid grid-cols-9 grid-rows-9 rounded-2xl overflow-hidden border-2 border-[#382954] bg-[#161024] shadow-xl"
          >
            {Array.from({ length: 81 }, (_, idx) => {
              const r = Math.floor(idx / 9);
              const c = idx % 9;
              const isLight = (r + c) % 2 === 0;
              const isBlocked = blockedSet.has(idx);
              const isA1 = idx === SPECIAL_A1_INDEX;
              const isI9 = idx === SPECIAL_I9_INDEX;
              const piece = state ? state.board[idx] : 0;
              const player: 1 | 2 | null = piece ? (piece <= 3 ? 1 : 2) : null;
              const pType = piece ? PIECE_TYPE_NAMES[piece] : null;
              const isSelected = selectedCell === idx;
              const moveCandidate = moveMap.get(idx);
              const isLastFrom = state?.lastMove?.from === idx;
              const isLastTo = state?.lastMove?.to === idx;

              const cellBgClass = isBlocked
                ? 'bg-[var(--cell-blocked)]'
                : isA1
                ? 'bg-[var(--shrine-a1)]'
                : isI9
                ? 'bg-[var(--shrine-i9)]'
                : isLight
                ? 'bg-[var(--cell-light)]'
                : 'bg-[var(--cell-dark)]';

              const vietName = piece ? PIECE_VIET_NAMES[piece] : '';
              const counterHint = pType ? PIECE_COUNTER_HINTS[pType] : '';
              const coord = `${COLS[c]}${9 - r}`;

              return (
                <button
                  key={idx}
                  type="button"
                  disabled={isBlocked || (!interactive && !onCellClick)}
                  onClick={() => onCellClick?.(idx)}
                  title={
                    isBlocked
                      ? `Ô ${coord} · Bia đá vật cản (Không thể đi vào)`
                      : isA1
                      ? `Ô đích a1 · Phe Tím thắng khi đưa quân vào đây`
                      : isI9
                      ? `Ô đích i9 · Phe Cam thắng khi đưa quân vào đây`
                      : piece && player
                      ? `${coord} · Phe ${player} (${player === 1 ? 'Cam' : 'Tím'}) · ${vietName} — ${counterHint}`
                      : coord
                  }
                  className={`relative flex items-center justify-center ${cellBgClass} border-[0.5px] border-white/[0.05] transition-transform duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] ${
                    interactive && !isBlocked
                      ? 'cursor-pointer hover:brightness-120'
                      : 'cursor-default'
                  } ${isSelected ? 'ring-2 ring-inset ring-amber-300 bg-amber-500/20 z-10' : ''} ${
                    isLastFrom || isLastTo
                      ? 'after:absolute after:inset-0 after:bg-amber-400/14 after:pointer-events-none'
                      : ''
                  }`}
                >
                  {/* Blocked Sprint Obstacle Cell */}
                  {isBlocked && <HalloweenObstacleGlyph isMini={isMini} />}

                  {/* Special Win Shrines (a1 & i9) when unoccupied */}
                  {!piece && !isBlocked && (isA1 || isI9) && (
                    <HalloweenShrineGlyph kind={isA1 ? 'a1' : 'i9'} isMini={isMini} />
                  )}

                  {/* Valid Move Dot (Empty Target) */}
                  {moveCandidate && !moveCandidate.isAttack && !piece && (
                    <span className="w-3 h-3 rounded-full bg-emerald-400/90 shadow-sm pointer-events-none" />
                  )}

                  {/* Attackable Target Ring */}
                  {moveCandidate?.isAttack && piece > 0 && (
                    <span className="absolute inset-1 rounded-full ring-2 ring-red-400 bg-red-500/25 pointer-events-none" />
                  )}

                  {/* 2D Chibi Mascot Silhouette Piece (Bí Ngô, Bé Ma, Dơi) */}
                  {piece > 0 && pType && player && (
                    <div
                      className={`relative z-10 flex items-center justify-center transition-transform duration-150 ${
                        isMini ? 'w-[86%] h-[86%]' : 'w-[84%] h-[84%]'
                      } ${isSelected ? 'scale-110' : ''} ${
                        isLastTo && state?.lastMove?.isAttack ? 'animate-capture' : ''
                      }`}
                    >
                      <HalloweenMascotPiece
                        type={pType}
                        team={player}
                        className="w-full h-full drop-shadow-[0_2px_3px_rgba(0,0,0,0.55)]"
                      />
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Clear Visual Annotation / Legend below board */}
      {showLegend && <MascotRulesLegend compact={size === 'normal'} />}
    </div>
  );
};
