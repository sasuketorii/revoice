import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HistoryRecord, TranscriptionPayload } from './types';

type TranscribeStatus = 'idle' | 'running' | 'success' | 'error';

type LogEntry = {
  id: number;
  timestamp: string;
  message: string;
  level: 'info' | 'error';
};

type DoneEvent = {
  ok: boolean;
  code?: number;
  outputPath?: string | null;
  transcript?: string | null;
};

type HistoryEntry = {
  id: number;
  label: string;
  finishedAt: string;
  outputPath: string | null;
  transcript: string;
  transcriptPreview: string;
  inputPath: string;
  model: string | null;
  language: string | null;
  status: string | null;
  duration: number | null;
};

const HISTORY_PAGE_SIZE = 20;
const PROGRESS_REGEX = /^\[PROGRESS\]\s+(\d+(?:\.\d+)?)$/;
const PREVIEW_MAX_LENGTH = 400;

const BASE_PAYLOAD: Omit<TranscriptionPayload, 'inputPath'> = {
  outputDir: 'archive',
  model: 'large-v3',
  language: 'ja',
  beamSize: 5,
  computeType: 'int8',
  formats: 'txt',
  withTimestamps: true,
  minSegment: 0.6,
  preset: 'balanced',
  memo: false,
};

const STATUS_LABEL: Record<TranscribeStatus, string> = {
  idle: '待機中',
  running: '解析中…',
  success: '完了',
  error: 'エラー',
};

const formatHistoryTime = (iso: string) => {
  try {
    return new Intl.DateTimeFormat('ja-JP', {
      dateStyle: 'medium',
      timeStyle: 'medium',
    }).format(new Date(iso));
  } catch (err) {
    return iso;
  }
};

const fileNameFromPath = (path: string) => path.split(/[\\/]/).pop() ?? path;

const buildHistoryLabel = (record: { inputPath?: string | null; outputPath?: string | null }) => {
  if (record.outputPath) return fileNameFromPath(record.outputPath);
  if (record.inputPath) return fileNameFromPath(record.inputPath);
  return '文字起こし結果';
};

const createPreview = (text: string) => {
  if (!text) return '';
  const trimmed = text.trim();
  if (!trimmed) return '';
  return trimmed.length <= PREVIEW_MAX_LENGTH ? trimmed : `${trimmed.slice(0, PREVIEW_MAX_LENGTH)}…`;
};

const historyRecordToEntry = (record: HistoryRecord): HistoryEntry => ({
  id: record.id,
  label: buildHistoryLabel(record),
  finishedAt: record.createdAt,
  outputPath: record.outputPath ?? null,
  transcript: '',
  transcriptPreview: record.transcriptPreview ? createPreview(record.transcriptPreview) : '',
  inputPath: record.inputPath ?? '',
  model: record.model ?? null,
  language: record.language ?? null,
  status: record.status ?? null,
  duration: record.duration ?? null,
});

