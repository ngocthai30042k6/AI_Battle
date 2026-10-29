import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, BookOpen, Calendar, Loader2, Plus } from 'lucide-react';
import { TournamentCreationModal, type TournamentCreatePayload } from '../components/TournamentCreationModal';
import { GroupKnockoutTournamentDetail } from '../components/GroupKnockoutTournamentDetail';
import { OTTGameEngine } from '../core/ottEngine';
import {
  backendClient,
  type BackendUser,
  type TournamentItem,
} from '../core/backendClient';
import { Board9x9 } from '../components/Board9x9';
import { useToast } from '../components/ToastProvider';

interface TournamentsViewProps {
  user: BackendUser | null;
  savedBotVersion: number;
  themeMode: 'halloween' | 'standard';
  tournaments: TournamentItem[];
  initialSelectedId?: string | null;
  onClearInitialSelectedId?: () => void;
  onSelectionChange?: (id: string | null) => void;
  onRefreshTournaments: () => Promise<void>;
  onOpenAuth: (tab?: 'login' | 'register' | 'profile') => void;
  onOpenBotLab: (tournamentId?: string) => void;
  onWatchReplayById: (matchId: string, p1: string, p2: string) => void;
}

const GROUP_TOURNAMENT_STATUS_LABELS: Partial<Record<TournamentItem['status'], string>> = {
  scheduled: 'Sắp mở đăng ký',
  registration: 'Đang mở đăng ký',
  grouping: 'Chờ chia bảng',
  group_stage: 'Đã chia bảng · Chờ khởi chạy',
  group_running: 'Vòng bảng đang chạy',
  group_complete: 'Vòng bảng đã xong · Chờ knock-out',
  knockout: 'Đang thi đấu knock-out',
  completed: 'Đã kết thúc · Công bố nhà vô địch',
  cancelled: 'Đã hủy',
};

