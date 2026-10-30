import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, BookOpen, Bot, CheckCircle2, Loader2, Pause, Play, RefreshCw, Search, Settings2, ShieldX, Sparkles, Swords, Trophy, UsersRound, X } from 'lucide-react';
import { backendClient, type BackendUser, type TournamentItem } from '../core/backendClient';
import { KnockoutSetup } from './KnockoutSetup';
import { TournamentEligibilityDialog } from './TournamentEligibilityDialog';
import { KnockoutBattleZone } from './KnockoutBattleZone';
import { KnockoutFinal } from './KnockoutFinal';
import { KnockoutChampion } from './KnockoutChampion';
import { SingleLineName } from './SingleLineName';
import { knockoutRoundLabel } from '../core/knockoutPresentation';
import { Board9x9 } from './Board9x9';
import { OTTGameEngine } from '../core/ottEngine';
import { useToast } from './ToastProvider';
import { TournamentAvatar } from './TournamentAvatar';
import { KnockoutBracket } from './KnockoutBracket';
import { hasKnockoutPlace, tournamentGameOutcome } from '../core/tournamentLog';

interface GroupKnockoutTournamentDetailProps {
  tournament: TournamentItem;
  detail: any;
  user: BackendUser | null;
  savedBotVersion: number;
  themeMode: 'halloween' | 'standard';
  loading: boolean;
  onBack: () => void;
  onRefresh: () => Promise<void>;
  onRefreshDetail: () => Promise<void>;
  onOpenAuth: () => void;
  onOpenBotLab: () => void;
}

const STATUS_LABELS: Record<string, string> = {
  scheduled: 'Sắp mở đăng ký',
  registration: 'Đang mở đăng ký',
  grouping: 'Đã đóng đăng ký · Chờ BTC chia bảng',
  group_stage: 'Đã chia bảng · Chờ BTC khởi chạy',
  group_running: 'Vòng bảng đang chạy',
  group_complete: 'Vòng bảng đã hoàn tất · Chờ knock-out',
  knockout: 'Vòng knock-out',
  completed: 'Đã tìm được nhà vô địch',
  cancelled: 'Đã hủy',
};

function dateTime(value?: string) {
  return value
    ? new Date(value).toLocaleString('vi-VN', { dateStyle: 'medium', timeStyle: 'short' })
    : 'Chưa thiết lập';
}

