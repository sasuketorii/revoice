import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TranscriptionPayload } from './types';

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
  inputPath: string;
};

const HISTORY_LIMIT = 10;
const PROGRESS_REGEX = /^\[PROGRESS\]\s+(\d+(?:\.\d+)?)$/;

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

  const logContainerRef = useRef<HTMLDivElement | null>(null);
  const logCounter = useRef(0);
  const historyCounter = useRef(0);
  const lastJobRef = useRef<{ inputPath: string; fileName: string; startedAt: string } | null>(null);

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

  const pushHistory = useCallback((entry: HistoryEntry) => {
    setHistory((prev) => [entry, ...prev].slice(0, HISTORY_LIMIT));
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

  const handleDone = useCallback(
    async (result: DoneEvent) => {
      setPid(null);
      if (result.ok) {
        setStatus('success');
        setErrorMessage(null);
        setProgress(100);

        if (result.outputPath) {
          setOutputPath(result.outputPath);
        } else {
          setOutputPath(null);
        }

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
        const label = job?.fileName ?? (result.outputPath ? fileNameFromPath(result.outputPath) : '文字起こし結果');
        const entry: HistoryEntry = {
          id: ++historyCounter.current,
          label,
          finishedAt: new Date().toISOString(),
          outputPath: result.outputPath ?? null,
          transcript: text,
          inputPath: job?.inputPath ?? '',
        };
        pushHistory(entry);
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
      }
    },
    [appendLog, pushHistory]
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

  const handleCopyHistoryTranscript = (entry: HistoryEntry) => {
    copyText(entry.transcript, '履歴の文字起こしをコピーしました。', 'この履歴にはコピーできる文字起こしがありません');
  };

  const handleCopyPath = (path: string) => {
    copyText(path, 'ファイルパスをクリップボードにコピーしました。');
  };

  const handleClearHistory = () => {
    setHistory([]);
    appendLog('履歴をクリアしました。', 'info');
  };

  const handleLoadHistory = useCallback(
    async (entry: HistoryEntry) => {
      let text = entry.transcript;
      if (!text && entry.outputPath && window.revoice.readTextFile) {
        try {
          text = (await window.revoice.readTextFile(entry.outputPath)).trim();
          setHistory((prev) =>
            prev.map((item) => (item.id === entry.id ? { ...item, transcript: text } : item))
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
    <div className="app">
      <header className="hero">
        <div className="hero__copy">
          <h1>Revoice Transcriber</h1>
          <p>ファイルを選んでワンクリックで文字起こし</p>
        </div>
        <div className={`status-badge status-badge--${status}`}>
          <span className="status-badge__label">ステータス</span>
          <span className="status-badge__value">{statusLabel}</span>
        </div>
      </header>

      <section className="card">
        <div className="card__header">
          <h2>入力ファイル</h2>
        </div>
        <p className="card__description">音声または動画ファイルを 1 つ選択してください。</p>
        <div className="picker">
          <div className={`picker__path ${inputPath ? '' : 'picker__path--empty'}`}>
            {inputPath || 'ファイルがまだ選択されていません'}
          </div>
          <button type="button" className="button button--primary" onClick={handleBrowse} disabled={disabled}>
            ファイルを選ぶ
          </button>
        </div>
        <div className="hint">対応形式: wav, mp3, m4a, mp4, mov など</div>
      </section>

      <section className="card">
        <div className="card__header">
          <h2>文字起こしを実行</h2>
        </div>
        <div className="actions">
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
        <div className="status-panel">
          {pid && <span>実行中の PID: {pid}</span>}
          {outputPath && <span>出力ファイル: {outputPath}</span>}
          {errorMessage && <span className="status-panel__error">{errorMessage}</span>}
          {progress !== null && (
            <div className="progress">
              <div className="progress__track">
                <div className="progress__bar" style={{ width: `${Math.min(progress, 100)}%` }} />
              </div>
              <span className="progress__label">{progressLabel}</span>
            </div>
          )}
        </div>
      </section>

      <section className="card">
        <div className="card__header">
          <h2>文字起こし結果</h2>
          <div className="card__tools">
            <button type="button" className="button button--ghost button--small" onClick={handleCopyTranscript}>
              コピー
            </button>
          </div>
        </div>
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

      <section className="card">
        <div className="card__header">
          <h2>ログ</h2>
          <div className="card__tools">
            <button type="button" className="button button--ghost button--small" onClick={handleCopyLogs}>
              コピー
            </button>
          </div>
        </div>
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

      <section className="card">
        <div className="card__header">
          <h2>履歴</h2>
          <div className="card__tools">
            {history.length > 0 && (
              <button type="button" className="button button--ghost button--small" onClick={handleClearHistory}>
                クリア
              </button>
            )}
          </div>
        </div>
        {history.length === 0 ? (
          <div className="history__placeholder">まだ履歴はありません。</div>
        ) : (
          <ul className="history">
            {history.map((entry) => (
              <li key={entry.id} className="history__item">
                <div className="history__meta">
                  <span className="history__label">{entry.label}</span>
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
                    onClick={() => handleCopyHistoryTranscript(entry)}
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
        )}
      </section>
    </div>
  );
};

export default App;
