import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  BookOpen,
  CheckCircle2,
  CloudUpload,
  Grid3X3,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Settings2,
  Shuffle,
  SkipForward,
  Terminal,
  X,
} from 'lucide-react';
import {
  OTTGameEngine,
  PIECE_VIET_NAMES,
  type GameState,
  type ValidMove,
} from '../core/ottEngine';
import { BotRunner } from '../core/botRunner';
import { SAMPLE_BOT_LABELS, SAMPLE_BOTS, type SampleBotKey } from '../core/sampleBots';
import { soundFx } from '../core/soundFx';
import { Board9x9 } from '../components/Board9x9';
import { PythonBotDocs, PYTHON_BOT_DOCS_TITLE } from '../components/PythonBotDocs';
import { MascotCountsInline } from '../components/HalloweenPieces';
import { useToast } from '../components/ToastProvider';
import type { BackendUser } from '../core/backendClient';

type SandboxControllerType =
  | 'editor'
  | 'human'
  | 'phantom_hunter'
  | 'minimax'
  | 'greedy'
  | 'random';

interface BotLabViewProps {
  user: BackendUser | null;
  themeMode: 'halloween' | 'standard';
  editorCode: string;
  onEditorCodeChange: (code: string) => void;
  savedBotVersion: number;
  onSaveBotToServer: (code: string) => Promise<void>;
  onOpenAuth: (tab?: 'login' | 'register') => void;
}

interface LabLogItem {
  step: number;
  text: string;
  elapsedMs?: number;
  isError?: boolean;
}