export const TournamentsView: React.FC<TournamentsViewProps> = ({
  user,
  savedBotVersion,
  themeMode,
  tournaments,
  initialSelectedId = null,
  onClearInitialSelectedId,
  onSelectionChange,
  onRefreshTournaments,
  onOpenAuth,
  onOpenBotLab,
}) => {
  const { notify } = useToast();
  const [statusFilter, setStatusFilter] = useState<
    'upcoming' | 'registration' | 'in_progress' | 'completed'
  >('in_progress');
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId);
  const appliedInitialSelectedId = useRef<string | null>(null);
  const [detail, setDetail] = useState<any | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const detailRequest = useRef(0);
  const [submittingAction, setSubmittingAction] = useState(false);
  const [rulesPreviewTournament, setRulesPreviewTournament] = useState<TournamentItem | null>(null);

  // Create Tournament Form State (Admin / BTC)
  const [showCreateForm, setShowCreateForm] = useState(false);
  const selectTournament = (id: string | null) => {
    detailRequest.current++;
    setDetail(null);
    setDetailError(null);
    setSelectedId(id);
    onSelectionChange?.(id);
  };
  useEffect(() => {
    if (!initialSelectedId) {
      appliedInitialSelectedId.current = null;
      return;
    }
    if (appliedInitialSelectedId.current === initialSelectedId) return;
    appliedInitialSelectedId.current = initialSelectedId;
    selectTournament(initialSelectedId);
    onClearInitialSelectedId?.();
  }, [initialSelectedId, onClearInitialSelectedId]);

  const loadTournamentDetail = useCallback(
    async (id: string, showLoading = true) => {
      const request = ++detailRequest.current;
      setDetailError(null);
      if (showLoading) setLoadingDetail(true);
      try {
        const res = await backendClient.getTournamentDetail(id);
        if (request === detailRequest.current) setDetail(res);
      } catch (err: any) {
        if (request === detailRequest.current) {
          setDetailError(err.message || 'Không thể tải thông tin giải đấu.');
          notify(err.message || 'Không thể tải thông tin giải đấu.', 'error');
        }
      } finally {
        if (request === detailRequest.current && showLoading) setLoadingDetail(false);
      }
    },
    [notify]
  );

  useEffect(() => {
    if (selectedId) {
      loadTournamentDetail(selectedId);
    }
  }, [loadTournamentDetail, selectedId, user?.id]);

  const handleCreateTournament = async (payload: TournamentCreatePayload) => {
    setSubmittingAction(true);
    try {
      const created = await backendClient.createTournament(payload);
      await onRefreshTournaments();
      setShowCreateForm(false);
      notify('Đã tạo giải đấu mới thành công.', 'success');
      if (created?.tournament?.id) {
        selectTournament(created.tournament.id);
      }
    } catch (err: any) {
      notify(err.message || 'Tạo giải đấu thất bại.', 'error');
    } finally {
      setSubmittingAction(false);
    }
  };

  const handleRegister = async (tournamentId: string) => {
    if (!user) {
      onOpenAuth('login');
      return;
    }
    setSubmittingAction(true);
    try {
      await backendClient.registerTournament(tournamentId);
      await onRefreshTournaments();
      selectTournament(tournamentId);
      await loadTournamentDetail(tournamentId);
      notify(
        savedBotVersion > 0
          ? 'Đã ghi danh giải đấu thành công! Bot đã lưu sẽ tự động được nạp khi vào trận.'
          : 'Đã ghi danh giải đấu thành công! Khi muốn thi đấu, hãy lưu Bot trong Phòng Lab trước khi tìm trận.',
        'success'
      );
    } catch (err: any) {
      notify(err.message || 'Không thể đăng ký giải đấu.', 'error');
    } finally {
      setSubmittingAction(false);
    }
  };

  if (selectedId) {
    const tournament = detail?.tournament?.id === selectedId ? detail.tournament : null;
    const backToList = () => selectTournament(null);
    if (!tournament || tournament.format !== 'group_knockout') {
      return (
        <div className="space-y-4">
          <button type="button" onClick={backToList} className="inline-flex items-center gap-2 rounded-xl border border-[var(--border-subtle)] px-4 py-2 text-xs">
            <ArrowLeft className="h-4 w-4" /> Danh sách Giải đấu
          </button>
          <div role="status" className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-8 text-center text-sm text-[var(--text-secondary)]">
            {detailError ? (
              <>
                <p>{detailError}</p>
                <button type="button" onClick={() => loadTournamentDetail(selectedId)} className="mt-3 rounded-lg bg-[var(--accent-primary)] px-4 py-2 text-white">Thử lại</button>
              </>
            ) : tournament ? 'Giải đấu này không hỗ trợ thể thức bảng và knock-out.' : (
              <><Loader2 className="mx-auto mb-3 h-6 w-6 animate-spin" />Đang tải giải đấu…</>
            )}
          </div>
        </div>
      );
    }
    return (
      <GroupKnockoutTournamentDetail
        tournament={tournament}
        detail={detail}
        user={user}
        savedBotVersion={savedBotVersion}
        themeMode={themeMode}
        loading={loadingDetail}
        onBack={backToList}
        onRefresh={onRefreshTournaments}
        onRefreshDetail={() => loadTournamentDetail(tournament.id, false)}
        onOpenAuth={() => onOpenAuth('login')}
        onOpenBotLab={() => onOpenBotLab(tournament.id)}
      />
    );
  }

  // ── TOURNAMENT DIRECTORY LIST VIEW (1-Click Event Frame) ──────
  const filteredList = tournaments.filter((tournament) => {
    if (tournament.format !== 'group_knockout' || tournament.status === 'cancelled') return false;
    if (statusFilter === 'upcoming') {
      return ['scheduled', 'grouping', 'group_stage'].includes(tournament.status);
    }
    if (statusFilter === 'registration') return tournament.status === 'registration';
    if (statusFilter === 'in_progress') {
      return ['group_running', 'group_complete', 'knockout'].includes(tournament.status);
    }
    return tournament.status === 'completed';
  });

  return (
    <div className="space-y-6">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-1 p-1 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-subtle)]">
          {(
            [
              { id: 'upcoming', label: 'Sắp diễn ra' },
              { id: 'registration', label: 'Đang mở đăng ký' },
              { id: 'in_progress', label: 'Đang diễn ra' },
              { id: 'completed', label: 'Đã Kết Thúc' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              aria-pressed={statusFilter === tab.id}
              onClick={() => setStatusFilter(tab.id)}
              className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                statusFilter === tab.id
                  ? 'bg-[var(--bg-panel)] text-[var(--text-primary)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {user?.isAdmin && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setShowCreateForm(true)}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold text-white bg-[var(--accent-primary)] hover:bg-[var(--accent-primary-hover)] transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              <Plus className="w-4 h-4" />
              Tạo giải đấu mới (BTC)
            </button>
          </div>
        )}
      </div>

      {showCreateForm && user?.isAdmin && (
        <TournamentCreationModal
          submitting={submittingAction}
          onClose={() => setShowCreateForm(false)}
          onSubmit={handleCreateTournament}
        />
      )}

      {/* Tournament cards open details; registration happens inside the detail view. */}
      {filteredList.length === 0 ? (
        <div className="p-12 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-center text-sm text-[var(--text-muted)]">
          Chưa có giải đấu nào trong mục này.
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
          {filteredList.map((t) => {
            const eventDate = new Date(
              t.tournament_starts_at || t.registration_closes_at
            ).toLocaleString('vi-VN', { dateStyle: 'medium', timeStyle: 'short' });
            const statusLabel = t.status === 'group_stage'
              ? `${t.group_count || 0} bảng · Chờ khởi chạy`
              : GROUP_TOURNAMENT_STATUS_LABELS[t.status] || t.status;
            return (
              <div
                key={t.id}
                role="button"
                tabIndex={0}
                onClick={() => selectTournament(t.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    selectTournament(t.id);
                  }
                }}
                aria-label={`Mở sự kiện ${t.name}`}
                className="group p-6 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] flex flex-col justify-between space-y-5 hover:border-[var(--border-accent)] hover:bg-[var(--bg-panel)]/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] transition-colors cursor-pointer text-left"
              >
                <div className="space-y-2.5">
                  <div className="text-xs font-medium text-[var(--accent-primary)] tabular-nums">
                    {statusLabel}
                    {' · '}
                    {t.participant_count || 0} đã đăng ký
                  </div>

                  <h3 className="text-xl font-bold text-[var(--text-primary)] group-hover:text-[var(--accent-primary)] transition-colors">
                    {t.name}
                  </h3>
                  <p className="text-sm text-[var(--text-secondary)] leading-relaxed line-clamp-3">
                    {t.description}
                  </p>
                </div>

                <div className="pt-4 border-t border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-3 text-xs text-[var(--text-muted)] tabular-nums">
                  <div className="flex items-center gap-1.5">
                    <Calendar className="w-3.5 h-3.5" />
                    <span>Bắt đầu: {eventDate}</span>
                    {t.rules_json?.title && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{t.rules_json.title}</span>
                      </>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {t.status === 'registration' && (
                      <button
                        type="button"
                        disabled={submittingAction}
                        onClick={(event) => {
                          event.stopPropagation();
                          handleRegister(t.id);
                        }}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--accent-primary)] px-3 py-1.5 font-semibold text-white hover:bg-[var(--accent-primary-hover)] disabled:opacity-50"
                      >
                        Đăng ký tham gia
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        setRulesPreviewTournament(t);
                      }}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-accent)] px-3 py-1.5 text-[var(--accent-primary)] hover:bg-[var(--bg-hover)]"
                    >
                      <BookOpen className="h-3.5 w-3.5" aria-hidden="true" />
                      Xem thể lệ thi đấu
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {rulesPreviewTournament && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
          onClick={(event) => {
            if (event.target === event.currentTarget) setRulesPreviewTournament(null);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="card-tournament-rules-heading"
            className="w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-5 sm:p-7 shadow-2xl"
          >
            <div className="flex items-start justify-between gap-4 border-b border-[var(--border-subtle)] pb-4">
              <div>
                <h3 id="card-tournament-rules-heading" className="text-lg font-bold text-[var(--text-primary)]">
                  Thể lệ giải: {rulesPreviewTournament.name}
                </h3>
                <p className="mt-1 text-xs text-[var(--text-muted)]">Các mốc thời gian và luật thi đấu đã công bố</p>
              </div>
              <button
                type="button"
                autoFocus
                onClick={() => setRulesPreviewTournament(null)}
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
              >
                Đóng
              </button>
            </div>
            <div className="mt-5 space-y-4 text-sm text-[var(--text-secondary)]">
              {rulesPreviewTournament.description && <p className="whitespace-pre-wrap">{rulesPreviewTournament.description}</p>}
              <dl className="grid gap-3 sm:grid-cols-3">
                {[
                  ['Mở đăng ký', rulesPreviewTournament.registration_opens_at],
                  ['Đóng đăng ký', rulesPreviewTournament.registration_closes_at],
                  ['Bắt đầu giải',
                    rulesPreviewTournament.tournament_starts_at || rulesPreviewTournament.ends_at],
                ].filter((entry) => Boolean(entry[1])).map(([label, value]) => (
                  <div key={label} className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-3">
                    <dt className="text-xs text-[var(--text-muted)]">{label}</dt>
                    <dd className="mt-1 font-semibold text-[var(--text-primary)]">
                      {new Date(value as string).toLocaleString('vi-VN', { dateStyle: 'medium', timeStyle: 'short' })}
                    </dd>
                  </div>
                ))}
              </dl>
              {(
                <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(250px,0.8fr)]">
                  <div className="space-y-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-4">
                    <p>Bàn đấu 9 × 9, có {rulesPreviewTournament.rules_json?.blockedCells?.length || 0} ô chướng ngại đối xứng.</p>
                    <p>
                      Luật xử lý: {rulesPreviewTournament.rules_json?.moveLimitRule === 'standard'
                        ? 'cơ bản, tiếp tục đến khi có bên thắng hoặc hòa'
                        : rulesPreviewTournament.rules_json?.moveLimitRule === 'goal-distance'
                        ? 'sau 25 nước, tính điểm theo khoảng cách đến ô đích'
                        : rulesPreviewTournament.rules_json?.moveLimitRule === 'captured-points'
                        ? 'sau 25 nước, tính điểm quân đã ăn'
                        : 'sau 25 nước, đếm số quân còn lại'}
                      {rulesPreviewTournament.rules_json?.moveLimitRule === 'captured-points' && (
                        <> (Đấm {rulesPreviewTournament.rules_json?.capturedPieceValues?.rock || 1}, Lá {rulesPreviewTournament.rules_json?.capturedPieceValues?.paper || 2}, Kéo {rulesPreviewTournament.rules_json?.capturedPieceValues?.scissors || 3} điểm)</>
                      )}
                    </p>
                    {rulesPreviewTournament.rules_json?.moveLimitRule === 'standard' && (
                      <>
                        <p>Thắng: phe Cam chiếm ô i9, phe Tím chiếm ô a1 hoặc diệt sạch 1 trong 3 hệ linh vật của đối phương.</p>
                        <p>Hòa: lặp thế cờ 3 lần, 50 nước không ăn quân hoặc bên tới lượt hết nước đi hợp lệ.</p>
                        <p>Thoát trận, treo máy, ngâm gói xác nhận ACK hoặc gửi sai mã băm SHA-256 sẽ bị xử thua kỹ thuật ngay lập tức.</p>
                      </>
                    )}
                    <p>Chia bảng ngẫu nhiên và cân bằng; vòng bảng đấu hai lượt. Thắng 3 điểm, hòa 1 điểm, thua 0 điểm; hai đấu thủ đầu bảng vào vòng knock-out.</p>
                    <p>Knock-out theo nhánh nhất bảng gặp nhì bảng; trận hòa sẽ được đấu lại.</p>
                  </div>
                  <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-3">
                    <h4 className="mb-3 text-center text-xs font-semibold text-[var(--text-primary)]">
                      Bản đồ áp dụng · Bàn 9×9
                    </h4>
                    <Board9x9
                      state={OTTGameEngine.createGame(
                        20261031,
                        9,
                        rulesPreviewTournament.rules_json
                      )}
                      themeMode={themeMode}
                      size="mini"
                      showCoordinates={false}
                      showLegend={false}
                    />
                  </div>
                </div>

              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
};
