import React, { useState } from 'react';
import {
  ArrowRight,
  Code2,
  Eye,
  Film,
  Play,
  Swords,
} from 'lucide-react';
import {
  getMatchEloLabel,
  getMatchFormatLabel,
  PLAYER_AVATARS,
  type BackendUser,
  type MatchSummary,
  type TournamentItem,
} from '../core/backendClient';
import {
  HalloweenMascotPiece,
  HalloweenObstacleGlyph,
  HalloweenShrineGlyph,
} from '../components/HalloweenPieces';
import type { PieceTypeName } from '../core/ottEngine';

interface OverviewViewProps {
  user: BackendUser | null;
  botVersion: number;
  leaderboard: Array<{
    id: string;
    displayName: string;
    elo: number;
    avatarId?: BackendUser['avatarId'];
    avatarUrl?: BackendUser['avatarUrl'];
    isSystemBot?: boolean;
  }>;
  recentMatches: MatchSummary[];
  tournaments: TournamentItem[];
  loadingData: boolean;
  onNavigate: (
    view: 'overview' | 'bot-lab' | 'matchmaking' | 'tournaments' | 'private-room' | 'multi-watch'
  ) => void;
  onOpenTournament?: (tournamentId: string) => void;
  onOpenAuth: (tab?: 'login' | 'register' | 'profile') => void;
  onWatchMatchReplay: (match: MatchSummary) => void;
}

interface PreviewCellItem {
  team?: 1 | 2;
  type?: PieceTypeName;
  shrine?: 'a1' | 'i9';
  blocked?: boolean;
  selected?: boolean;
  moveDot?: boolean;
  attackTarget?: boolean;
}

const PREVIEW_GRID_5X5: Record<number, PreviewCellItem> = {
  1: { team: 2, type: 'paper' },
  3: { team: 2, type: 'rock' },
  4: { shrine: 'i9' },
  6: { team: 2, type: 'scissors', attackTarget: true },
  10: { moveDot: true },
  11: { team: 1, type: 'rock', selected: true },
  12: { blocked: true },
  13: { team: 2, type: 'paper' },
  17: { team: 1, type: 'paper' },
  18: { team: 1, type: 'scissors' },
  20: { shrine: 'a1' },
  23: { team: 1, type: 'rock' },
};

const MASCOT_GUIDE_ITEMS: Array<{
  type: PieceTypeName;
  name: string;
  rpsLabel: string;
  beats: string;
}> = [
  { type: 'rock', name: 'Bí Ngô', rpsLabel: 'Đấm', beats: 'Ăn Dơi (Kéo)' },
  { type: 'scissors', name: 'Dơi Nhỏ', rpsLabel: 'Kéo', beats: 'Ăn Bé Ma (Lá)' },
  { type: 'paper', name: 'Bé Ma', rpsLabel: 'Lá', beats: 'Ăn Bí Ngô (Đấm)' },
];