export const BotLabView: React.FC<BotLabViewProps> = ({
  user,
  themeMode,
  editorCode,
  onEditorCodeChange,
  savedBotVersion,
  onSaveBotToServer,
  onOpenAuth,
}) => {
  const { notify } = useToast();

  // Match Sandbox Configuration
  const [p1Controller, setP1Controller] = useState<SandboxControllerType>('editor');
  const [p2Controller, setP2Controller] = useState<SandboxControllerType>('phantom_hunter');
  const [blockedCells, setBlockedCells] = useState<number[]>([]);
  const [pieceCount, setPieceCount] = useState<number>(9);
  const [seed, setSeed] = useState<number>(20261031);
  const [delayMs, setDelayMs] = useState<number>(300);
  const [tleMs, setTleMs] = useState<number>(500);
  const [workspaceLayer, setWorkspaceLayer] = useState<'board' | null>(null);
  const [showDocs, setShowDocs] = useState(false);
  const docsTriggerRef = useRef<HTMLButtonElement>(null);
  const editorFrameRef = useRef<HTMLDivElement>(null);
  const sandboxPanelRef = useRef<HTMLDivElement>(null);
  const [docsHeight, setDocsHeight] = useState(480);
  const [docsHeaderHeight, setDocsHeaderHeight] = useState(96);
  useLayoutEffect(() => {
    if (!showDocs) return;
    const editor = editorFrameRef.current;
    const sandbox = sandboxPanelRef.current;
    if (!editor || !sandbox) return;
    const measure = () => {
      const editorBounds = editor.getBoundingClientRect();
      const sandboxBounds = sandbox.getBoundingClientRect();
      const padding = parseFloat(getComputedStyle(sandbox).paddingTop) || 0;
      const sideBySide = sandboxBounds.left >= editorBounds.right;
      const editorToolbar = editor.firstElementChild?.getBoundingClientRect();
      setDocsHeaderHeight(sideBySide && editorToolbar
        ? Math.max(72, editorToolbar.bottom - sandboxBounds.top - padding - 2)
        : 96);
      setDocsHeight(Math.max(240, sideBySide
        ? editorBounds.bottom - sandboxBounds.top - padding - 1
        : editorBounds.height));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(editor);
    observer.observe(sandbox);
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [showDocs]);
  const closeDocs = () => { setShowDocs(false); docsTriggerRef.current?.focus(); };
  const [showTournamentRules, setShowTournamentRules] = useState(false);
  const [boardDraft, setBoardDraft] = useState<number[]>([]);

  // Game State
  const [gameState, setGameState] = useState<GameState>(() =>
    OTTGameEngine.createGame(20261031, 9, null)
  );
  const stateRef = useRef<GameState>(gameState);
  stateRef.current = gameState;

  const [running, setRunning] = useState(false);
  const [loadingBots, setLoadingBots] = useState(false);
  const [selectedCell, setSelectedCell] = useState<number | null>(null);
  const [validMoves, setValidMoves] = useState<ValidMove[]>([]);
  const [logs, setLogs] = useState<LabLogItem[]>([]);

  // Editor & Pyodide Actions
  const [checkingSyntax, setCheckingSyntax] = useState(false);
  const [savingServer, setSavingServer] = useState(false);
  const [syntaxStatus, setSyntaxStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  const runner1Ref = useRef<BotRunner | null>(null);
  const runner2Ref = useRef<BotRunner | null>(null);
  const steppingRef = useRef(false);

  const destroyRunners = useCallback(() => {
    runner1Ref.current?.destroy();
    runner2Ref.current?.destroy();
    runner1Ref.current = null;
    runner2Ref.current = null;
  }, []);

  useEffect(() => {
    return () => destroyRunners();
  }, [destroyRunners]);

  const resetSandbox = useCallback(
    (nextSeed = seed, nextCount = pieceCount, nextBlockedCells = blockedCells) => {
      setRunning(false);
      destroyRunners();
      const rules = nextBlockedCells.length
        ? {
            id: 'sandbox-custom',
            title: 'Bàn tùy chỉnh',
            week: 1,
            rows: 9,
            cols: 9,
            blockedCells: [...nextBlockedCells],
          }
        : null;
      const fresh = OTTGameEngine.createGame(nextSeed, nextCount, rules);
      stateRef.current = fresh;
      setGameState(fresh);
      setSelectedCell(null);
      setValidMoves([]);
      setLogs([]);
    },
    [blockedCells, destroyRunners, pieceCount, seed]
  );

  const resolveControllerCode = useCallback(
    (ctrl: SandboxControllerType): string => {
      if (ctrl === 'editor') return editorCode;
      if (ctrl === 'human') return '';
      return SAMPLE_BOTS[ctrl as SampleBotKey] || SAMPLE_BOTS.minimax;
    },
    [editorCode]
  );

  const ensureRunnerReady = useCallback(
    async (seat: 1 | 2, ctrl: SandboxControllerType): Promise<BotRunner | null> => {
      if (ctrl === 'human') return null;
      const existing = seat === 1 ? runner1Ref.current : runner2Ref.current;
      if (existing?.ready) {
        existing.timeoutMs = tleMs;
        return existing;
      }
      const code = resolveControllerCode(ctrl);
      const runner = new BotRunner(`P${seat} (${ctrl})`, tleMs);
      await runner.loadBot(code, `P${seat} · ${ctrl}`);
      if (seat === 1) runner1Ref.current = runner;
      else runner2Ref.current = runner;
      return runner;
    },
    [resolveControllerCode, tleMs]
  );

  const executeSingleBotTurn = useCallback(async () => {
    const curr = stateRef.current;
    if (OTTGameEngine.isGameOver(curr) || steppingRef.current) return;
    const seat = curr.turn;
    const ctrl = seat === 1 ? p1Controller : p2Controller;
    if (ctrl === 'human') return;

    steppingRef.current = true;
    try {
      setLoadingBots(true);
      const runner = await ensureRunnerReady(seat, ctrl);
      setLoadingBots(false);
      if (!runner) return;

      const botView = OTTGameEngine.createBotGameState(curr, seat);
      const res = await runner.getMove(seat, botView);
      const next = OTTGameEngine.applyMove(curr, { from: res.from, to: res.to });
      stateRef.current = next;
      setGameState(next);

      if (next.lastMove?.isAttack) soundFx.playCapture();
      else soundFx.playMove();

      const pName = next.lastMove ? PIECE_VIET_NAMES[next.lastMove.piece] : 'Quân';
      setLogs((prev) => [
        ...prev,
        {
          step: next.stepCount,
          text: `P${seat} ${pName} ${OTTGameEngine.toAlgebraic(res.from)} → ${OTTGameEngine.toAlgebraic(
            res.to
          )}${next.lastMove?.isAttack ? ' · Ăn quân' : ''}`,
          elapsedMs: res.elapsedMs,
        },
      ]);

      if (OTTGameEngine.isGameOver(next)) {
        setRunning(false);
        if (next.winner) soundFx.playVictory();
      }
    } catch (err: any) {
      setLoadingBots(false);
      setRunning(false);
      setLogs((prev) => [
        ...prev,
        {
          step: curr.stepCount + 1,
          text: `P${seat} lỗi/TLE: ${err.message}`,
          isError: true,
        },
      ]);
      notify(err.message || 'Bot gặp lỗi khi tính nước đi.', 'error');
    } finally {
      steppingRef.current = false;
    }
  }, [ensureRunnerReady, notify, p1Controller, p2Controller]);

  // Continuous loop while `running === true`
  useEffect(() => {
    if (!running || OTTGameEngine.isGameOver(gameState)) return;
    const currentCtrl = gameState.turn === 1 ? p1Controller : p2Controller;
    if (currentCtrl === 'human') return;

    const timer = setTimeout(() => {
      executeSingleBotTurn();
    }, delayMs);

    return () => clearTimeout(timer);
  }, [delayMs, executeSingleBotTurn, gameState, p1Controller, p2Controller, running]);

  const handleBoardClick = (idx: number) => {
    const curr = stateRef.current;
    if (OTTGameEngine.isGameOver(curr)) return;
    const activeCtrl = curr.turn === 1 ? p1Controller : p2Controller;
    if (activeCtrl !== 'human') return;

    if (selectedCell !== null) {
      const candidate = validMoves.find((m) => m.to === idx);
      if (candidate) {
        const next = OTTGameEngine.applyMove(curr, { from: candidate.from, to: candidate.to });
        stateRef.current = next;
        setGameState(next);
        setSelectedCell(null);
        setValidMoves([]);
        if (next.lastMove?.isAttack) soundFx.playCapture();
        else soundFx.playMove();

        const pName = next.lastMove ? PIECE_VIET_NAMES[next.lastMove.piece] : 'Quân';
        setLogs((prev) => [
          ...prev,
          {
            step: next.stepCount,
            text: `P${curr.turn} (Người) ${pName} ${OTTGameEngine.toAlgebraic(
              candidate.from
            )} → ${OTTGameEngine.toAlgebraic(candidate.to)}${
              next.lastMove?.isAttack ? ' · Ăn quân' : ''
            }`,
          },
        ]);
        if (OTTGameEngine.isGameOver(next)) {
          setRunning(false);
          if (next.winner) soundFx.playVictory();
        }
        return;
      }
    }

    const piece = curr.board[idx];
    const owner = piece ? (piece <= 3 ? 1 : 2) : null;
    if (owner === curr.turn) {
      soundFx.playSelect();
      setSelectedCell(idx);
      setValidMoves(OTTGameEngine.getValidMoves(curr, idx));
    } else {
      setSelectedCell(null);
      setValidMoves([]);
    }
  };

  const handleCheckSyntax = async () => {
    setCheckingSyntax(true);
    setSyntaxStatus(null);
    const res = await BotRunner.checkSyntax(editorCode);
    setCheckingSyntax(false);
    if (res.ok) {
      setSyntaxStatus({
        ok: true,
        msg: 'Cú pháp Python 3 hợp lệ và đã khai báo hàm get_next_move sẵn sàng thi đấu.',
      });
      notify('Kiểm tra cú pháp Python thành công!', 'success');
    } else {
      setSyntaxStatus({ ok: false, msg: res.error || 'Mã Python không hợp lệ.' });
      notify(res.error || 'Phát hiện lỗi trong mã Python.', 'error');
    }
  };

  const handleSaveServer = async () => {
    if (!user) {
      onOpenAuth('login');
      return;
    }
    setSavingServer(true);
    try {
      await onSaveBotToServer(editorCode);
      // Force reload editor bot runner on next match run
      if (p1Controller === 'editor') {
        runner1Ref.current?.destroy();
        runner1Ref.current = null;
      }
      if (p2Controller === 'editor') {
        runner2Ref.current?.destroy();
        runner2Ref.current = null;
      }
    } finally {
      setSavingServer(false);
    }
  };

  const handleTextareaKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const target = e.currentTarget;
      const start = target.selectionStart;
      const end = target.selectionEnd;
      const updated = editorCode.substring(0, start) + '    ' + editorCode.substring(end);
      onEditorCodeChange(updated);
      requestAnimationFrame(() => {
        target.selectionStart = target.selectionEnd = start + 4;
      });
    }
  };

  const counts = OTTGameEngine.countPieces(gameState.board);
  const gameFinished = OTTGameEngine.isGameOver(gameState);
  const isHumanTurnNow =
    !gameFinished &&
    ((gameState.turn === 1 && p1Controller === 'human') ||
      (gameState.turn === 2 && p2Controller === 'human'));

  return (
    <div className="space-y-6">
      {/* Split 50/50 Lab Workspace */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-stretch">
        {/* LEFT COLUMN: Python 3 Code Editor & Bot API Docs */}
        <div className="xl:col-span-6 p-5 sm:p-6 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold text-[var(--text-primary)] flex items-center gap-2">
                <Terminal className="w-5 h-5 text-[var(--accent-primary)]" />
                Trình Soạn Thảo Bot Python 3
              </h2>
              <p className="text-xs text-[var(--text-secondary)] mt-0.5 tabular-nums">
                Chạy cô lập trong Web Worker Pyodide ·{' '}
                {savedBotVersion > 0
                  ? `Đang lưu bản v${savedBotVersion} trên tài khoản`
                  : 'Chưa lưu lên tài khoản'}
              </p>
            </div>

            <div className="flex items-center gap-2">
              <select
                defaultValue=""
                onChange={(e) => {
                  const key = e.target.value as SampleBotKey;
                  if (!key) return;
                  onEditorCodeChange(SAMPLE_BOTS[key]);
                  setSyntaxStatus(null);
                  notify(`Đã nạp mẫu "${SAMPLE_BOT_LABELS[key].name}" vào trình soạn thảo.`, 'info');
                  e.target.value = '';
                }}
                aria-label="Nạp mẫu thuật toán Python"
                className="px-3 py-2 text-xs rounded-xl bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
              >
                <option value="" disabled>
                  Nạp Bot mẫu…
                </option>
                {(Object.keys(SAMPLE_BOT_LABELS) as SampleBotKey[]).map((k) => (
                  <option key={k} value={k}>
                    {SAMPLE_BOT_LABELS[k].name} ({SAMPLE_BOT_LABELS[k].difficulty})
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Code Editor Textarea */}
          <div ref={editorFrameRef} className="relative rounded-xl overflow-hidden border border-[var(--border-subtle)] bg-[#09080f]">
            <div className="flex items-center justify-between px-3.5 py-2 border-b border-white/[0.06] text-[11px] font-mono text-[var(--text-muted)]">
              <span>bot.py · def get_next_move(my_player_id, game_state)</span>
              <span>{editorCode.split('\n').length} dòng</span>
            </div>
            <textarea
              value={editorCode}
              onChange={(e) => {
                onEditorCodeChange(e.target.value);
                if (syntaxStatus) setSyntaxStatus(null);
              }}
              onKeyDown={handleTextareaKeyDown}
              spellCheck={false}
              rows={20}
              aria-label="Mã nguồn Python 3 của Bot"
              className="code-editor w-full p-4 bg-transparent text-xs sm:text-[13px] leading-relaxed text-emerald-100 focus:outline-none resize-y min-h-[380px]"
            />

          </div>

          {/* Syntax feedback */}
          {syntaxStatus && (
            <div
              className={`p-3 rounded-xl border text-xs ${
                syntaxStatus.ok
                  ? 'border-emerald-500/35 bg-emerald-950/25 text-emerald-300'
                  : 'border-red-500/35 bg-red-950/25 text-red-300'
              }`}
            >
              {syntaxStatus.msg}
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <button
              type="button"
              disabled={checkingSyntax}
              onClick={handleCheckSyntax}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-semibold border border-[var(--border-subtle)] bg-[var(--bg-canvas)] text-[var(--text-primary)] hover:border-[var(--accent-primary)] disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              {checkingSyntax ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              )}
              Kiểm tra cú pháp Python
            </button>

            <button
              type="button"
              disabled={savingServer}
              onClick={handleSaveServer}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs font-semibold text-white bg-[var(--accent-primary)] hover:bg-[var(--accent-primary-hover)] disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              {savingServer ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <CloudUpload className="w-4 h-4" />
              )}
              {user ? 'Lưu Bot lên Tài khoản' : 'Đăng nhập để Lưu Bot'}
            </button>
          </div>

          <button
            type="button"
            ref={docsTriggerRef}
            onClick={() => setShowDocs(true)}
            aria-expanded={showDocs}
            aria-controls={showDocs ? 'editor-python-docs-title' : undefined}
            className="flex w-full items-center justify-between gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-4 py-3 text-left text-xs font-semibold text-[var(--text-primary)] hover:border-[var(--accent-primary)] transition-colors"
          >
            <span className="inline-flex items-center gap-2">
              <BookOpen className="h-4 w-4 text-[var(--accent-primary)]" />
              {PYTHON_BOT_DOCS_TITLE}
            </span>
            <span className="text-[var(--accent-primary)]">Mở tài liệu →</span>
          </button>

          {/* Compact Move & TLE Log */}
          <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-3">
            <div className="mb-2 flex items-center justify-between text-xs text-[var(--text-secondary)]">
              <span className="font-semibold text-[var(--text-primary)]">Nhật ký thực thi & thời gian phản hồi</span>
              <span className="font-mono tabular-nums">{logs.length} nước</span>
            </div>
            <div className="h-28 space-y-1 overflow-y-auto pr-1 font-mono text-xs tabular-nums">
              {logs.length === 0 ? (
                <div className="py-6 text-center text-[var(--text-muted)]">
                  Bấm "Chạy thử" hoặc "1 Bước" để kiểm tra tốc độ phản hồi của thuật toán.
                </div>
              ) : (
                logs.slice(-30).map((item, i) => (
                  <div
                    key={`${item.step}-${i}`}
                    className={`flex items-center justify-between rounded px-2 py-1 ${
                      item.isError ? 'bg-red-500/15 text-red-300' : 'text-[var(--text-secondary)]'
                    }`}
                  >
                    <span>
                      #{String(item.step).padStart(2, '0')} {item.text}
                    </span>
                    {item.elapsedMs !== undefined && (
                      <span className="text-[var(--text-muted)]">{item.elapsedMs}ms</span>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN: Sandbox and documentation layer */}
        <div ref={sandboxPanelRef} className="xl:col-span-6 p-5 sm:p-6 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)]">
            {showDocs ? (
              <section
                role="region"
                aria-labelledby="editor-python-docs-title"
                onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); closeDocs(); } }}
                style={{ height: docsHeight }}
                className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[#150e23]"
              >
                <div style={{ height: docsHeaderHeight }} className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--border-subtle)] px-4 py-4 sm:px-5">
                  <h3 id="editor-python-docs-title" className="text-lg font-bold leading-snug text-[var(--text-primary)] sm:text-xl">
                    {PYTHON_BOT_DOCS_TITLE}
                  </h3>
                  <button type="button" autoFocus onClick={closeDocs}
                    aria-label="Đóng tài liệu, quay lại bàn thử nghiệm"
                    className="shrink-0 rounded-lg p-1.5 text-[var(--text-secondary)] hover:bg-white/10">
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
                  <PythonBotDocs />
                </div>
              </section>
            ) : workspaceLayer ? (
            <div className="flex h-full max-h-[900px] min-h-0 flex-col">
              <div className="mb-4 flex items-center justify-between gap-3 border-b border-[var(--border-subtle)] pb-3">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setWorkspaceLayer(null)}
                    aria-label="Quay lại bàn thử nghiệm"
                    className="rounded-lg p-2 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-white"
                  >
                    <ArrowLeft className="h-4 w-4" />
                  </button>
                  <h2 className="text-base font-bold text-[var(--text-primary)]">
                    Điều chỉnh bàn đấu
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={() => setWorkspaceLayer(null)}
                  aria-label="Đóng lớp"
                  className="rounded-lg p-2 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {(
                <div className="flex min-h-0 flex-1 flex-col">
                  <p className="mb-3 text-xs text-[var(--text-secondary)]">
                    Chọn ô để thêm hoặc bỏ chướng ngại. Mỗi thay đổi được áp dụng đối xứng qua đường chéo chính; hai ô đích không thể bị chặn.
                  </p>
                  <div className="mx-auto grid aspect-square w-full max-w-[500px] grid-cols-9 overflow-hidden rounded-xl border border-[var(--border-subtle)]">
                    {Array.from({ length: 81 }, (_, index) => {
                      const row = Math.floor(index / 9);
                      const col = index % 9;
                      const isTarget = index === 8 || index === 72;
                      const isBlocked = boardDraft.includes(index);
                      const oppositeIndex = col * 9 + row;
                      return (
                        <button
                          key={index}
                          type="button"
                          disabled={isTarget}
                          aria-label={`${String.fromCharCode(97 + col)}${9 - row}${isBlocked ? ', chướng ngại' : ''}`}
                          aria-pressed={isBlocked}
                          title={isTarget ? 'Ô đích không thể bị chặn' : `Đổi cả ô ${String.fromCharCode(97 + col)}${9 - row} và ô đối xứng`}
                          onClick={() =>
                            setBoardDraft((current) => {
                              const pair = new Set([index, oppositeIndex]);
                              return isBlocked
                                ? current.filter((cell) => !pair.has(cell))
                                : [...current.filter((cell) => !pair.has(cell)), ...pair];
                            })
                          }
                          className={`aspect-square min-w-0 border-r border-b border-black/30 text-[10px] transition-colors ${
                            isTarget
                              ? 'cursor-not-allowed bg-orange-700/70 text-white'
                              : isBlocked
                              ? 'bg-slate-500 text-white'
                              : (row + col) % 2
                              ? 'bg-[#21172f] text-transparent hover:bg-orange-500/60'
                              : 'bg-[#30213f] text-transparent hover:bg-orange-500/60'
                          }`}
                        >
                          {isTarget ? '◆' : isBlocked ? '■' : '·'}
                        </button>
                      );
                    })}
                  </div>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="text-[var(--text-muted)]">{boardDraft.length} ô chướng ngại</span>
                    <button
                      type="button"
                      onClick={() => setBoardDraft([])}
                      disabled={!boardDraft.length}
                      className="rounded-lg border border-[var(--border-subtle)] px-3 py-1.5 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-40"
                    >
                      Xóa chướng ngại
                    </button>
                  </div>
                  <div className="mt-auto flex justify-end gap-2 border-t border-[var(--border-subtle)] pt-4">
                    <button
                      type="button"
                      onClick={() => setWorkspaceLayer(null)}
                      className="rounded-xl px-4 py-2 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                    >
                      Hủy
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const nextBlockedCells = [...boardDraft];
                        setBlockedCells(nextBlockedCells);
                        resetSandbox(seed, pieceCount, nextBlockedCells);
                        setWorkspaceLayer(null);
                      }}
                      className="rounded-xl bg-[var(--accent-primary)] px-4 py-2 text-xs font-semibold text-white hover:bg-[var(--accent-primary-hover)]"
                    >
                      Áp dụng bàn đấu
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
          <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold text-[var(--text-primary)]">
                Bàn Thử Nghiệm Chiến Thuật 9×9
              </h2>
              <p className="text-xs text-[var(--text-secondary)] tabular-nums">
                Seed {seed} · {pieceCount} quân mỗi bên · Lượt #{gameState.stepCount}
              </p>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowTournamentRules(true)}
                className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-3 py-2 text-xs font-medium text-[var(--text-primary)] hover:border-[var(--accent-primary)] transition-colors"
              >
                <BookOpen className="h-3.5 w-3.5 text-[var(--accent-primary)]" />
                Thể thức
              </button>
              <button
                type="button"
                disabled={loadingBots || gameFinished}
                onClick={() => {
                  // Reset runners if code was edited before starting
                  if (!running) {
                    if (p1Controller === 'editor') {
                      runner1Ref.current?.destroy();
                      runner1Ref.current = null;
                    }
                    if (p2Controller === 'editor') {
                      runner2Ref.current?.destroy();
                      runner2Ref.current = null;
                    }
                  }
                  setRunning((r) => !r);
                }}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold text-white bg-[var(--accent-primary)] hover:bg-[var(--accent-primary-hover)] disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                {loadingBots ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Nạp Pyodide…
                  </>
                ) : running ? (
                  <>
                    <Pause className="w-3.5 h-3.5" />
                    Tạm dừng
                  </>
                ) : (
                  <>
                    <Play className="w-3.5 h-3.5" />
                    Chạy thử
                  </>
                )}
              </button>

              <button
                type="button"
                disabled={running || loadingBots || gameFinished || isHumanTurnNow}
                onClick={executeSingleBotTurn}
                title="Chạy từng bước 1 nước của Bot"
                className="inline-flex items-center gap-1 px-3 py-2 rounded-xl text-xs font-medium border border-[var(--border-subtle)] bg-[var(--bg-canvas)] text-[var(--text-primary)] hover:border-[var(--accent-primary)] disabled:opacity-40 transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                <SkipForward className="w-3.5 h-3.5" />
                1 Bước
              </button>

              <button
                type="button"
                onClick={() => resetSandbox()}
                title="Đặt lại bàn cờ về lượt 0"
                className="inline-flex items-center gap-1 px-3 py-2 rounded-xl text-xs font-medium border border-[var(--border-subtle)] bg-[var(--bg-canvas)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Đặt lại
              </button>
            </div>
          </div>

          {/* Player 1 & Player 2 Controller Selectors */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="p-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-canvas)] space-y-1.5">
              <div className="flex flex-wrap items-center justify-between gap-1 text-xs">
                <span className="font-bold text-[var(--p1-main)]">Phe 1 (Cam)</span>
                <MascotCountsInline counts={counts[1]} team={1} compact />
              </div>
              <select
                value={p1Controller}
                onChange={(e) => {
                  const v = e.target.value as SandboxControllerType;
                  setP1Controller(v);
                  runner1Ref.current?.destroy();
                  runner1Ref.current = null;
                }}
                aria-label="Chọn điều khiển Phe 1"
                className="w-full px-2.5 py-1.5 text-xs rounded-lg bg-[var(--bg-elevated)] border border-[var(--border-subtle)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
              >
                <option value="editor">Code đang soạn trong Editor</option>
                <option value="human">Người tự cầm quân (Click chuột)</option>
                <option value="phantom_hunter">Bot mẫu · Phantom Hunter (Halloween)</option>
                <option value="minimax">Bot mẫu · Minimax Tactical</option>
                <option value="greedy">Bot mẫu · Greedy AI</option>
                <option value="random">Bot mẫu · Random Bot</option>
              </select>
            </div>

            <div className="p-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-canvas)] space-y-1.5">
              <div className="flex flex-wrap items-center justify-between gap-1 text-xs">
                <span className="font-bold text-[var(--p2-main)]">Phe 2 (Tím)</span>
                <MascotCountsInline counts={counts[2]} team={2} compact />
              </div>
              <select
                value={p2Controller}
                onChange={(e) => {
                  const v = e.target.value as SandboxControllerType;
                  setP2Controller(v);
                  runner2Ref.current?.destroy();
                  runner2Ref.current = null;
                }}
                aria-label="Chọn điều khiển Phe 2"
                className="w-full px-2.5 py-1.5 text-xs rounded-lg bg-[var(--bg-elevated)] border border-[var(--border-subtle)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
              >
                <option value="phantom_hunter">Bot mẫu · Phantom Hunter (Halloween)</option>
                <option value="minimax">Bot mẫu · Minimax Tactical</option>
                <option value="greedy">Bot mẫu · Greedy AI</option>
                <option value="random">Bot mẫu · Random Bot</option>
                <option value="editor">Code đang soạn trong Editor</option>
                <option value="human">Người tự cầm quân (Click chuột)</option>
              </select>
            </div>
          </div>

          {/* Sandbox Parameters Row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs">
            <div>
              <span className="mb-1 block text-[11px] text-[var(--text-muted)]">Bàn đấu</span>
              <button
                type="button"
                onClick={() => {
                  setBoardDraft([...blockedCells]);
                  setWorkspaceLayer('board');
                }}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1.5 text-[var(--text-primary)] hover:border-[var(--accent-primary)]"
              >
                <Settings2 className="h-3.5 w-3.5" />
                Chướng ngại ({blockedCells.length})
              </button>
            </div>

            <div>
              <label className="block text-[11px] text-[var(--text-muted)] mb-1">Số quân / phe</label>
              <select
                value={pieceCount}
                onChange={(e) => {
                  const nextCount = Number(e.target.value);
                  setPieceCount(nextCount);
                  resetSandbox(seed, nextCount, blockedCells);
                }}
                className="w-full px-2.5 py-1.5 rounded-lg bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-[var(--text-primary)] font-mono"
              >
                {[6, 9, 12, 15, 18].map((n) => (
                  <option key={n} value={n}>
                    {n} quân
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-[11px] text-[var(--text-muted)] mb-1">Nhịp độ chạy</label>
              <select
                value={delayMs}
                onChange={(e) => setDelayMs(Number(e.target.value))}
                className="w-full px-2.5 py-1.5 rounded-lg bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-[var(--text-primary)] font-mono"
              >
                <option value={80}>Nhanh (80ms)</option>
                <option value={300}>Vừa (300ms)</option>
                <option value={650}>Chậm (650ms)</option>
              </select>
            </div>

            <div>
              <label className="block text-[11px] text-[var(--text-muted)] mb-1">Giới hạn TLE</label>
              <select
                value={tleMs}
                onChange={(e) => setTleMs(Number(e.target.value))}
                className="w-full px-2.5 py-1.5 rounded-lg bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-[var(--text-primary)] font-mono"
              >
                <option value={200}>200 ms (Chuẩn giải)</option>
                <option value={500}>500 ms</option>
                <option value={1500}>1500 ms (Debug)</option>
              </select>
            </div>
          </div>

          {/* Status Strip + Random Seed */}
          <div className="flex items-center justify-between px-3.5 py-2 rounded-xl bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-xs">
            <span className="font-medium text-[var(--text-primary)]">
              {gameFinished
                ? gameState.winner === 0
                  ? `Kết thúc: Hòa cờ sau ${gameState.stepCount} nước!`
                  : `Kết thúc: Phe ${gameState.winner} chiến thắng sau ${gameState.stepCount} nước!`
                : isHumanTurnNow
                ? `Lượt Phe ${gameState.turn} (Bạn) — Chọn quân cờ trên bàn để đi`
                : running
                ? `Đang mô phỏng lượt Phe ${gameState.turn}…`
                : `Sẵn sàng tại lượt Phe ${gameState.turn}`}
            </span>
            <button
              type="button"
              onClick={() => {
                const randomSeed = Math.floor(100000 + Math.random() * 8999999);
                setSeed(randomSeed);
                resetSandbox(randomSeed, pieceCount, blockedCells);
              }}
              className="inline-flex items-center gap-1 text-[var(--accent-primary)] hover:underline cursor-pointer whitespace-nowrap"
            >
              <Shuffle className="w-3.5 h-3.5" />
              Đổi Seed mới
            </button>
          </div>

          {/* 9x9 Board */}
          <Board9x9
            state={gameState}
            selectedCell={selectedCell}
            validMoves={validMoves}
            onCellClick={handleBoardClick}
            interactive={isHumanTurnNow}
            size="normal"
            themeMode={themeMode}
          />

          </div>
          )}
        </div>
      </div>
      {showTournamentRules && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setShowTournamentRules(false);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="sandbox-rules-heading"
            className="w-full max-w-xl max-h-[85vh] overflow-y-auto rounded-2xl border border-[var(--border-accent)] bg-[#150e23] p-5 shadow-2xl sm:p-6"
          >
            <div className="mb-4 flex items-center justify-between gap-3 border-b border-[var(--border-subtle)] pb-3">
              <h2 id="sandbox-rules-heading" className="text-lg font-bold text-[var(--text-primary)]">
                Thể thức thi đấu
              </h2>
              <button
                type="button"
                onClick={() => setShowTournamentRules(false)}
                aria-label="Đóng thể thức thi đấu"
                className="rounded-lg p-2 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="mb-3 text-xs text-[var(--text-secondary)]">
              Áp dụng cho ván thử và Bot khi tham gia thi đấu.
            </p>
            <div className="grid gap-3 text-xs text-[var(--text-secondary)] sm:grid-cols-2">
              <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-3">
                <h3 className="mb-1 font-semibold text-[var(--p1-main)]">Di chuyển</h3>
                <p>Mỗi lượt đi một ô theo chiều ngang hoặc dọc. Không thể đi vào ô có quân cùng phe hay ô chướng ngại.</p>
              </div>
              <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-3">
                <h3 className="mb-1 font-semibold text-[var(--p2-main)]">Khắc chế</h3>
                <p>Đấm thắng Kéo, Kéo thắng Lá, Lá thắng Đấm. Quân cùng hệ không thể ăn nhau.</p>
              </div>
              <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-3">
                <h3 className="mb-1 font-semibold text-[var(--text-primary)]">Điều kiện thắng</h3>
                <p>Loại hết một hệ quân của đối thủ hoặc đưa quân tới ô đích của đối phương.</p>
              </div>
              <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-3">
                <h3 className="mb-1 font-semibold text-[var(--text-primary)]">Luật giới hạn nước đi</h3>
                <p>Nếu giải đặt giới hạn 25 lượt đi, kết quả được phân định theo luật giải; hai bên bằng điểm thì hòa.</p>
              </div>
              <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-3 sm:col-span-2">
                <h3 className="mb-1 font-semibold text-[var(--text-primary)]">Bàn đấu hiện tại</h3>
                <p>{blockedCells.length ? `${blockedCells.length} ô chướng ngại được áp dụng đối xứng trên bàn 9×9.` : 'Bàn 9×9 tiêu chuẩn, chưa có chướng ngại.'} Hai ô đích luôn được giữ thông thoáng.</p>
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
};