export const GroupKnockoutTournamentDetail: React.FC<GroupKnockoutTournamentDetailProps> = ({
  tournament,
  detail,
  user,
  savedBotVersion,
  themeMode,
  loading,
  onBack,
  onRefresh,
  onRefreshDetail,
  onOpenAuth,
  onOpenBotLab,
}) => {
  const { notify } = useToast();
  const [groupCount, setGroupCount] = useState(8);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [showKnockoutSetup, setShowKnockoutSetup] = useState(false);
  const [eligibilityMinimum, setEligibilityMinimum] = useState<number | null>(null);
  const [showResults, setShowResults] = useState(false);
  const [showBattleZone, setShowBattleZone] = useState(false);
  const [activeTournamentTab, setActiveTournamentTab] = useState<'groups' | 'knockout'>(() => ['knockout', 'completed'].includes(tournament.status) ? 'knockout' : 'groups');
  const [resultsFor, setResultsFor] = useState<'all' | 'mine'>('all');
  const [resultSearch, setResultSearch] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [organizing, setOrganizing] = useState(false);
  const organizingRequest = useRef(false);
  const [visibleGroupRows, setVisibleGroupRows] = useState<Record<number, number>>({});
  useEffect(() => setVisibleGroupRows({}), [tournament.id, user?.id]);
  const activeRules = ['knockout', 'completed'].includes(tournament.status)
    ? tournament.knockout_rules_json || tournament.rules_json : tournament.rules_json;
  const mapPreview = useMemo(
    () => OTTGameEngine.createGame(20261031, 9, activeRules),
    [activeRules]
  );
  const participantCount = Number(detail?.participantCount || 0);
  const eligibleGroupCounts = [8, 16, 32].filter((count) => participantCount >= count * 4);
  const teamsPerGroup = Math.floor(participantCount / groupCount);
  const largerGroupCount = participantCount % groupCount;
  const groups = detail?.groups || [];
  const fixtures = detail?.fixtures || [];
  const ownEntry = detail?.myEntry;
  const knockoutFixtures = useMemo(
    () => fixtures.filter((fixture: any) => fixture.phase === 'knockout'),
    [fixtures]
  );
  const knockoutRounds = useMemo(() => {
    const rounds = new Map<number, any[]>();
    for (const fixture of knockoutFixtures) {
      const round = Number(fixture.round_number);
      rounds.set(round, [...(rounds.get(round) || []), fixture]);
    }
    return [...rounds.entries()].sort(([first], [second]) => first - second);
  }, [knockoutFixtures]);
  const openingMatchCount = Math.max(groups.length, knockoutRounds[0]?.[1].length || 0);
  const bracketRoundCount = openingMatchCount > 0
    ? Math.ceil(Math.log2(openingMatchCount)) + 1
    : 0;
  const participantAvatars = useMemo(() => {
    const participants = new Map<string, { avatarId?: string; avatarUrl?: string | null }>();
    for (const group of groups) {
      for (const participant of [...(group.members || []), ...(group.standings || [])]) {
        if (participant.player_id && !participants.has(participant.player_id)) {
          participants.set(participant.player_id, {
            avatarId: participant.avatar_id,
            avatarUrl: participant.avatar_url,
          });
        }
      }
    }
    return participants;
  }, [groups]);
  const [resultPhase, setResultPhase] = useState<'group' | 'knockout'>('group');
  const [searchedResults, setSearchedResults] = useState<any[]>([]);
  const [resultTotal, setResultTotal] = useState(0);
  const [resultCursor, setResultCursor] = useState<string | null>(null);
  const [resultLoading, setResultLoading] = useState(false);
  const [resultError, setResultError] = useState('');
  const [resultQuery, setResultQuery] = useState('');
  const [resultRefresh, setResultRefresh] = useState(0);
  const logRequest = useRef(0);
  const qualifiedForKnockout = hasKnockoutPlace({...detail,tournament},user?.id);
  const showKnockoutLog = resultsFor === 'all' || qualifiedForKnockout;
  const openResults = (scope: 'mine' | 'all') => {
    setResultsFor(scope); setResultSearch(''); setResultQuery('');
    setResultPhase(activeTournamentTab === 'knockout' && (scope === 'all' || qualifiedForKnockout) ? 'knockout' : 'group');
    setShowResults(true);
  };
  useEffect(() => {
    const timer = setTimeout(() => setResultQuery(resultSearch.trim()), 250);
    return () => clearTimeout(timer);
  }, [resultSearch]);
  useEffect(() => {
    if (!showKnockoutLog && resultPhase === 'knockout') setResultPhase('group');
  }, [showKnockoutLog,resultPhase]);
  useEffect(() => {
    const request = ++logRequest.current;
    setSearchedResults([]); setResultTotal(0); setResultCursor(null); setResultError('');
    if (!showResults || !user) return;
    setResultLoading(true);
    void backendClient.getTournamentMatchLog(tournament.id,resultPhase,resultsFor,resultQuery).then(page => {
      if (request !== logRequest.current) return;
      setSearchedResults(page.matches); setResultTotal(page.total); setResultCursor(page.nextCursor);
    }).catch(error => {if (request === logRequest.current) setResultError(error.message);})
      .finally(() => {if (request === logRequest.current) setResultLoading(false);});
    return () => {logRequest.current++;};
  }, [showResults,user?.id,tournament.id,resultPhase,resultsFor,resultQuery,resultRefresh]);
  const loadMoreResults = async () => {
    if (!resultCursor || resultLoading) return;
    const request = logRequest.current;
    setResultLoading(true); setResultError('');
    try {
      const page = await backendClient.getTournamentMatchLog(tournament.id,resultPhase,resultsFor,resultQuery,resultCursor);
      if (request !== logRequest.current) return;
      setSearchedResults(current => [...current,...page.matches.filter(item=>!current.some(old=>old.id===item.id))]);
      setResultTotal(page.total); setResultCursor(page.nextCursor);
    } catch (error: any) {if (request === logRequest.current) setResultError(error.message);}
    finally {if (request === logRequest.current) setResultLoading(false);}
  };

  const perform = async (action: () => Promise<unknown>, successMessage: string) => {
    setSubmitting(true);
    try {
      await action();
      await Promise.all([onRefresh(), onRefreshDetail()]);
      notify(successMessage, 'success');
      return true;
    } catch (error: any) {
      notify(error.message || 'Không thể thực hiện thao tác.', 'error');
      return false;
    } finally {
      setSubmitting(false);
    }
  };

  const startTournamentMatch = async () => {
    if (!user) {
      onOpenAuth();
      return;
    }
    setSubmitting(true);
    try {
      await backendClient.findTournamentMatch(tournament.id);
    } catch (error: any) {
      notify(error.message || 'Không thể tìm trận giải đấu.', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => {
    if (
      !ownEntry ||
      !savedBotVersion ||
      (tournament.execution_mode === 'server') ||
      !['group_running', 'knockout'].includes(tournament.status)
    ) return;
    void startTournamentMatch();
  }, [ownEntry?.player_id, savedBotVersion, tournament.id, tournament.status, tournament.execution_mode]);

  useEffect(() => {
    if (!['group_running', 'group_complete', 'knockout'].includes(tournament.status)) return;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing || document.visibilityState === 'hidden') return;
      refreshing = true;
      try {
        await onRefreshDetail();
      } finally {
        refreshing = false;
      }
    };
    const timer = window.setInterval(() => void refresh(), 2000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [onRefreshDetail, tournament.status]);

  const register = async () => {
    if (!user) {
      onOpenAuth();
      return;
    }
    const minimum = Number(tournament.min_elo || 0);
    if (user.elo < minimum) { setEligibilityMinimum(minimum); return; }
    await perform(
      () => backendClient.registerTournament(tournament.id),
      'Đã đăng ký tham gia giải.'
    );
  };

  const cancelTournament = async () => {
    setSubmitting(true);
    try {
      await backendClient.cancelTournament(tournament.id);
      setConfirmCancel(false);
      await onRefresh();
      onBack();
      notify('Đã hủy giải đấu và gỡ khỏi danh sách.', 'success');
    } catch (error: any) {
      notify(error.message || 'Không thể hủy giải đấu.', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-5">
      {showBattleZone && <KnockoutBattleZone tournamentId={tournament.id} tournamentName={tournament.name} fixtures={knockoutFixtures} avatars={participantAvatars} userId={user?.id} themeMode={themeMode} onClose={() => setShowBattleZone(false)} />}
      {eligibilityMinimum !== null && <TournamentEligibilityDialog minimum={eligibilityMinimum} elo={user?.elo} onClose={() => setEligibilityMinimum(null)} />}
      {Number(tournament.min_elo || 0) > 0 && <p className="text-xs text-[var(--text-secondary)]">Điều kiện đăng ký: Elo từ {tournament.min_elo} trở lên.</p>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3.5 py-2 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
        >
          <ArrowLeft className="h-4 w-4" />
          Danh sách giải
        </button>
        <div className="flex flex-wrap items-center gap-2">
          {ownEntry && <button type="button" onClick={() => openResults('mine')} className="inline-flex items-center gap-2 rounded-xl border border-orange-400/30 bg-orange-500/5 px-3.5 py-2 text-xs font-semibold text-orange-300"><Swords className="h-4 w-4" />Nhật ký đấu giải của bạn</button>}
          {user?.isAdmin && !['completed', 'cancelled'].includes(tournament.status) && (
            <button
              type="button"
              onClick={() => setConfirmCancel(true)}
              className="inline-flex items-center gap-1.5 rounded-xl border border-red-500/40 bg-red-500/10 px-3.5 py-2 text-xs font-semibold text-red-300 hover:bg-red-500/20"
            >
              <ShieldX className="h-4 w-4" />
              Hủy giải đấu
            </button>
          )}
          {tournament.status === 'registration' && !ownEntry && (
            <button
              type="button"
              disabled={submitting}
              onClick={register}
              className="rounded-xl bg-[var(--accent-primary)] px-4 py-2 text-xs font-semibold text-white disabled:opacity-50"
            >
              {user ? 'Đăng ký tham gia' : 'Đăng nhập để đăng ký'}
            </button>
          )}
        </div>
      </div>

      <section className="relative isolate overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-5 py-8 shadow-xl sm:px-8 sm:py-10">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_50%_0%,rgba(249,115,22,0.18),transparent_58%),linear-gradient(120deg,transparent_20%,rgba(255,255,255,0.025)_50%,transparent_80%)]"
        />
        <div aria-hidden="true" className="pointer-events-none absolute left-1/2 top-0 h-px w-2/3 -translate-x-1/2 bg-gradient-to-r from-transparent via-orange-400/70 to-transparent" />
        <div className="relative mx-auto flex max-w-3xl flex-col items-center text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-orange-400/20 bg-orange-400/[0.08] px-3 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--accent-primary)]">
            <Sparkles className="h-3.5 w-3.5" />
            {tournament.execution_paused_at ? `${tournament.status === 'knockout' ? 'Knock-Out' : 'Vòng bảng'} · Tạm dừng` : STATUS_LABELS[tournament.status] || tournament.status}
            <Sparkles className="h-3.5 w-3.5" />
          </span>
          <h2 className="mt-3 text-3xl font-black tracking-tight text-[var(--text-primary)] sm:text-4xl">
            {tournament.name}
          </h2>
          {tournament.description && (
            <p className="mt-2 max-w-2xl whitespace-pre-wrap text-sm leading-6 text-[var(--text-secondary)]">
              {tournament.description}
            </p>
          )}
          <div aria-hidden="true" className="my-5 flex w-full max-w-xs items-center gap-3 text-orange-300/70">
            <span className="h-px flex-1 bg-gradient-to-r from-transparent to-orange-400/40" />
            <Swords className="h-4 w-4" />
            <span className="h-px flex-1 bg-gradient-to-l from-transparent to-orange-400/40" />
          </div>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <div className="inline-flex items-center gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-canvas)]/80 px-4 py-2.5">
              <UsersRound className="h-5 w-5 text-[var(--accent-primary)]" aria-hidden="true" />
              <div className="text-left">
                <div className="text-[10px] text-[var(--text-muted)]">Đấu thủ đã đăng ký</div>
                <strong className="block font-mono text-xl leading-6 text-[var(--text-primary)]">
                  {participantCount}
                </strong>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setShowRules(true)}
              className="inline-flex items-center gap-2 rounded-xl border border-[var(--border-accent)] bg-orange-500/[0.06] px-4 py-3 text-xs font-bold text-[var(--accent-primary)] transition-colors hover:bg-orange-500/[0.12]"
            >
              <BookOpen className="h-4 w-4" aria-hidden="true" />
              Xem thể lệ thi đấu
            </button>
          </div>
        </div>
      </section>

      {showRules && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="group-tournament-rules-heading"
            className="max-h-[88vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-5 shadow-2xl sm:p-7"
          >
            <div className="flex items-start justify-between gap-4 border-b border-[var(--border-subtle)] pb-4">
              <div>
                <h3 id="group-tournament-rules-heading" className="text-lg font-bold text-[var(--text-primary)]">
                  Thể lệ thi đấu: {tournament.name}
                </h3>
                <p className="mt-1 text-xs text-[var(--text-muted)]">Bản đồ, thời gian và cách tính kết quả</p>
              </div>
              <button
                type="button"
                autoFocus
                onClick={() => setShowRules(false)}
                className="rounded-lg px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
              >
                Đóng
              </button>
            </div>
            <div className="mt-5 grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(260px,0.9fr)]">
              <div className="space-y-4 text-sm leading-6 text-[var(--text-secondary)]">
                {tournament.description && <p className="whitespace-pre-wrap">{tournament.description}</p>}
                <p>
                  Bàn đấu 9×9 · {activeRules?.blockedCells?.length || 0} ô chướng ngại đối xứng.
                </p>
                <div>
                  <h4 className="font-semibold text-[var(--text-primary)]">Thời gian</h4>
                  <ul className="mt-1 space-y-1">
                    <li>Mở đăng ký: {dateTime(tournament.registration_opens_at)}</li>
                    <li>Đóng đăng ký: {dateTime(tournament.registration_closes_at)}</li>
                    <li>Bắt đầu giải: {dateTime(tournament.tournament_starts_at)}</li>
                  </ul>
                </div>
                <div>
                  <h4 className="font-semibold text-[var(--text-primary)]">Luật xử lý ván đấu</h4>
                  <p className="mt-1">
                    {activeRules?.moveLimitRule === 'standard'
                      ? 'Luật cơ bản: không giới hạn 25 nước; tiếp tục chơi cho đến khi có bên thắng hoặc ván hòa theo luật.'
                      : activeRules?.moveLimitRule === 'remaining-pieces'
                      ? 'Sau 25 nước đi hoàn chỉnh, bên còn nhiều quân hơn thắng.'
                      : activeRules?.moveLimitRule === 'goal-distance'
                      ? 'Sau 25 nước đi hoàn chỉnh, bên có tổng khoảng cách quân đến ô đích nhỏ hơn thắng.'
                      : 'Sau 25 nước đi hoàn chỉnh, so sánh điểm các quân đã ăn được.'}
                  </p>
                  {activeRules?.moveLimitRule === 'standard' && (
                    <>
                      <p className="mt-1">
                        1. Phe Cam thắng khi chiếm ô i9; phe Tím thắng khi chiếm ô a1. Hoặc diệt sạch 1 trong 3 hệ linh vật của đối phương.
                      </p>
                      <p className="mt-1">
                        2. Hòa cờ khi lặp thế cờ 3 lần, 50 nước không ăn quân hoặc bên tới lượt hết nước đi hợp lệ.
                      </p>
                      <p className="mt-1">
                        3. Mọi hành vi thoát trận, treo máy, ngâm gói xác nhận ACK hoặc gửi sai mã băm SHA-256 đều bị xử thua kỹ thuật ngay lập tức.
                      </p>
                    </>
                  )}
                  {activeRules?.moveLimitRule === 'captured-points' && (
                    <p className="mt-1">
                      Điểm quân: Đấm {activeRules?.capturedPieceValues?.rock || 1},
                      {' '}Lá {activeRules?.capturedPieceValues?.paper || 2},
                      {' '}Kéo {activeRules?.capturedPieceValues?.scissors || 3}.
                    </p>
                  )}
                  {activeRules?.moveLimitRule !== 'standard' && (
                    <p className="mt-1">Nếu điểm bằng nhau sau 25 nước, ván đấu hòa.</p>
                  )}
                </div>
                <div>
                  <h4 className="font-semibold text-[var(--text-primary)]">Thể thức giải</h4>
                  <p className="mt-1">
                    Đăng ký không giới hạn số lượng. Sau khi đóng đăng ký, BTC chia ngẫu nhiên thành 8, 16 hoặc 32 bảng; số người giữa các bảng lệch tối đa 1.
                  </p>
                  <p className="mt-1">
                    Vòng bảng đấu vòng tròn hai lượt. Thắng 3 điểm, hòa 1 điểm, thua 0 điểm. Hiệu số = tổng số nước trong trận thua − tổng số nước trong trận thắng.
                  </p>
                  <p className="mt-1">
                    Hai đấu thủ đầu mỗi bảng vào knock-out. Nhánh được ghép theo cặp bảng: nhất Bảng 1 gặp nhì Bảng 2, nhất Bảng 2 gặp nhì Bảng 1; tiếp tục tương tự với Bảng 3–4, 5–6...
                  </p>
                </div>
              </div>
              <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-3">
                <h4 className="mb-3 text-center text-sm font-semibold text-[var(--text-primary)]">
                  Bản đồ áp dụng · 9×9
                </h4>
                <Board9x9
                  state={mapPreview}
                  themeMode={themeMode}
                  size="mini"
                  showCoordinates={false}
                  showLegend={false}
                />
              </div>
            </div>
          </section>
        </div>
      )}

      {user?.isAdmin && ['registration', 'grouping'].includes(tournament.status) && (
        <section className="rounded-2xl border border-[var(--border-accent)] bg-[var(--bg-elevated)] p-5">
          <h3 className="font-bold">
            {tournament.status === 'registration' ? 'Tổ chức giải ngay' : 'Chia bảng sau khi đóng đăng ký'}
          </h3>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">
            {tournament.status === 'registration'
              ? `Đóng đăng ký ngay với ${participantCount} đấu thủ hiện có, sau đó xếp ngẫu nhiên và chia đều. Số người giữa các bảng lệch tối đa 1.`
              : 'BTC chọn số bảng; đấu thủ được xếp ngẫu nhiên và chia đều. Bảng nhiều hơn chỉ lệch tối đa 1 người.'}
            {' '}Nhất và nhì mỗi bảng vào vòng knock-out.
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="text-xs text-[var(--text-secondary)]">
              Số bảng
              <select
                disabled={organizing}
                value={groupCount}
                onChange={(event) => setGroupCount(Number(event.target.value))}
                className="mt-1 block rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-3 py-2 text-sm text-white"
              >
                {[8, 16, 32].map((count) => (
                  <option key={count} value={count} disabled={!eligibleGroupCounts.includes(count)}>
                    {count} bảng{eligibleGroupCounts.includes(count) ? '' : ` · cần ít nhất ${count * 4} đấu thủ`}
                  </option>
                ))}
              </select>
            </label>
            {eligibleGroupCounts.includes(groupCount) && (
              <span className="pb-2 text-xs text-[var(--text-secondary)]">
                Dự kiến: {largerGroupCount > 0
                  ? `${largerGroupCount} bảng ${teamsPerGroup + 1} người, ${groupCount - largerGroupCount} bảng ${teamsPerGroup} người`
                  : `${groupCount} bảng ${teamsPerGroup} người`}
              </span>
            )}
            <button
              type="button"
              disabled={submitting || !eligibleGroupCounts.includes(groupCount)}
              aria-busy={organizing}
              onClick={async () => {
                if (organizingRequest.current) return;
                organizingRequest.current = true;
                setOrganizing(true);
                try { await perform(
                  () => backendClient.createTournamentGroups(tournament.id, groupCount),
                  'Đã chia bảng và tạo lịch vòng tròn hai lượt.'
                ); } finally { organizingRequest.current = false; setOrganizing(false); }
              }}
              className="inline-flex items-center gap-2 rounded-xl bg-[var(--accent-primary)] px-4 py-2 text-xs font-semibold text-white disabled:opacity-50"
            >
              {organizing && <Loader2 className="h-4 w-4 animate-spin" />}
              {organizing ? 'Đang chia bảng…' : tournament.status === 'registration' ? 'Tổ chức ngay' : 'Công bố danh sách bảng'}
            </button>
            {!eligibleGroupCounts.length && (
              <span className="text-xs text-amber-300">
                Cần ít nhất 32 đấu thủ; mỗi bảng cần có tối thiểu 4 người.
              </span>
            )}
          </div>
          {organizing && <p role="status" aria-live="polite" className="mt-3 flex items-center gap-2 text-xs text-[var(--accent-primary)]">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
            Đang xếp ngẫu nhiên {participantCount.toLocaleString('vi-VN')} đấu thủ và lưu lịch thi đấu. Vui lòng chờ…
          </p>}
        </section>
      )}

      {activeTournamentTab === 'groups' && user?.isAdmin && (tournament.status === 'group_stage' ||
        (tournament.status === 'group_running' && tournament.execution_mode !== 'server')) && (
        <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--border-accent)] bg-[var(--bg-elevated)] p-5">
          <div>
            <h3 className="font-bold">Vòng bảng đã sẵn sàng</h3>
            <p className="mt-1 text-xs text-[var(--text-secondary)]">
              Server chạy code Bot đã lưu theo lịch vòng tròn hai lượt: mỗi cặp gặp nhau hai lần và đổi bên đi trước. Kết quả tự cập nhật lên BXH, không cần người chơi online. Code Bot được chốt khi khởi chạy.
            </p>
          </div>
          <button
            type="button"
            disabled={submitting}
            onClick={() => perform(
              () => backendClient.startTournamentGroups(tournament.id),
              'Server đã nhận lịch vòng bảng và sẽ tự chạy các trận, không cần người chơi online.'
            )}
            className="inline-flex items-center gap-2 rounded-xl bg-[var(--accent-primary)] px-4 py-2.5 text-xs font-semibold text-white disabled:opacity-50"
          >
            <Play className="h-4 w-4" />
            Khởi chạy vòng bảng
          </button>
        </section>
      )}

      {user?.isAdmin && (tournament.status === 'group_complete' || (tournament.status === 'knockout' && !tournament.knockout_started_at && knockoutFixtures.every((f: any) => f.status === 'pending' && !f.games_played && Number(f.leg) === 1))) && (
        <div className="flex justify-end">
          <button type="button" disabled={submitting} onClick={() => setShowKnockoutSetup(true)}
            className="inline-flex items-center gap-2 rounded-xl border border-[var(--border-accent)] bg-[var(--bg-panel)] px-4 py-2.5 text-sm font-semibold text-[var(--accent-primary)]">
            <Settings2 className="h-4 w-4" />Điều chỉnh vòng Knock Out
          </button>
        </div>
      )}
      {showKnockoutSetup && user?.isAdmin && (
        <KnockoutSetup key={tournament.id} groups={groups} rules={tournament.knockout_rules_json || tournament.rules_json}
          fixtures={knockoutFixtures} startsAt={tournament.knockout_starts_at} submitting={submitting}
          onClose={() => setShowKnockoutSetup(false)}
          onStart={settings => perform(
            () => backendClient.prepareTournamentKnockout(tournament.id, settings),
            'Đã công bố nhánh, luật và giờ knock-out. Người chơi có thể cập nhật Bot trước khi khởi chạy.'
          )} />
      )}

      {tournament.status === 'knockout' && tournament.knockout_starts_at && !tournament.knockout_started_at && tournament.execution_mode === 'server' && (
        <section className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-[var(--border-accent)] bg-[var(--bg-elevated)] p-5">
          <div>
            <h3 className="font-bold">Chuẩn bị vòng Knock-out BO3</h3>
            <p className="mt-1 text-xs text-[var(--text-secondary)]">Bắt đầu từ {dateTime(tournament.knockout_starts_at)}. BTC bấm khởi chạy để chốt Bot mới nhất.</p>
            <p className="mt-1 text-xs text-[var(--text-muted)]">Đấu thủ hãy xem bàn cờ, luật mới và lưu Bot lần 2 trong Phòng Lab trước khi vòng bắt đầu.</p>
          </div>
          {user?.isAdmin ? <button type="button"
            disabled={submitting || !tournament.knockout_starts_at || new Date(tournament.knockout_starts_at).getTime() > Date.now()}
            onClick={() => perform(() => backendClient.startTournamentKnockout(tournament.id), 'Đã chốt Bot mới nhất và khởi chạy vòng Knock-out BO3.')}
            className="inline-flex items-center gap-2 rounded-xl bg-[var(--accent-primary)] px-4 py-2.5 text-xs font-semibold text-white disabled:opacity-50">
            <Play className="h-4 w-4" />Khởi chạy vòng Knock-out
          </button> : ownEntry && <button type="button" onClick={onOpenBotLab}
            className="rounded-xl border border-[var(--border-accent)] px-4 py-2.5 text-xs font-semibold text-[var(--accent-primary)]">Chỉnh sửa và lưu Bot lần 2</button>}
        </section>
      )}

      {tournament.execution_mode === 'server' && (tournament.status === 'group_running' ||
        (tournament.status === 'knockout' && tournament.knockout_started_at)) && (
        <section className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-[var(--border-accent)] bg-[var(--bg-elevated)] p-5" aria-live="polite">
          <div className="flex items-start gap-3">
            {tournament.execution_paused_at ? <Pause className="mt-0.5 h-5 w-5 text-amber-400" /> : <Loader2 className="mt-0.5 h-5 w-5 animate-spin text-[var(--accent-primary)]" />}
            <div>
              <h3 className="font-bold">{tournament.status === 'knockout' ? 'Vòng Knock-Out' : 'Vòng bảng'} · {tournament.execution_paused_at ? 'Tạm dừng' : 'Đang thi đấu'}</h3>
              <p className="mt-1 text-xs text-[var(--text-secondary)]">
                {tournament.execution_paused_at
                  ? 'Ván đang chạy sẽ hoàn tất. Các ván tiếp theo chờ BTC bấm Tiếp tục; kết quả và Bot đã chốt được giữ nguyên.'
                  : 'Server tự chạy các ván đấu. Tạm dừng sẽ có hiệu lực sau khi ván hiện tại hoàn tất.'}
              </p>
            </div>
          </div>
          {user?.isAdmin && <button type="button" disabled={submitting} aria-busy={submitting}
            onClick={() => perform(() => backendClient.setTournamentPaused(tournament.id, !tournament.execution_paused_at),
              tournament.execution_paused_at ? 'Đã tiếp tục vòng đấu từ lịch còn lại.' : 'Đã yêu cầu tạm dừng. Ván đang chạy sẽ được hoàn tất và lưu kết quả.')}
            className="inline-flex shrink-0 items-center gap-2 rounded-xl border border-[var(--border-accent)] bg-[var(--bg-panel)] px-4 py-2.5 text-sm font-semibold text-[var(--accent-primary)] disabled:opacity-50">
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : tournament.execution_paused_at ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
            {tournament.execution_paused_at ? 'Tiếp tục' : 'Tạm dừng'} {tournament.status === 'knockout' ? 'Knock-Out' : 'vòng bảng'}
          </button>}
        </section>
      )}

      {activeTournamentTab === 'groups' && !tournament.execution_paused_at && !user?.isAdmin && ownEntry && savedBotVersion > 0 &&
        ['group_running', 'knockout'].includes(tournament.status) && (
          <div className="rounded-xl border border-[var(--border-accent)] bg-[var(--bg-elevated)] p-3 text-xs text-[var(--text-secondary)]">
            {tournament.execution_mode === 'server'
              ? tournament.status === 'knockout' && !tournament.knockout_started_at
                ? 'Đang chờ BTC khởi chạy knock-out. Bạn có thể cập nhật Bot theo bàn cờ và luật mới.'
                : 'Server đang tự chạy bằng code Bot đã chốt. Bạn có thể đóng trang; tỷ số và kết quả sẽ tự cập nhật.'
              : 'Bot đang tự vào lịch đấu. Hãy giữ trang mở để hoàn tất trận knock-out.'}
          </div>
        )}

      <nav
        aria-label="Các vòng đấu"
        className="flex w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-1"
      >
        {([
          { id: 'groups', label: 'Vòng Bảng' },
          { id: 'knockout', label: 'Vòng Knock Out' },
        ] as const).map((tab) => (
          <button
            key={tab.id}
            type="button"
            aria-pressed={activeTournamentTab === tab.id}
            onClick={() => setActiveTournamentTab(tab.id)}
            className={`flex-1 rounded-lg px-4 py-2.5 text-sm font-bold transition-colors ${
              activeTournamentTab === tab.id
                ? 'bg-[var(--bg-panel)] text-[var(--accent-primary)] shadow-sm'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {loading ? (
        <div className="flex justify-center rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-10">
          <Loader2 className="h-6 w-6 animate-spin text-[var(--accent-primary)]" />
        </div>
      ) : (
        <>
          {activeTournamentTab === 'groups' && groups.length > 0 && (
            <section className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-lg font-bold">Các bảng đấu · {groups.length} bảng</h3>
                <div className="flex flex-wrap items-center gap-3">
                  {detail?.groupStandingsPublished && (
                    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-300">
                      <CheckCircle2 className="h-4 w-4" />
                      {tournament.status === 'group_running' ? 'BXH đang cập nhật' : 'Đã chốt BXH vòng bảng'}
                    </span>
                  )}
                  {user?.isAdmin && (
                    <button
                      type="button"
                      onClick={() => openResults('all')}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--border-subtle)] px-3.5 py-2 text-xs font-semibold text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                    >
                      <Search className="h-4 w-4" />
                      Kết quả
                    </button>
                  )}
                  {ownEntry && (
                    <button
                      type="button"
                      onClick={onOpenBotLab}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--border-accent)] px-3.5 py-2 text-xs font-semibold text-[var(--accent-primary)] hover:bg-[var(--bg-hover)]"
                    >
                      <Bot className="h-4 w-4" />
                      Cấu hình Bot
                    </button>
                  )}
                </div>
              </div>
              <p className="mb-3 text-[10px] text-[var(--text-muted)]">
                Trận: số trận đã đấu · T/H/B: thắng/hòa/bại · Thắng 3 điểm, hòa 1 điểm.
                {' '}Hệ số = tổng số nước trận thua − tổng số nước trận thắng; cao hơn được ưu tiên khi bằng điểm.
              </p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-3 lg:grid-cols-4">
                {groups.map((group: any) => {
                  const rows = detail?.groupStandingsPublished ? group.standings : group.members;
                  const ownIndex = user ? rows.findIndex((row: any) => row.player_id === user.id) : -1;
                  const isMyGroup = ownIndex >= 0;
                  const visibleCount = visibleGroupRows[group.group_number] || 8;
                  const ownRow = ownIndex >= 8 ? rows[ownIndex] : null;
                  return (
                    <div
                      key={group.group_number}
                      className={`min-w-0 overflow-hidden rounded-xl border bg-[var(--bg-elevated)] ${isMyGroup
                        ? 'border-[var(--accent-primary)] ring-2 ring-[var(--accent-primary)]/30'
                        : 'border-[var(--border-subtle)]'}`}
                    >
                      <h4 className={`flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-2.5 py-2 text-xs font-bold sm:px-3 ${isMyGroup ? 'bg-orange-500/10 text-[var(--accent-primary)]' : ''}`}>
                        <span>Bảng {group.group_number} <span className="font-normal text-[var(--text-muted)]">· {rows.length} người</span></span>
                        {isMyGroup && (
                          <span className="rounded-full border border-orange-500/30 bg-orange-500/10 px-2 py-0.5 text-[10px]">
                            Bảng của bạn
                          </span>
                        )}
                      </h4>
                      <div>
                        <table className="w-full table-fixed text-[10px] tabular-nums">
                          <caption className="sr-only">Điểm và thống kê đấu thủ Bảng {group.group_number}</caption>
                          <colgroup>
                            {[5, 35, 10, 7, 7, 7, 14, 15].map((width, index) => (
                              <col key={index} style={{ width: `${width}%` }} />
                            ))}
                          </colgroup>
                          <thead className="bg-[var(--bg-canvas)] text-[var(--text-muted)]">
                            <tr className="border-b border-[var(--border-subtle)]">
                              <th scope="col" className="py-2 text-center">#</th>
                              <th scope="col" className="py-2 text-left">Đấu thủ</th>
                              <th scope="col" className="py-2 text-center">Trận</th>
                              <th scope="col" title="Thắng" className="py-2 text-center">T</th>
                              <th scope="col" title="Hòa" className="py-2 text-center">H</th>
                              <th scope="col" title="Thua (bại)" className="py-2 text-center">B</th>
                              <th scope="col" className="py-2 text-center">Điểm</th>
                              <th scope="col" title="Hệ số nước đi" className="py-2 text-center">HS</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-[var(--border-subtle)]">
                        {rows.slice(0, visibleCount).map((row: any, index: number) => {
                          const isAdvancing = index < 2;
                          const eligibilityClass = isAdvancing
                            ? 'bg-emerald-500/15 text-emerald-200'
                            : 'bg-red-500/10 text-red-200';
                          return (
                            <tr
                              key={row.player_id}
                              className={eligibilityClass}
                            >
                              <td className="py-2.5 text-center font-mono opacity-70">
                                {index + 1}
                              </td>
                              <th scope="row" className="py-2.5 pr-1 text-left font-normal">
                                <div className="flex min-w-0 items-center gap-1.5">
                                  <TournamentAvatar avatarId={row.avatar_id} avatarUrl={row.avatar_url} name={row.display_name} />
                                  <div className="min-w-0">
                                    <div className="break-words text-[11px] font-semibold leading-4 [overflow-wrap:anywhere]">
                                      {row.display_name}
                                      {row.player_id === user?.id && (
                                        <span className="ml-1 inline-block whitespace-nowrap font-bold text-[var(--accent-primary)]">(Bạn)</span>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              </th>
                              <td className="text-center">{row.matchesPlayed ?? row.matches_played ?? 0}</td>
                              <td className="text-center">{row.wins ?? 0}</td>
                              <td className="text-center">{row.draws ?? 0}</td>
                              <td className="text-center">{row.losses ?? 0}</td>
                              <td className="text-center font-bold text-[var(--accent-primary)]">{row.points ?? 0}</td>
                              <td className="text-center font-mono">
                                {(row.moveDifference ?? 0) > 0 ? '+' : ''}{row.moveDifference ?? 0}
                              </td>
                            </tr>
                          );
                        })}
                          </tbody>
                        </table>
                      </div>
                      {ownRow && (
                        <div aria-label="Vị trí của bạn" className="mx-2 mb-2 mt-2 rounded-lg border border-[var(--border-accent)] bg-orange-500/10 p-2.5 text-[11px]">
                          <div className="mb-1 flex items-center justify-between gap-2 font-bold text-[var(--accent-primary)]">
                            <span>Hạng của bạn</span><span className="font-mono text-sm">#{ownIndex + 1} / {rows.length}</span>
                          </div>
                          <div className="flex items-center gap-1.5 font-semibold"><TournamentAvatar avatarId={ownRow.avatar_id} avatarUrl={ownRow.avatar_url} name={ownRow.display_name} />{ownRow.display_name} (Bạn)</div>
                          <p className="mt-1 text-[var(--text-secondary)]">{ownRow.points ?? 0} điểm · {ownRow.matchesPlayed ?? ownRow.matches_played ?? 0} trận · HS {ownRow.moveDifference ?? 0}</p>
                        </div>
                      )}
                      {rows.length > 8 && <div className="flex flex-wrap items-center justify-between gap-1 border-t border-[var(--border-subtle)] px-2.5 py-2">
                        <span className="text-[10px] text-[var(--text-muted)]">{Math.min(visibleCount, rows.length)} / {rows.length} đấu thủ</span>
                        <div className="flex gap-2">
                          {visibleCount > 8 && <button type="button" onClick={() => setVisibleGroupRows(current => ({ ...current, [group.group_number]: 8 }))} className="rounded-lg px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">Thu gọn</button>}
                          {visibleCount < rows.length && <button type="button" onClick={() => setVisibleGroupRows(current => ({ ...current, [group.group_number]: visibleCount + 8 }))} className="rounded-lg bg-[var(--accent-primary)]/10 px-2 py-1 text-[11px] font-bold text-[var(--accent-primary)] hover:bg-[var(--bg-hover)]">Xem thêm</button>}
                        </div>
                      </div>}
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {activeTournamentTab === 'knockout' && (
            <section className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-4 sm:p-5">
              <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-[var(--border-accent)] bg-gradient-to-br from-orange-500/20 to-purple-500/20 text-[var(--accent-primary)] shadow-lg shadow-orange-950/20">
                    <Trophy className="h-5 w-5" />
                  </span>
                  <div>
                    <h3 className="font-bold">Vòng Knock Out</h3>
                    <p className="mt-0.5 text-xs text-[var(--text-muted)]">BO3 · Tỷ số cập nhật sau mỗi ván · Bằng điểm sau 3 ván thì đấu ván phụ</p>
                  </div>
                </div>
                {bracketRoundCount > 0 && (
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={() => setShowBattleZone(true)} className="inline-flex items-center gap-2 rounded-xl border border-orange-400/40 bg-orange-500/10 px-3 py-2 text-xs font-bold text-[var(--accent-primary)] hover:bg-orange-500/20"><Swords className="h-4 w-4" />Battle Zone</button>
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-3 py-1.5 text-xs text-[var(--text-secondary)]">
                      <UsersRound className="h-3.5 w-3.5 text-[var(--accent-primary)]" />
                      {openingMatchCount * 2} suất
                    </span>
                    <span className="rounded-full border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-3 py-1.5 text-xs text-[var(--text-secondary)]">
                      {bracketRoundCount} vòng
                    </span>
                  </div>
                )}
              </div>
              {bracketRoundCount > 0 ? (
                <>
                <div className="space-y-4 lg:hidden">
                  <KnockoutChampion final={knockoutFixtures.find((f:any)=>Number(f.round_number)===bracketRoundCount)} avatars={participantAvatars} userId={user?.id} />
                  {knockoutRounds.map(([round, roundFixtures]) => <div key={round} className="space-y-2">
                    <h4 className="text-xs font-bold text-[var(--accent-primary)]">{knockoutRoundLabel(openingMatchCount, round)}</h4>
                    {roundFixtures.map(fixture => <article key={fixture.id} className={`rounded-xl border bg-[var(--bg-canvas)] p-4 ${user && [fixture.player1_id,fixture.player2_id].includes(user.id) ? 'border-orange-400/60' : 'border-[var(--border-subtle)]'}`}>
                      {round === bracketRoundCount ? <KnockoutFinal final={fixture} userId={user?.id} showChampion={false} /> : <>
                        {[1,2].map(seat => <div key={seat} className="flex items-center justify-between gap-3 py-2 text-sm">
                          <span className={`flex min-w-0 flex-1 items-center gap-2 ${fixture[`player${seat}_id`] === user?.id ? 'rounded bg-orange-500/15 px-1 font-bold text-orange-300' : fixture.winner_id === fixture[`player${seat}_id`] ? 'font-bold text-emerald-300' : ''}`}>
                            <TournamentAvatar {...participantAvatars.get(fixture[`player${seat}_id`])} name={fixture[`player${seat}`]} />
                            <SingleLineName maxSize={14}>{`${fixture[`player${seat}`]}${fixture[`player${seat}_id`] === user?.id ? ' (Bạn)' : ''}`}</SingleLineName>
                          </span><strong className="shrink-0 font-mono">{Number(fixture[`player${seat}_score`] || 0)}</strong>
                        </div>)}
                        <p className="mt-2 text-[10px] text-[var(--text-muted)]">{fixture.status === 'completed' ? 'Đã kết thúc' : fixture.status === 'active' ? 'Đang thi đấu' : 'Chờ thi đấu'} · {fixture.series_best_of === 3 ? 'BO3' : 'BO1'}</p>
                      </>}
                    </article>)}
                  </div>)}
                  {!knockoutRounds.length && <p className="p-4 text-sm text-[var(--text-muted)]">Chưa công bố cặp đấu Knock-Out.</p>}
                </div>
                <KnockoutBracket fixtures={knockoutFixtures} openingMatches={openingMatchCount} avatars={participantAvatars} userId={user?.id} />
                </>
              ) : (
                <div className="rounded-xl border border-dashed border-[var(--border-subtle)] p-8 text-center text-sm text-[var(--text-muted)]">
                  Nhánh knock-out sẽ được hiển thị sau khi có danh sách bảng đấu.
                </div>
              )}
            </section>
          )}

        </>
      )}

      {showResults && user && (resultsFor === 'mine' ? Boolean(ownEntry) : user.isAdmin) && (
        <div
          className="fixed inset-0 z-[85] flex items-center justify-center bg-black/80 p-3 backdrop-blur-sm sm:p-5"
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="tournament-results-heading"
            className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] shadow-2xl"
          >
            <div className="flex items-start justify-between gap-4 border-b border-[var(--border-subtle)] p-4 sm:p-5">
              <div>
                <h3 id="tournament-results-heading" className="text-lg font-bold text-[var(--text-primary)]">
                  {resultsFor === 'mine' ? 'Nhật ký đấu giải của bạn' : 'Kết quả trận đấu'}
                </h3>
                <p className="mt-1 text-xs text-[var(--text-muted)]">
                  {resultTotal} ván đã hoàn tất · {resultPhase === 'knockout' ? 'Knock-Out' : 'Vòng bảng'}
                </p>
              </div>
              <div className="flex items-center gap-1"><button type="button" onClick={() => setResultRefresh(value=>value+1)} aria-label="Làm mới nhật ký" className="rounded-lg p-2 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"><RefreshCw className="h-4 w-4" /></button><button
                type="button"
                autoFocus
                onClick={() => setShowResults(false)}
                aria-label="Đóng kết quả trận đấu"
                className="rounded-lg p-2 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
              >
                <X className="h-4 w-4" />
              </button></div>
            </div>
            <nav aria-label="Vòng trong nhật ký" className="mx-4 mt-4 flex gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-1 sm:mx-5">
              {(['group',...(showKnockoutLog ? ['knockout'] : [])] as Array<'group'|'knockout'>).map(phase=><button key={phase} type="button" aria-pressed={resultPhase===phase} onClick={()=>setResultPhase(phase)} className={`flex-1 rounded-lg px-4 py-2 text-xs font-bold ${resultPhase===phase ? 'bg-[var(--bg-panel)] text-orange-300' : 'text-[var(--text-secondary)]'}`}>{phase==='group' ? 'Vòng bảng' : 'Knock-Out'}</button>)}
            </nav>
            {resultsFor==='mine' && <p className="mx-4 mt-3 text-[10px] text-[var(--text-muted)] sm:mx-5">{resultPhase==='knockout' ? 'Điểm từng ván: thắng +1 · hòa +0.5 · thua +0.' : 'Điểm từng ván: thắng +3 · hòa +1 · thua +0.'}</p>}
            <label className="relative m-4 mb-0 sm:m-5 sm:mb-0">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
              <input
                type="search"
                value={resultSearch}
                onChange={(event) => setResultSearch(event.target.value)}
                placeholder="Tìm đấu thủ hoặc mã trận trong vòng này..."
                aria-label="Tìm trong kết quả trận đấu"
                className="w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-canvas)] py-2.5 pl-9 pr-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--border-accent)]"
              />
            </label>
            <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
              {resultError && <p role="alert" className="mb-3 text-xs text-red-300">{resultError}</p>}
              {resultLoading && !searchedResults.length && <p role="status" className="flex items-center justify-center gap-2 p-8 text-sm text-[var(--text-muted)]"><Loader2 className="h-4 w-4 animate-spin" />Đang tải nhật ký…</p>}
              {searchedResults.length ? (
                <div className="space-y-2">
                  {searchedResults.map((fixture: any) => {
                    const isDraw = !fixture.winner_id;
                    const loser = fixture.winner_id === fixture.player1_id
                      ? fixture.player2
                      : fixture.player1;
                    const isPersonalWin = fixture.winner_id === user.id;
                    const isPersonalDraw = !fixture.winner_id;
                    const personalCoefficient = isPersonalDraw
                      ? 0
                      : fixture.winner_id === user.id
                      ? -(Number(fixture.move_count) || 0)
                      : Number(fixture.move_count) || 0;
                    return (
                      <article
                        key={fixture.id}
                        className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-3"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-xs text-[var(--text-muted)]">
                            {(fixture.phase || fixture.tournament_phase) === 'knockout'
                              ? `Knock-out · Vòng ${fixture.round_number}`
                              : `Bảng ${fixture.group_number} · Vòng ${fixture.round_number} · Lượt ${fixture.leg}`}
                          </p>
                          <span className={`rounded-full px-2 py-1 text-[10px] font-bold ${isDraw ? 'bg-amber-500/10 text-amber-300' : resultsFor === 'mine' && !isPersonalWin ? 'bg-red-500/10 text-red-300' : 'bg-emerald-500/10 text-emerald-300'}`}>
                            {resultsFor === 'mine'
                              ? tournamentGameOutcome(fixture,user.id)
                              : isDraw ? 'HÒA' : `THẮNG: ${fixture.winner}`}
                          </span>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold text-[var(--text-primary)]">
                          <span className={fixture.player1_id===user.id ? 'text-orange-300' : ''}>{fixture.player1}{fixture.player1_id===user.id ? ' (Bạn)' : ''}</span>
                          <span className="text-xs font-bold text-[var(--accent-primary)]">
                            {fixture.series_best_of === 3 ? `${Number(fixture.player1_score || 0)}–${Number(fixture.player2_score || 0)} · BO3` : 'vs'}
                          </span>
                          <span className={fixture.player2_id===user.id ? 'text-orange-300' : ''}>{fixture.player2}{fixture.player2_id===user.id ? ' (Bạn)' : ''}</span>
                        </div>
                        {resultsFor === 'all' && !isDraw && (
                          <p className="mt-1 text-xs text-[var(--text-muted)]">Thua: {loser}</p>
                        )}
                        {fixture.move_count != null && (
                          <p className="mt-1 text-[10px] text-[var(--text-muted)]">
                            {fixture.move_count} nước
                            {resultsFor === 'mine' && fixture.phase !== 'knockout' && (
                              <> · Hệ số trận {personalCoefficient > 0 ? '+' : ''}{personalCoefficient}</>
                            )}
                            {fixture.completed_at && (
                              <> · {new Date(fixture.completed_at).toLocaleString('vi-VN')}</>
                            )}
                            {' · '}Mã trận {String(fixture.match_id || fixture.id).slice(0, 8)}
                          </p>
                        )}
                      </article>
                    );
                  })}
                </div>
              ) : !resultLoading && !resultError ? (
                <div className="rounded-xl border border-dashed border-[var(--border-subtle)] p-8 text-center text-sm text-[var(--text-muted)]">
                  {resultSearch.trim()
                    ? 'Không tìm thấy trận phù hợp.'
                    : resultsFor === 'mine'
                    ? `Bạn chưa có ván nào hoàn tất ở ${resultPhase === 'knockout' ? 'Knock-Out' : 'vòng bảng'}.`
                    : 'Chưa có trận nào hoàn tất. Kết quả sẽ xuất hiện tại đây sau khi Bot thi đấu.'}
                </div>
              ) : null}
              {resultCursor && <div className="mt-4 text-center"><p className="mb-2 text-[10px] text-[var(--text-muted)]">Đã tải {searchedResults.length}/{resultTotal} ván</p><button type="button" disabled={resultLoading} onClick={()=>void loadMoreResults()} className="rounded-xl border border-orange-400/30 px-4 py-2 text-xs font-bold text-orange-300 disabled:opacity-50">{resultLoading ? 'Đang tải…' : 'Xem thêm trận'}</button></div>}
            </div>
          </section>
        </div>
      )}

      {confirmCancel && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
        >
          <section
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="cancel-tournament-heading"
            className="w-full max-w-md rounded-2xl border border-red-500/40 bg-[#150e23] p-5 shadow-2xl"
          >
            <h3 id="cancel-tournament-heading" className="text-lg font-bold text-red-300">
              Xác nhận hủy giải đấu?
            </h3>
            <p className="mt-2 text-sm text-[var(--text-secondary)]">
              Giải “{tournament.name}” sẽ bị hủy, các trận đang chạy sẽ dừng và giải được gỡ khỏi danh sách.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                disabled={submitting}
                onClick={() => setConfirmCancel(false)}
                className="rounded-xl border border-[var(--border-subtle)] px-4 py-2 text-xs text-[var(--text-secondary)] disabled:opacity-50"
              >
                Quay lại
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={cancelTournament}
                className="rounded-xl bg-red-600 px-4 py-2 text-xs font-semibold text-white hover:bg-red-500 disabled:opacity-50"
              >
                {submitting ? 'Đang hủy…' : 'Xác nhận hủy giải'}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
};