function HalloweenHeroVisual() {
  const [activeMascot, setActiveMascot] = useState<PieceTypeName>('rock');

  return (
    <div className="w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-4 flex flex-col justify-between gap-3.5">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-semibold text-[var(--text-primary)]">
          Minh họa Bàn cờ 2D & Linh vật
        </span>
        <span className="text-[11px] text-[var(--text-secondary)]">
          <span className="text-[#fb923c] font-semibold">Phe Cam</span>
          <span aria-hidden="true"> vs </span>
          <span className="text-[#c084fc] font-semibold">Phe Tím</span>
        </span>
      </div>

      <div className="grid grid-cols-1 2xl:grid-cols-12 gap-4 items-center">
        {/* Clean 2D Flat 5x5 Miniature Board */}
        <div className="2xl:col-span-6 max-w-[195px] w-full mx-auto">
          <div
            role="img"
            aria-label="Minh họa bàn cờ phẳng 2D với quân Bí Ngô, Bé Ma và Dơi"
            className="aspect-square grid grid-cols-5 grid-rows-5 rounded-xl overflow-hidden border-2 border-[#382954] bg-[#161024]"
          >
            {Array.from({ length: 25 }, (_, idx) => {
              const r = Math.floor(idx / 5);
              const c = idx % 5;
              const isLight = (r + c) % 2 === 0;
              const item = PREVIEW_GRID_5X5[idx];

              const bgClass = item?.blocked
                ? 'bg-[var(--cell-blocked)]'
                : item?.shrine === 'a1'
                ? 'bg-[var(--shrine-a1)]'
                : item?.shrine === 'i9'
                ? 'bg-[var(--shrine-i9)]'
                : isLight
                ? 'bg-[var(--cell-light)]'
                : 'bg-[var(--cell-dark)]';

              const isHighlightedType = item?.type && item.type === activeMascot;

              return (
                <button
                  key={idx}
                  type="button"
                  onClick={() => {
                    if (item?.type) setActiveMascot(item.type);
                  }}
                  title={
                    item?.blocked
                      ? 'Bia đá vật cản'
                      : item?.shrine
                      ? `Ô đích ${item.shrine} — Chiếm ô này thắng ngay`
                      : item?.type
                      ? `Nhấn để xem chú thích quân ${
                          item.type === 'rock'
                            ? 'Bí Ngô (Đấm)'
                            : item.type === 'paper'
                            ? 'Bé Ma (Lá)'
                            : 'Dơi (Kéo)'
                        }`
                      : undefined
                  }
                  className={`relative flex items-center justify-center ${bgClass} border-[0.5px] border-white/[0.05] ${
                    item?.type ? 'cursor-pointer' : 'cursor-default'
                  } ${
                    item?.selected || isHighlightedType
                      ? 'ring-1 ring-inset ring-amber-300/80 bg-amber-500/15'
                      : ''
                  }`}
                >
                  {item?.blocked && <HalloweenObstacleGlyph isMini />}
                  {item?.shrine && <HalloweenShrineGlyph kind={item.shrine} isMini />}
                  {item?.moveDot && (
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-400/90 pointer-events-none" />
                  )}
                  {item?.attackTarget && (
                    <span className="absolute inset-1 rounded-full ring-1 ring-red-400 bg-red-500/20 pointer-events-none" />
                  )}
                  {item?.type && item.team && (
                    <HalloweenMascotPiece
                      type={item.type}
                      team={item.team}
                      className="w-[82%] h-[82%] drop-shadow-[0_1px_2px_rgba(0,0,0,0.5)]"
                    />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Annotated 2D Mascot Legend */}
        <div className="2xl:col-span-6 divide-y divide-[var(--border-subtle)] text-xs">
          {MASCOT_GUIDE_ITEMS.map((g) => {
            const selected = activeMascot === g.type;
            return (
              <button
                key={g.type}
                type="button"
                onClick={() => setActiveMascot(g.type)}
                className={`w-full py-2 first:pt-1 last:pb-1 px-2.5 rounded-lg flex items-center justify-between gap-2 text-left transition-colors cursor-pointer ${
                  selected ? 'bg-[var(--bg-elevated)]' : 'hover:bg-[var(--bg-elevated)]/50'
                }`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <div className="flex items-center -space-x-1.5 shrink-0">
                    <HalloweenMascotPiece type={g.type} team={1} className="w-6 h-6" />
                    <HalloweenMascotPiece type={g.type} team={2} className="w-5 h-5 opacity-90" />
                  </div>
                  <span className="font-semibold text-[var(--text-primary)] whitespace-nowrap">
                    {g.name}{' '}
                    <span className="text-[var(--text-muted)] font-normal">({g.rpsLabel})</span>
                  </span>
                </div>
                <span className="text-[11px] text-amber-300/95 font-medium whitespace-nowrap">
                  {g.beats}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="pt-2 border-t border-[var(--border-subtle)] flex items-center justify-between gap-2 text-[11px] text-[var(--text-muted)]">
        <span>Di chuyển 1 ô (8 hướng)</span>
        <span>Cam đến i9, Tím đến a1 hoặc diệt 1 hệ quân để thắng</span>
      </div>
    </div>
  );
}

export const OverviewView: React.FC<OverviewViewProps> = ({
  user,
  botVersion,
  leaderboard,
  recentMatches,
  tournaments,
  loadingData,
  onNavigate,
  onOpenTournament,
  onOpenAuth,
  onWatchMatchReplay,
}) => {
  const openTournaments = tournaments.filter(
    (tournament) =>
      tournament.format === 'group_knockout' &&
      !['completed', 'cancelled'].includes(tournament.status)
  );
  const visibleMatches = recentMatches.filter((match) => !match.is_sparring);
  const elo = user?.elo ?? 1200;
  const eloRank = elo >= 1600 ? 'Vàng' : elo >= 1350 ? 'Bạc' : 'Đồng';
  const eloRankColor = eloRank === 'Vàng' ? '#facc15' : eloRank === 'Bạc' ? '#cbd5e1' : '#d97706';

  return (
    <div className="space-y-8">
      {/* 2-Column Hero Section */}
      <section className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch p-6 sm:p-8 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)]">
        <div className="lg:col-span-7 flex flex-col justify-between space-y-6">
          <div className="space-y-3">
            <p className="text-xs font-medium text-[var(--accent-primary)]">
              Sự kiện Mùa Lễ Hội · Lâu Đài Đèn Bí Ngô & Trăng Máu 2026
            </p>
            <h2 className="text-2xl sm:text-4xl font-bold text-[var(--text-primary)] leading-tight text-balance">
              Lập trình Bot Python 3 & Đối kháng chiến thuật 9×9 thời gian thực
            </h2>
            <p className="text-sm sm:text-base text-[var(--text-secondary)] leading-relaxed max-w-2xl">
              Huấn luyện thuật toán trực tiếp trong trình duyệt với Pyodide, thi đấu xếp hạng Elo FIDE xác thực chữ ký số ECDSA P-256 và tranh tài trong các giải đấu vòng bảng, knock-out với bản đồ tùy chỉnh.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <button
              type="button"
              onClick={() => onNavigate('matchmaking')}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white bg-[var(--accent-primary)] hover:bg-[var(--accent-primary-hover)] transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              <Swords className="w-4 h-4" />
              Vào Đấu Trường Xếp Hạng
            </button>
            <button
              type="button"
              onClick={() => onNavigate('bot-lab')}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold border border-[var(--border-subtle)] bg-[var(--bg-canvas)] text-[var(--text-primary)] hover:border-[var(--accent-primary)] transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              <Code2 className="w-4 h-4 text-[var(--accent-primary)]" />
              Mở Phòng Lab Bot Python
            </button>
          </div>
        </div>

        <div className="lg:col-span-5 flex">
          <HalloweenHeroVisual />
        </div>
      </section>

      {/* Full-Width 4-Column KPI Strip */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-5 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)]">
          <div className="text-xs text-[var(--text-secondary)]">Hệ số Elo hiện tại</div>
          <div className="mt-2 flex items-center gap-2 text-2xl sm:text-3xl font-bold font-display text-[var(--text-primary)] tabular-nums">
            <span>{elo}</span>
            <span role="img" aria-label={`Hạng Elo ${eloRank}`} title={`Hạng ${eloRank}`}>
              <svg viewBox="0 0 32 32" className="h-6 w-6 sm:h-7 sm:w-7">
                <polygon
                  points="16,2 28,8 25,23 16,30 7,23 4,8"
                  fill={eloRankColor}
                  fillOpacity="0.16"
                  stroke={eloRankColor}
                  strokeWidth="1.8"
                />
                <polygon
                  points="16,8 20,14 16,22 12,14"
                  fill={eloRankColor}
                  fillOpacity="0.85"
                />
              </svg>
            </span>
          </div>
          <div className="mt-1 text-xs text-[var(--text-muted)]">
            {user ? `Kỳ thủ ${user.displayName}` : 'Mặc định khi tạo tài khoản'}
          </div>
        </div>

        <div className="p-5 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)]">
          <div className="text-xs text-[var(--text-secondary)]">Phiên bản Bot Python</div>
          <div className="mt-2 text-2xl sm:text-3xl font-bold font-display text-[var(--text-primary)] tabular-nums">
            {botVersion > 0 ? `v${botVersion}` : 'Chưa lưu'}
          </div>
          <div className="mt-1 text-xs text-[var(--text-muted)]">
            {botVersion > 0 ? 'Sẵn sàng đấu giải & xếp hạng' : 'Có thể dùng ngay 5 Bot mẫu'}
          </div>
        </div>

        <div className="p-5 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)]">
          <div className="text-xs text-[var(--text-secondary)]">Trận đấu đã ghi nhận</div>
          <div className="mt-2 text-2xl sm:text-3xl font-bold font-display text-[var(--text-primary)] tabular-nums">
            {user ? recentMatches.length : 0}
          </div>
          <div className="mt-1 text-xs text-[var(--text-muted)]">
            Lưu trữ biên bản SHA-256 Replay
          </div>
        </div>

        <div className="p-5 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)]">
          <div className="text-xs text-[var(--text-secondary)]">Giải đấu đang mở</div>
          <div className="mt-2 text-2xl sm:text-3xl font-bold font-display text-[var(--accent-primary)] tabular-nums">
            {openTournaments.length}
          </div>
          <div className="mt-1 text-xs text-[var(--text-muted)]">
            Thi đấu vòng bảng và knock-out
          </div>
        </div>
      </section>

      {/* Main Two-Column Content: Active Tournaments + Recent Matches & Leaderboard */}
      <section className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left 7 Cols: Featured Tournaments + Recent Matches */}
        <div className="lg:col-span-7 space-y-6">
          <div className="p-6 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-bold text-[var(--text-primary)]">
                  Giải đấu Sự kiện & Mùa giải
                </h3>
                <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                  Đăng ký cá nhân trực tiếp · Không yêu cầu lập đội nhóm
                </p>
              </div>
              <button
                type="button"
                onClick={() => onNavigate('tournaments')}
                className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--accent-primary)] hover:underline cursor-pointer whitespace-nowrap shrink-0"
              >
                Xem tất cả giải
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>

            {openTournaments.length === 0 ? (
              <div className="py-8 text-center text-sm text-[var(--text-muted)]">
                Hiện chưa có giải đấu nào đang mở.
              </div>
            ) : (
              <div className="space-y-2.5">
                {openTournaments.slice(0, 3).map((t) => (
                  <div
                    key={t.id}
                    role="button"
                    tabIndex={0}
                    onClick={() =>
                      onOpenTournament ? onOpenTournament(t.id) : onNavigate('tournaments')
                    }
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        if (onOpenTournament) onOpenTournament(t.id);
                        else onNavigate('tournaments');
                      }
                    }}
                    className="group p-3.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-canvas)] hover:border-[var(--border-accent)] hover:bg-[var(--bg-panel)]/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-2 cursor-pointer"
                  >
                    <div className="space-y-1">
                      <h4 className="text-sm font-bold text-[var(--text-primary)] group-hover:text-[var(--accent-primary)] transition-colors">
                        {t.name}
                      </h4>
                      <div className="text-xs text-[var(--text-secondary)] tabular-nums">
                        <span>
                          {t.execution_paused_at ? `${t.status === 'knockout' ? 'Knock-Out' : 'Vòng bảng'} · Tạm dừng` : { scheduled: 'Sắp mở đăng ký', registration: 'Đang mở đăng ký',
                            grouping: 'Chờ chia bảng', group_stage: 'Đã chia bảng',
                            group_running: 'Vòng bảng đang diễn ra', group_complete: 'Vòng bảng đã kết thúc',
                            knockout: 'Vòng knock-out', completed: 'Đã kết thúc', cancelled: 'Đã hủy',
                            qualifying: 'Đang thi đấu' }[t.status] || t.status}
                        </span>
                        <span aria-hidden="true"> · </span>
                        <span>
                          {t.participant_count || 0} kỳ thủ
                        </span>
                        {t.rules_json?.title && (
                          <>
                            <span aria-hidden="true"> · </span>
                            <span>{t.rules_json.title}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <span className="text-xs text-[var(--text-muted)] group-hover:text-[var(--text-primary)] transition-colors whitespace-nowrap shrink-0">
                      Nhấn để mở
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Recent Verified Matches */}
          <div className="p-6 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-bold text-[var(--text-primary)]">
                  Lịch sử đối đầu gần đây
                </h3>
                <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                  Mọi ván đấu hoàn tất đều hỗ trợ xem lại từng nước đi
                </p>
              </div>
              <button
                type="button"
                onClick={() => onNavigate('multi-watch')}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer whitespace-nowrap shrink-0"
              >
                <Eye className="w-3.5 h-3.5 text-[var(--accent-primary)]" />
                Xem 4 bàn trực tiếp
              </button>
            </div>

            {!user ? (
              <div className="py-8 text-center space-y-3">
                <p className="text-sm text-[var(--text-secondary)]">
                  Đăng nhập tài khoản để lưu lịch sử thi đấu, biến động Elo và biên bản Replay.
                </p>
              </div>
            ) : visibleMatches.length === 0 ? (
              <div className="py-8 text-center space-y-3">
                <p className="text-sm text-[var(--text-secondary)]">
                  Bạn chưa có trận đấu nào. Hãy khởi động một trận đấu xếp hạng đầu tiên!
                </p>
                <button
                  type="button"
                  onClick={() => onNavigate('matchmaking')}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold text-white bg-[var(--accent-primary)] hover:bg-[var(--accent-primary-hover)] cursor-pointer"
                >
                  <Play className="w-3.5 h-3.5" />
                  Đấu trận đầu tiên
                </button>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-[var(--border-subtle)] text-[var(--text-muted)]">
                      <th className="py-2.5 pr-3 font-medium">Cặp đấu</th>
                      <th className="py-2.5 px-3 font-medium">Chế độ</th>
                      <th className="py-2.5 px-3 font-medium">Kết quả</th>
                      <th className="py-2.5 pl-3 text-right font-medium">Biên bản</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border-subtle)] tabular-nums">
                    {visibleMatches.slice(0, 3).map((m) => {
                      const isCompleted = m.status === 'completed';
                      const isDraw = isCompleted && !m.winner_id;
                      const won = isCompleted && m.winner_id === user.id;
                      return (
                        <tr key={m.id} className="hover:bg-[var(--bg-hover)]/40 transition-colors">
                          <td className="py-3 pr-3 font-medium text-[var(--text-primary)]">
                            {m.player1} <span className="text-[var(--text-muted)]">vs</span> {m.player2}
                          </td>
                          <td className="py-3 px-3 text-[var(--text-secondary)]">
                            {getMatchFormatLabel(m)}
                          </td>
                          <td className="py-3 px-3">
                            {!isCompleted ? (
                              <span className="text-[var(--text-muted)]">{m.status}</span>
                            ) : (
                              <span
                                className={
                                  isDraw
                                    ? 'text-amber-300 font-semibold'
                                    : won
                                    ? 'text-emerald-400 font-semibold'
                                    : 'text-red-400'
                                }
                              >
                                {isDraw ? 'Hòa' : won ? 'Thắng' : 'Thua'}
                                {user && getMatchEloLabel(m, user.id)
                                  ? ` (${getMatchEloLabel(m, user.id)})`
                                  : ''}
                              </span>
                            )}
                          </td>
                          <td className="py-3 pl-3 text-right">
                            {m.replay_available ? (
                              <button
                                type="button"
                                onClick={() => onWatchMatchReplay(m)}
                                className="inline-flex items-center gap-1 text-xs font-medium text-[var(--accent-primary)] hover:underline cursor-pointer whitespace-nowrap"
                              >
                                <Film className="w-3.5 h-3.5" />
                                Mở Replay
                              </button>
                            ) : (
                              <span className="text-[var(--text-muted)]">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* Right 5 Cols: Top Elo Leaderboard */}
        <div className="lg:col-span-5 p-6 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-bold text-[var(--text-primary)]">Bảng xếp hạng Elo</h3>
              <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                Cập nhật trực tiếp theo chuẩn FIDE (K = 20)
              </p>
            </div>
            <span className="text-xs font-mono text-[var(--text-muted)] tabular-nums">
              Top {Math.min(10, leaderboard.length)}
            </span>
          </div>

          {loadingData && leaderboard.length === 0 ? (
            <div className="space-y-2.5 py-2">
              {Array.from({ length: 5 }, (_, i) => (
                <div key={i} className="h-10 rounded-xl bg-[var(--bg-canvas)] animate-pulse" />
              ))}
            </div>
          ) : leaderboard.length === 0 ? (
            <div className="py-8 text-center text-sm text-[var(--text-muted)]">
              Chưa có dữ liệu bảng xếp hạng.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-[var(--border-subtle)] text-[var(--text-muted)]">
                    <th className="py-2 pr-2 font-medium w-10">#</th>
                    <th className="py-2 px-2 font-medium">Kỳ thủ</th>
                    <th className="py-2 pl-2 text-right font-medium">Elo</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border-subtle)] tabular-nums">
                  {leaderboard.slice(0, 10).map((player, idx) => {
                    const isMe = user?.id === player.id;
                    return (
                      <tr
                        key={player.id}
                        className={`transition-colors ${
                          isMe ? 'bg-[var(--p1-bg)]' : 'hover:bg-[var(--bg-hover)]/40'
                        }`}
                      >
                        <td className="py-2.5 pr-2 font-mono font-semibold text-[var(--text-secondary)]">
                          {idx < 3 ? (
                            <span
                              className="text-base"
                              role="img"
                              aria-label={`Hạng ${idx + 1}`}
                              title={`Top ${idx + 1}`}
                            >
                              {['🥇', '🥈', '🥉'][idx]}
                            </span>
                          ) : (
                            String(idx + 1).padStart(2, '0')
                          )}
                        </td>
                        <td className="py-2.5 px-2 font-medium text-[var(--text-primary)]">
                          {player.avatarUrl ? (
                            <img
                              src={player.avatarUrl}
                              alt=""
                              className="mr-1.5 inline-block h-5 w-5 rounded-full object-cover align-middle"
                            />
                          ) : (
                            <span className="mr-1.5" aria-hidden="true">
                              {PLAYER_AVATARS.find((avatar) => avatar.id === player.avatarId)?.emoji || '🎃'}
                            </span>
                          )}
                          <span>{player.displayName}</span>
                          {isMe && (
                            <span className="text-[var(--accent-primary)] ml-1.5">· Bạn</span>
                          )}
                        </td>
                        <td className="py-2.5 pl-2 text-right font-mono font-bold text-[var(--text-primary)]">
                          {player.elo}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  );
};