const App = () => {
  const [inputPath, setInputPath] = useState('');
  const [status, setStatus] = useState<TranscribeStatus>('idle');
  const [pid, setPid] = useState<number | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [outputPath, setOutputPath] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<string>('');
  const [progress, setProgress] = useState<number | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyCursor, setHistoryCursor] = useState(0);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);

  const logContainerRef = useRef<HTMLDivElement | null>(null);
  const logCounter = useRef(0);
  const lastJobRef = useRef<{ inputPath: string; fileName: string; startedAt: string } | null>(null);
  const pendingHistoryIdRef = useRef<number | null>(null);
  const fallbackHistoryIdRef = useRef(0);

  const statusLabel = useMemo(() => STATUS_LABEL[status], [status]);
  const disabled = status === 'running';

  const appendLog = useCallback((message: string, level: LogEntry['level'] = 'info') => {
    const id = ++logCounter.current;
    const timestamp = new Date().toLocaleTimeString('ja-JP', { hour12: false });
    setLogs((prev) => {
      const next = [...prev, { id, timestamp, message, level }];
      return next.length > 300 ? next.slice(next.length - 300) : next;
    });
  }, []);

  const handleProcessLog = useCallback(
    (chunk: string) => {
      const lines = chunk.split(/\r?\n/);
      for (const raw of lines) {
        const text = raw.trim();
        if (!text) continue;
        const progressMatch = PROGRESS_REGEX.exec(text);
        if (progressMatch) {
          const value = Number(progressMatch[1]);
          if (!Number.isNaN(value)) {
            setProgress(Math.max(0, Math.min(100, value)));
          }
          continue;
        }
        const level = /\bERROR\b|\[ERROR]|\bFAILED\b/.test(text) ? 'error' : 'info';
        appendLog(text, level);
      }
    },
    [appendLog]
  );

  const fetchHistory = useCallback(
    async (offset = 0, append = false) => {
      if (!window.revoice.listHistory) return;
      setHistoryLoading(true);
      try {
        const response = await window.revoice.listHistory({ limit: HISTORY_PAGE_SIZE, offset });
        if (response.ok) {
          const entries = response.items.map((record) => historyRecordToEntry(record));
          setHistory((prev) => {
            if (append && offset > 0) {
              const existingIndex = new Map(prev.map((item, index) => [item.id, index]));
              const next = [...prev];
              for (const entry of entries) {
                if (existingIndex.has(entry.id)) {
                  const idx = existingIndex.get(entry.id);
                  if (idx !== undefined) {
                    next[idx] = entry;
                  }
                } else {
                  next.push(entry);
                }
              }
              return next;
            }
            return entries;
          });
          const nextCursor = append ? offset + entries.length : entries.length;
          setHistoryCursor(nextCursor);
          setHistoryTotal(response.total);
          setHistoryHasMore(nextCursor < response.total);
        } else {
          setHistoryHasMore(false);
          appendLog(`[WARN] 履歴の読み込みに失敗しました: ${response.error ?? '不明なエラー'}`, 'error');
        }
      } catch (err) {
        appendLog(`[WARN] 履歴の読み込み中にエラーが発生しました: ${err}`, 'error');
      } finally {
        setHistoryLoading(false);
      }
    },
    [appendLog]
  );

  const handleDone = useCallback(
    async (result: DoneEvent) => {
      setPid(null);
      if (result.ok) {
        setStatus('success');
        setErrorMessage(null);
        setProgress(100);

        setOutputPath(result.outputPath ?? null);

        let text = '';
        if (typeof result.transcript === 'string' && result.transcript.trim().length > 0) {
          text = result.transcript.trim();
        } else if (result.outputPath && window.revoice.readTextFile) {
          try {
            text = (await window.revoice.readTextFile(result.outputPath)).trim();
          } catch (err) {
            appendLog(`[WARN] 出力ファイルの読み込みに失敗しました: ${err}`, 'error');
          }
        }
        setTranscript(text);
        if (!text) {
          appendLog('注意: 文字起こしファイルが空でした。', 'error');
        }

        appendLog('文字起こしが完了しました。', 'info');
        if (result.outputPath) {
          appendLog(`出力ファイル: ${result.outputPath}`, 'info');
        }

        const job = lastJobRef.current;
        const preview = createPreview(text);
        const historyId = pendingHistoryIdRef.current;

        if (historyId !== null) {
          setHistory((prev) =>
            prev.map((item) =>
              item.id === historyId
                ? {
                    ...item,
                    label: job?.fileName ?? item.label,
                    outputPath: result.outputPath ?? item.outputPath,
                    transcript: text,
                    transcriptPreview: preview || item.transcriptPreview,
                    inputPath: job?.inputPath ?? item.inputPath,
                    status: 'completed',
                  }
                : item
            )
          );
          pendingHistoryIdRef.current = null;
        } else {
          const label = job?.fileName ?? (result.outputPath ? fileNameFromPath(result.outputPath) : '文字起こし結果');
          const fallbackId = -(++fallbackHistoryIdRef.current);
          const entry: HistoryEntry = {
            id: fallbackId,
            label,
            finishedAt: new Date().toISOString(),
            outputPath: result.outputPath ?? null,
            transcript: text,
            transcriptPreview: preview,
            inputPath: job?.inputPath ?? '',
            model: null,
            language: null,
            status: 'completed',
            duration: null,
          };
          setHistory((prev) => [entry, ...prev]);
        }
        lastJobRef.current = null;
      } else {
        setStatus('error');
        const message = `文字起こしに失敗しました (コード: ${result.code ?? '不明'})`;
        setErrorMessage(message);
        setOutputPath(null);
        setTranscript('');
        setProgress(null);
        appendLog(message, 'error');
        lastJobRef.current = null;
        pendingHistoryIdRef.current = null;
      }
    },
    [appendLog]
  );

  useEffect(() => {
    const offPid = window.revoice.onPid((nextPid) => {
      setPid(nextPid);
      appendLog(`プロセス開始 (PID: ${nextPid})`, 'info');
    });

    const offLog = window.revoice.onLog(handleProcessLog);

    const offError = window.revoice.onError((err) => {
      setStatus('error');
      setErrorMessage(err);
      setPid(null);
      setOutputPath(null);
      setTranscript('');
      setProgress(null);
      appendLog(err, 'error');
    });

    const offDone = window.revoice.onDone((result) => {
      void handleDone(result as DoneEvent);
    });

    return () => {
      offPid?.();
      offLog?.();
      offError?.();
      offDone?.();
    };
  }, [appendLog, handleProcessLog, handleDone]);

  useEffect(() => {
    void fetchHistory(0, false);
  }, [fetchHistory]);

  useEffect(() => {
    const disposeAdded = window.revoice.onHistoryAdded?.((record) => {
      pendingHistoryIdRef.current = record.id;
      setHistory((prev) => {
        const entry = historyRecordToEntry(record);
        const filtered = prev.filter((item) => item.id !== entry.id);
        return [entry, ...filtered];
      });
      setHistoryTotal((prev) => Math.max(prev + 1, 1));
      setHistoryCursor((prev) => prev + 1);
      void fetchHistory(0, false);
    });
    const disposeCleared = window.revoice.onHistoryCleared?.((payload) => {
      pendingHistoryIdRef.current = null;
      setHistory([]);
      setHistoryTotal(payload?.total ?? 0);
      setHistoryCursor(0);
      setHistoryHasMore(false);
    });
    const disposeDeleted = window.revoice.onHistoryDeleted?.(() => {
      void fetchHistory(0, false);
    });
    return () => {
      disposeAdded?.();
      disposeCleared?.();
      disposeDeleted?.();
    };
  }, [fetchHistory]);

  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  const handleBrowse = async () => {
    const selected = await window.revoice.openFileDialog();
    if (selected) {
      setInputPath(selected);
      setOutputPath(null);
      setTranscript('');
      setErrorMessage(null);
      setProgress(null);
    }
  };

  const handleStart = () => {
    if (!inputPath) {
      setErrorMessage('入力ファイルを選択してください');
      return;
    }

    const fileName = fileNameFromPath(inputPath);

    setStatus('running');
    setPid(null);
    setErrorMessage(null);
    setLogs([]);
    logCounter.current = 0;
    setOutputPath(null);
    setTranscript('');
    setProgress(0);
    pendingHistoryIdRef.current = null;

    lastJobRef.current = {
      inputPath,
      fileName,
      startedAt: new Date().toISOString(),
    };

    appendLog(`入力ファイル: ${fileName}`, 'info');
    appendLog(`出力先 (予定): ${BASE_PAYLOAD.outputDir}/${fileName.replace(/\.[^.]+$/, '')}.txt`, 'info');
    appendLog('Revoice CLI を起動します…', 'info');

    const payload: TranscriptionPayload = {
      ...BASE_PAYLOAD,
      inputPath,
    };

    window.revoice.startTranscription(payload);
  };

  const handleCancel = () => {
    if (pid) {
      window.revoice.kill(pid);
      appendLog(`PID ${pid} に停止シグナルを送信しました。`, 'info');
      appendLog('処理を中断しました。', 'info');
      setPid(null);
      setStatus('idle');
      setOutputPath(null);
      setTranscript('');
      setProgress(null);
      setErrorMessage('ユーザーによって処理が中断されました');
      lastJobRef.current = null;
    }
  };

  const handleReset = () => {
    setInputPath('');
    setStatus('idle');
    setPid(null);
    setLogs([]);
    logCounter.current = 0;
    setErrorMessage(null);
    setOutputPath(null);
    setTranscript('');
    setProgress(null);
    lastJobRef.current = null;
  };

  const copyText = useCallback(
    async (content: string, successMessage: string, emptyMessage?: string) => {
      if (!content) {
        if (emptyMessage) appendLog(emptyMessage, 'info');
        return;
      }
      if (!navigator?.clipboard?.writeText) {
        appendLog('クリップボード API が利用できません。', 'error');
        return;
      }
      try {
        await navigator.clipboard.writeText(content);
        appendLog(successMessage, 'info');
      } catch (err) {
        appendLog(`クリップボードへのコピーに失敗しました: ${err}`, 'error');
      }
    },
    [appendLog]
  );

  const handleCopyTranscript = () => {
    copyText(transcript, '文字起こしをクリップボードにコピーしました。', 'コピーできる文字起こしがまだありません');
  };

  const handleCopyLogs = () => {
    const body = logs.map((entry) => `[${entry.timestamp}] ${entry.message}`).join('\n');
    copyText(body, 'ログをクリップボードにコピーしました。', 'コピーできるログがまだありません');
  };

  const handleCopyHistoryTranscript = async (entry: HistoryEntry) => {
    if (entry.transcript) {
      await copyText(entry.transcript, '履歴の文字起こしをコピーしました。', 'この履歴にはコピーできる文字起こしがありません');
      return;
    }
    if (entry.outputPath && window.revoice.readTextFile) {
      try {
        const content = (await window.revoice.readTextFile(entry.outputPath)).trim();
        await copyText(content, '履歴の文字起こしをコピーしました。', 'この履歴にはコピーできる文字起こしがありません');
        if (content) {
          setHistory((prev) =>
            prev.map((item) =>
              item.id === entry.id
                ? { ...item, transcript: content, transcriptPreview: createPreview(content) }
                : item
            )
          );
        }
      } catch (err) {
        appendLog(`[WARN] 履歴ファイルの読み込みに失敗しました: ${err}`, 'error');
      }
      return;
    }
    appendLog('この履歴にはコピーできる文字起こしがありません', 'info');
  };

  const handleCopyPath = (path: string) => {
    copyText(path, 'ファイルパスをクリップボードにコピーしました。');
  };

  const handleLoadMoreHistory = useCallback(() => {
    if (historyLoading) return;
    void fetchHistory(historyCursor, true);
  }, [fetchHistory, historyCursor, historyLoading]);

  const handleClearHistory = useCallback(async () => {
    if (!window.revoice.clearHistory) {
      setHistory([]);
      appendLog('履歴をクリアしました。', 'info');
      return;
    }
    try {
      const response = await window.revoice.clearHistory();
      if (response?.ok) {
        setHistory([]);
        setHistoryTotal(0);
        setHistoryCursor(0);
        setHistoryHasMore(false);
        const removed = typeof response.removed === 'number' ? response.removed : null;
        appendLog(
          removed && removed > 0
            ? `履歴をクリアしました (${removed}件削除)`
            : '履歴をクリアしました。',
          'info'
        );
      } else {
        appendLog(`[WARN] 履歴の消去に失敗しました: ${response?.error ?? '不明なエラー'}`, 'error');
      }
    } catch (err) {
      appendLog(`[WARN] 履歴の消去でエラーが発生しました: ${err}`, 'error');
    }
  }, [appendLog]);

  const handleLoadHistory = useCallback(
    async (entry: HistoryEntry) => {
      let text = entry.transcript;
      if (!text && entry.outputPath && window.revoice.readTextFile) {
        try {
          text = (await window.revoice.readTextFile(entry.outputPath)).trim();
          setHistory((prev) =>
            prev.map((item) =>
              item.id === entry.id
                ? { ...item, transcript: text, transcriptPreview: createPreview(text) }
                : item
            )
          );
        } catch (err) {
          appendLog(`[WARN] 履歴ファイルの読み込みに失敗しました: ${err}`, 'error');
        }
      }
      setTranscript(text);
      if (!text) {
        appendLog('注意: 履歴の文字起こしは空です。', 'error');
      }
      setOutputPath(entry.outputPath);
      setStatus('success');
      setProgress(100);
      setErrorMessage(null);
      appendLog(`履歴から「${entry.label}」を表示しました。`, 'info');
    },
    [appendLog]
  );

  const progressLabel = useMemo(() => {
    if (progress === null) return null;
    return `${progress.toFixed(1)}%`;
  }, [progress]);

  return (
    <div className="app-shell">
      <aside className="app-shell__sidebar">
        <div className="sidebar__brand">Revoice</div>
        <div className="sidebar__section">
          <h2>メニュー</h2>
          <ul>
            <li>ダッシュボード</li>
            <li>履歴</li>
            <li>設定</li>
          </ul>
        </div>
        <div className="sidebar__foot">
          <span className="sidebar__status-label">現行ステータス</span>
          <span className={`sidebar__status-value sidebar__status-value--${status}`}>{statusLabel}</span>
        </div>
      </aside>

      <div className="app-shell__main">
        <header className="tab-bar">
          <div className="tab-bar__tabs">
            <button type="button" className="tab-bar__tab tab-bar__tab--active">
              タブ 1
            </button>
          </div>
          <button type="button" className="tab-bar__add" disabled>
            ＋
          </button>
          <div className={`status-pill status-pill--${status}`}>
            <span className="status-pill__label">ステータス</span>
            <span className="status-pill__value">{statusLabel}</span>
          </div>
        </header>

        <div className="workspace">
          <section className="workspace__history">
            <header className="panel__header panel__header--history">
              <h2>履歴</h2>
              <div className="panel__tools">
                <span className="panel__counter">{historyTotal}件</span>
                {history.length > 0 && (
                  <button type="button" className="button button--ghost button--small" onClick={handleClearHistory}>
                    クリア
                  </button>
                )}
              </div>
            </header>
            {history.length === 0 ? (
              <div className="history__placeholder">
                {historyLoading ? '履歴を読み込み中です…' : 'まだ履歴はありません。'}
              </div>
            ) : (
              <>
                <ul className="history">
                  {history.map((entry) => (
                    <li key={entry.id} className="history__item">
                      <div className="history__meta">
                        <div className="history__meta-row">
                          <span className="history__label">{entry.label}</span>
                          {entry.status && (
                            <span className={`history__status history__status--${entry.status}`}>
                              {entry.status === 'completed'
                                ? '完了'
                                : entry.status === 'failed'
                                ? '失敗'
                                : entry.status}
                            </span>
                          )}
                        </div>
                        <span className="history__time">{formatHistoryTime(entry.finishedAt)}</span>
                        {entry.outputPath && <span className="history__path">{entry.outputPath}</span>}
                      </div>
                      <div className="history__actions">
                        <button
                          type="button"
                          className="button button--ghost button--small"
                          onClick={() => {
                            void handleLoadHistory(entry);
                          }}
                        >
                          表示
                        </button>
                        <button
                          type="button"
                          className="button button--ghost button--small"
                          onClick={() => {
                            void handleCopyHistoryTranscript(entry);
                          }}
                        >
                          文字起こしをコピー
                        </button>
                        {entry.outputPath && (
                          <button
                            type="button"
                            className="button button--ghost button--small"
                            onClick={() => handleCopyPath(entry.outputPath!)}
                          >
                            パスをコピー
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
                {historyHasMore && (
                  <button
                    type="button"
                    className="history__more button button--outline"
                    onClick={handleLoadMoreHistory}
                    disabled={historyLoading}
                  >
                    {historyLoading ? '読み込み中…' : 'さらに読み込む'}
                  </button>
                )}
              </>
            )}
          </section>

          <div className="workspace__content">
            <section className="panel panel--upload">
              <header className="panel__header">
                <h2>ファイルを追加</h2>
                <span className="panel__hint">対応形式: wav / mp3 / mp4 / mov など</span>
              </header>
              <div className={`dropzone ${inputPath ? 'dropzone--selected' : ''}`}>
                <div className="dropzone__path">{inputPath || 'ファイルをドラッグ&ドロップ、またはボタンから選択してください'}</div>
                <button type="button" className="button button--primary" onClick={handleBrowse} disabled={disabled}>
                  ファイルを選ぶ
                </button>
              </div>
              <div className="panel__actions">
                <button
                  type="button"
                  className="button button--primary"
                  onClick={handleStart}
                  disabled={disabled || !inputPath}
                >
                  {status === 'running' ? '解析中…' : '文字起こしを開始'}
                </button>
                <button type="button" className="button button--outline" onClick={handleCancel} disabled={!pid}>
                  強制停止
                </button>
                <button type="button" className="button button--subtle" onClick={handleReset} disabled={status === 'running'}>
                  リセット
                </button>
              </div>
              <div className="run-status">
                {pid && <span>実行中の PID: {pid}</span>}
                {outputPath && <span>出力ファイル: {outputPath}</span>}
                {errorMessage && <span className="run-status__error">{errorMessage}</span>}
              </div>
              {progress !== null && (
                <div className="progress">
                  <div className="progress__track">
                    <div className="progress__bar" style={{ width: `${Math.min(progress, 100)}%` }} />
                  </div>
                  <span className="progress__label">{progressLabel}</span>
                </div>
              )}
            </section>

            <section className="panel">
              <header className="panel__header">
                <h2>文字起こし結果</h2>
                <div className="panel__tools">
                  <button type="button" className="button button--ghost button--small" onClick={handleCopyTranscript}>
                    コピー
                  </button>
                </div>
              </header>
              <div className="transcript">
                {transcript ? (
                  <pre className="transcript__body">{transcript}</pre>
                ) : (
                  <div className="transcript__placeholder">
                    {status === 'running' ? '解析中です…' : '解析が完了すると、ここに結果が表示されます。'}
                  </div>
                )}
              </div>
            </section>

            <section className="panel">
              <header className="panel__header">
                <h2>ログ</h2>
                <div className="panel__tools">
                  <button type="button" className="button button--ghost button--small" onClick={handleCopyLogs}>
                    コピー
                  </button>
                </div>
              </header>
              <div className="log" ref={logContainerRef}>
                {logs.length === 0 ? (
                  <div className="log__placeholder">処理の進行状況がここに表示されます。</div>
                ) : (
                  logs.map((entry) => (
                    <div key={entry.id} className={`log__line log__line--${entry.level}`}>
                      <span className="log__time">[{entry.timestamp}]</span>
                      <span className="log__message">{entry.message}</span>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
};

export default App;
