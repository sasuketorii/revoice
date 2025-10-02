import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import type { HistoryRecord, TranscriptionPayload, RetentionPolicy } from './types';

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
const OUTPUT_STYLE_LABELS: Record<'timestamps' | 'plain', string> = {
  timestamps: 'タイムスタンプあり',
  plain: 'タイムスタンプなし',
};

const BASE_PAYLOAD: Omit<TranscriptionPayload, 'inputPath'> = {
  outputDir: 'archive',
  model: 'large-v3',
  language: 'ja',
  beamSize: 5,
  computeType: 'int8',
  formats: 'txt',
  outputStyle: 'plain',
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
  transcript: record.transcriptFull?.trim() ?? '',
  transcriptPreview: record.transcriptPreview ? createPreview(record.transcriptPreview) : '',
  inputPath: record.inputPath ?? '',
  model: record.model ?? null,
  language: record.language ?? null,
  status: record.status ?? null,
  duration: record.duration ?? null,
});

type ScheduleOption = '12h' | '24h' | 'startup' | 'custom';

type RetentionFormState = {
  mode: 'recommended' | 'custom';
  maxDays: string;
  maxEntries: string;
  scheduleOption: ScheduleOption;
  scheduleHours: string;
};

type ActivePage =
  | 'vtt-transcribe'
  | 'vtt-history'
  | 'vtt-logs'
  | 'mtv-convert'
  | 'mtv-logs'
  | 'settings-vtt'
  | 'settings-mtv';

const IconEye = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M1.5 12s3.5-6.5 10.5-6.5S22.5 12 22.5 12s-3.5 6.5-10.5 6.5S1.5 12 1.5 12Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const IconCopy = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

const IconTrash = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
    <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
  </svg>
);

const RECOMMENDED_POLICY: RetentionPolicy = {
  mode: 'recommended',
  maxDays: 90,
  maxEntries: 200,
  schedule: {
    type: 'interval',
    preset: '12h',
    intervalHours: 12,
  },
};

const MAX_CUSTOM_DAYS = 365;
const MAX_CUSTOM_ENTRIES = 10000;
const MIN_INTERVAL_HOURS = 1;
const MAX_INTERVAL_HOURS = 72;

const toFormState = (policy: RetentionPolicy): RetentionFormState => {
  const schedule = policy.schedule ?? RECOMMENDED_POLICY.schedule;
  const scheduleOption: ScheduleOption = (() => {
    if (schedule.type === 'startup') return 'startup';
    if (schedule.preset === '12h' || schedule.preset === '24h') {
      return schedule.preset;
    }
    if (schedule.intervalHours && Number.isFinite(schedule.intervalHours) && schedule.intervalHours >= MIN_INTERVAL_HOURS) {
      return 'custom';
    }
    return '12h';
  })();

  return {
    mode: policy.mode === 'custom' ? 'custom' : 'recommended',
    maxDays: policy.maxDays === null || policy.maxDays === undefined ? '' : String(policy.maxDays),
    maxEntries: policy.maxEntries === null || policy.maxEntries === undefined ? '' : String(policy.maxEntries),
    scheduleOption,
    scheduleHours:
      scheduleOption === 'custom' && schedule.intervalHours
        ? String(schedule.intervalHours)
        : String(schedule.intervalHours ?? RECOMMENDED_POLICY.schedule.intervalHours),
  };
};

const normalizeNullableInt = (value: string) => {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === '0') return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return Math.floor(parsed);
};

const buildScheduleFromForm = (form: RetentionFormState) => {
  switch (form.scheduleOption) {
    case 'startup':
      return { type: 'startup', preset: 'startup', intervalHours: null } as RetentionPolicy['schedule'];
    case '12h':
      return { type: 'interval', preset: '12h', intervalHours: 12 } as RetentionPolicy['schedule'];
    case '24h':
      return { type: 'interval', preset: '24h', intervalHours: 24 } as RetentionPolicy['schedule'];
    case 'custom':
    default: {
      const hours = normalizeNullableInt(form.scheduleHours) ?? RECOMMENDED_POLICY.schedule.intervalHours;
      return {
        type: 'interval',
        preset: null,
        intervalHours: Math.min(Math.max(hours, MIN_INTERVAL_HOURS), MAX_INTERVAL_HOURS),
      } as RetentionPolicy['schedule'];
    }
  }
};

const formStateToPolicy = (form: RetentionFormState): RetentionPolicy => {
  const schedule = buildScheduleFromForm(form);
  if (form.mode === 'recommended') {
    return {
      ...RECOMMENDED_POLICY,
      schedule,
    };
  }
  return {
    mode: 'custom',
    maxDays: normalizeNullableInt(form.maxDays),
    maxEntries: normalizeNullableInt(form.maxEntries),
    schedule,
  };
};

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
  const [activePage, setActivePage] = useState<ActivePage>('vtt-transcribe');
  const [selectedHistoryId, setSelectedHistoryId] = useState<number | null>(null);
  const [outputStyle, setOutputStyle] = useState<'timestamps' | 'plain'>('plain');
  const [outputStyleLoading, setOutputStyleLoading] = useState(true);
  const [retentionPolicy, setRetentionPolicy] = useState<RetentionPolicy | null>(null);
  const [policyForm, setPolicyForm] = useState<RetentionFormState>(() => toFormState(RECOMMENDED_POLICY));
  const [policyLoading, setPolicyLoading] = useState(true);
  const [policySaving, setPolicySaving] = useState(false);
  const [policyErrors, setPolicyErrors] = useState<string[]>([]);
  const [policyDirty, setPolicyDirty] = useState(false);
  const [policySuccess, setPolicySuccess] = useState<string | null>(null);

  const logContainerRef = useRef<HTMLDivElement | null>(null);
  const logCounter = useRef(0);
  const lastJobRef = useRef<{ inputPath: string; fileName: string; startedAt: string } | null>(null);
  const pendingHistoryIdRef = useRef<number | null>(null);
  const fallbackHistoryIdRef = useRef(0);

  const statusLabel = useMemo(() => STATUS_LABEL[status], [status]);
  const disabled = status === 'running';
  const policySaveDisabled = useMemo(() => policyLoading || policySaving || !policyDirty, [policyLoading, policySaving, policyDirty]);

  const scheduleOptionLabels: Record<ScheduleOption, string> = useMemo(
    () => ({
      '12h': '12時間ごと',
      '24h': '24時間ごと',
      startup: '起動時のみ',
      custom: 'カスタム',
    }),
    []
  );

  const selectedHistory = useMemo(() => {
    if (selectedHistoryId === null) return null;
    return history.find((entry) => entry.id === selectedHistoryId) ?? null;
  }, [history, selectedHistoryId]);

  const appendLog = useCallback((message: string, level: LogEntry['level'] = 'info') => {
    const id = ++logCounter.current;
    const timestamp = new Date().toLocaleTimeString('ja-JP', { hour12: false });
    setLogs((prev) => {
      const next = [...prev, { id, timestamp, message, level }];
      return next.length > 300 ? next.slice(next.length - 300) : next;
    });
  }, []);

  const markPolicyDirty = useCallback(() => {
    setPolicyDirty(true);
    setPolicyErrors([]);
    setPolicySuccess(null);
  }, []);

  const handlePolicyModeChange = useCallback(
    (mode: 'recommended' | 'custom') => {
      setPolicyForm((prev) => {
        if (prev.mode === mode) return prev;
        const next: RetentionFormState = {
          ...prev,
          mode,
          maxDays: mode === 'recommended' ? String(RECOMMENDED_POLICY.maxDays ?? '') : prev.maxDays,
          maxEntries: mode === 'recommended' ? String(RECOMMENDED_POLICY.maxEntries ?? '') : prev.maxEntries,
        };
        markPolicyDirty();
        return next;
      });
    },
    [markPolicyDirty]
  );

  const handlePolicyMaxDaysChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value;
      setPolicyForm((prev) => {
        if (prev.maxDays === value) return prev;
        markPolicyDirty();
        return { ...prev, maxDays: value };
      });
    },
    [markPolicyDirty]
  );

  const handlePolicyMaxEntriesChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value;
      setPolicyForm((prev) => {
        if (prev.maxEntries === value) return prev;
        markPolicyDirty();
        return { ...prev, maxEntries: value };
      });
    },
    [markPolicyDirty]
  );

  const handlePolicyScheduleOptionChange = useCallback(
    (option: ScheduleOption) => {
      setPolicyForm((prev) => {
        if (prev.scheduleOption === option) return prev;
        const next: RetentionFormState = {
          ...prev,
          scheduleOption: option,
          scheduleHours: option === 'custom' && (!prev.scheduleHours || prev.scheduleHours.trim() === '') ? '12' : prev.scheduleHours,
        };
        markPolicyDirty();
        return next;
      });
    },
    [markPolicyDirty]
  );

  const handlePolicyScheduleHoursChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value;
      setPolicyForm((prev) => {
        if (prev.scheduleHours === value) return prev;
        markPolicyDirty();
        return { ...prev, scheduleHours: value };
      });
    },
    [markPolicyDirty]
  );

  const validatePolicyForm = useCallback(
    (form: RetentionFormState) => {
      const errors: string[] = [];
      if (form.mode === 'custom') {
        const daysValue = form.maxDays.trim();
        if (daysValue !== '') {
          const days = Number(daysValue);
          if (!Number.isInteger(days) || days < 0) {
            errors.push('保持日数は0以上の整数で入力してください。');
          } else if (days > MAX_CUSTOM_DAYS) {
            errors.push(`保持日数は最大 ${MAX_CUSTOM_DAYS} 日まで指定できます。`);
          }
        }
        const entriesValue = form.maxEntries.trim();
        if (entriesValue !== '') {
          const count = Number(entriesValue);
          if (!Number.isInteger(count) || count < 0) {
            errors.push('保持件数は0以上の整数で入力してください。');
          } else if (count > MAX_CUSTOM_ENTRIES) {
            errors.push(`保持件数は最大 ${MAX_CUSTOM_ENTRIES} 件まで指定できます。`);
          }
        }
      }

      if (form.scheduleOption === 'custom') {
        const raw = form.scheduleHours.trim();
        const hours = Number(raw);
        if (!Number.isInteger(hours) || hours < MIN_INTERVAL_HOURS || hours > MAX_INTERVAL_HOURS) {
          errors.push(`自動整理の間隔は ${MIN_INTERVAL_HOURS}〜${MAX_INTERVAL_HOURS} 時間で入力してください。`);
        }
      }

      return errors;
    },
    []
  );

  const handlePolicySave = useCallback(async () => {
    if (!window.revoice?.setRetentionPolicy) {
      setPolicyErrors(['このビルドでは履歴ポリシーの保存に対応していません。']);
      return;
    }
    setPolicyErrors([]);
    setPolicySuccess(null);

    const errors = validatePolicyForm(policyForm);
    if (errors.length > 0) {
      setPolicyErrors(errors);
      return;
    }

    const payload = formStateToPolicy(policyForm);
    setPolicySaving(true);
    try {
      const response = await window.revoice.setRetentionPolicy(payload);
      if (response?.ok && response.policy) {
        setRetentionPolicy(response.policy);
        setPolicyForm(toFormState(response.policy));
      } else {
        if (response?.error) {
          setPolicyErrors([response.error]);
          appendLog(`[WARN] 履歴ポリシーの保存に失敗しました: ${response.error}`, 'error');
          return;
        }
        setRetentionPolicy(payload);
        setPolicyForm(toFormState(payload));
      }
      setPolicyDirty(false);
      setPolicySuccess('保存しました');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setPolicyErrors([`履歴ポリシーの保存に失敗しました: ${message}`]);
      appendLog(`[WARN] 履歴ポリシーの保存中にエラーが発生しました: ${message}`, 'error');
    } finally {
      setPolicySaving(false);
    }
  }, [appendLog, policyForm, validatePolicyForm]);

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

  const loadHistoryContent = useCallback(
    async (entry: HistoryEntry) => {
      if (window.revoice?.getHistoryDetail) {
        try {
          const response = await window.revoice.getHistoryDetail(entry.id);
          if (response?.ok && response.item) {
            const transcript = response.item.transcriptFull?.trim() ?? '';
            setHistory((prev) =>
              prev.map((item) =>
                item.id === entry.id
                  ? {
                      ...item,
                      transcript,
                      transcriptPreview: transcript ? createPreview(transcript) : item.transcriptPreview,
                    }
                  : item
              )
            );
            if (transcript) return transcript;
          }
        } catch (err) {
          appendLog(`[WARN] 履歴の取得に失敗しました: ${err}`, 'error');
        }
      }

      if (entry.transcript && entry.transcript.trim()) {
        return entry.transcript;
      }
      return '';
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
    let cancelled = false;

    const loadTranscriptionDefaults = async () => {
      if (!window.revoice?.getTranscriptionDefaults) {
        if (!cancelled) {
          setOutputStyle('plain');
          setOutputStyleLoading(false);
        }
        return;
      }
      setOutputStyleLoading(true);
      try {
        const response = await window.revoice.getTranscriptionDefaults();
        if (cancelled) return;
        if (response?.ok && response.outputStyle) {
          setOutputStyle(response.outputStyle);
        } else if (response?.error) {
          appendLog(`[WARN] 出力スタイルの取得に失敗しました: ${response.error}`, 'error');
          setOutputStyle('plain');
        }
      } catch (err) {
        if (!cancelled) {
          appendLog(`[WARN] 出力スタイルの取得中にエラーが発生しました: ${err}`, 'error');
          setOutputStyle('plain');
        }
      } finally {
        if (!cancelled) {
          setOutputStyleLoading(false);
        }
      }
    };

    void loadTranscriptionDefaults();

    return () => {
      cancelled = true;
    };
  }, [appendLog]);

  useEffect(() => {
    if (activePage === 'vtt-history' && history.length > 0) {
      if (selectedHistoryId === null || !history.some((item) => item.id === selectedHistoryId)) {
        setSelectedHistoryId(history[0].id);
        void loadHistoryContent(history[0]);
      }
    }
  }, [activePage, history, selectedHistoryId, loadHistoryContent]);

  useEffect(() => {
    if (history.length === 0) {
      setSelectedHistoryId(null);
    }
  }, [history]);

  useEffect(() => {
    let cancelled = false;

    const loadPolicy = async () => {
      if (!window.revoice?.getRetentionPolicy) {
        if (cancelled) return;
        setRetentionPolicy(RECOMMENDED_POLICY);
        setPolicyForm(toFormState(RECOMMENDED_POLICY));
        setPolicyDirty(false);
        setPolicyLoading(false);
        return;
      }
      setPolicyLoading(true);
      try {
        const response = await window.revoice.getRetentionPolicy();
        if (cancelled) return;
        if (response?.ok && response.policy) {
          setRetentionPolicy(response.policy);
          setPolicyForm(toFormState(response.policy));
          setPolicyDirty(false);
          setPolicyErrors([]);
        } else {
          if (response?.error) {
            appendLog(`[WARN] 履歴ポリシーの取得に失敗しました: ${response.error}`, 'error');
          }
          setRetentionPolicy(RECOMMENDED_POLICY);
          setPolicyForm(toFormState(RECOMMENDED_POLICY));
          setPolicyDirty(false);
        }
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          appendLog(`[WARN] 履歴ポリシーの取得中にエラーが発生しました: ${message}`, 'error');
          setRetentionPolicy(RECOMMENDED_POLICY);
          setPolicyForm(toFormState(RECOMMENDED_POLICY));
          setPolicyDirty(false);
        }
      } finally {
        if (!cancelled) {
          setPolicyLoading(false);
        }
      }
    };

    void loadPolicy();

    return () => {
      cancelled = true;
    };
  }, [appendLog]);

  useEffect(() => {
    if (!policySuccess) return;
    const timer = window.setTimeout(() => setPolicySuccess(null), 4000);
    return () => window.clearTimeout(timer);
  }, [policySuccess]);

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
    const disposePruned = window.revoice.onHistoryPruned?.((payload) => {
      const total = typeof payload?.total === 'number' ? payload.total : historyTotal;
      setHistoryTotal(total);
      setHistoryCursor((prev) => Math.min(prev, total));
      setHistoryHasMore(false);
      void fetchHistory(0, false);
      if (payload?.policy) {
        setRetentionPolicy(payload.policy);
        if (!policyDirty) {
          setPolicyForm(toFormState(payload.policy));
          setPolicyDirty(false);
          setPolicyErrors([]);
          setPolicySuccess(null);
        }
      }
    });
    return () => {
      disposeAdded?.();
      disposeCleared?.();
      disposeDeleted?.();
      disposePruned?.();
    };
  }, [fetchHistory, historyTotal, policyDirty]);

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
    appendLog(`出力スタイル: ${OUTPUT_STYLE_LABELS[outputStyle] ?? outputStyle}`, 'info');

    const payload: TranscriptionPayload = {
      ...BASE_PAYLOAD,
      inputPath,
      outputStyle,
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

  const handleOutputStyleChange = useCallback(
    async (style: 'timestamps' | 'plain') => {
      setOutputStyle(style);
      if (!window.revoice?.setTranscriptionDefaults) return;
      try {
        const response = await window.revoice.setTranscriptionDefaults({ outputStyle: style });
        if (!response?.ok && response?.error) {
          appendLog(`[WARN] 出力スタイルの保存に失敗しました: ${response.error}`, 'error');
        }
      } catch (err) {
        appendLog(`[WARN] 出力スタイルの保存中にエラーが発生しました: ${err}`, 'error');
      }
    },
    [appendLog]
  );

  const handleCopyHistoryTranscript = async (entry: HistoryEntry) => {
    const content = await loadHistoryContent(entry);
    await copyText(content, '履歴の文字起こしをコピーしました。', 'この履歴にはコピーできる文字起こしがありません');
  };

  const handleLoadMoreHistory = useCallback(() => {
    if (historyLoading) return;
    void fetchHistory(historyCursor, true);
  }, [fetchHistory, historyCursor, historyLoading]);

  const handleDeleteHistory = useCallback(
    async (entry: HistoryEntry) => {
      if (!window.revoice.deleteHistory) {
        appendLog('このビルドでは履歴の削除に対応していません。', 'error');
        return;
      }
      try {
        const response = await window.revoice.deleteHistory([entry.id]);
        if (response?.ok) {
          setHistory((prev) => {
            const next = prev.filter((item) => item.id !== entry.id);
            if (entry.id === selectedHistoryId) {
              setSelectedHistoryId(next.length > 0 ? next[0].id : null);
            }
            return next;
          });
          setHistoryTotal((prev) => Math.max(prev - 1, 0));
          setHistoryCursor((prev) => Math.max(prev - 1, 0));
          appendLog(`履歴 #${entry.id} を削除しました。`, 'info');
        } else {
          appendLog(`[WARN] 履歴の削除に失敗しました: ${response?.error ?? '不明なエラー'}`, 'error');
        }
      } catch (err) {
        appendLog(`[WARN] 履歴の削除でエラーが発生しました: ${err}`, 'error');
      }
    },
    [appendLog, selectedHistoryId]
  );

  const handleSelectHistory = useCallback(
    async (entry: HistoryEntry) => {
      setSelectedHistoryId(entry.id);
      await loadHistoryContent(entry);
    },
    [loadHistoryContent]
  );

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

  const progressLabel = useMemo(() => {
    if (progress === null) return null;
    return `${progress.toFixed(1)}%`;
  }, [progress]);

  const retentionSettingsPanel = (
    <section className="panel panel--settings">
      <header className="panel__header">
        <h2>履歴保持ポリシー</h2>
        <div className="panel__tools">
          {policyLoading && <span className="policy__loader">読み込み中…</span>}
          {retentionPolicy && !policyLoading && (
            <span className="policy__badge">
              {retentionPolicy.mode === 'recommended' ? '推奨プリセット' : 'カスタム設定'}
            </span>
          )}
        </div>
      </header>
      <div className="policy">
        <div className="policy__mode">
          <button
            type="button"
            className={`button button--ghost policy__toggle ${policyForm.mode === 'recommended' ? 'policy__toggle--active' : ''}`}
            onClick={() => handlePolicyModeChange('recommended')}
            disabled={policyLoading || policySaving}
          >
            推奨
          </button>
          <button
            type="button"
            className={`button button--ghost policy__toggle ${policyForm.mode === 'custom' ? 'policy__toggle--active' : ''}`}
            onClick={() => handlePolicyModeChange('custom')}
            disabled={policyLoading || policySaving}
          >
            カスタム
          </button>
        </div>

        <div className="policy__grid">
          <div className="policy__field">
            <label className="policy__label" htmlFor="policy-days">
              保持日数
            </label>
            <input
              id="policy-days"
              type="number"
              min={0}
              max={MAX_CUSTOM_DAYS}
              className="policy__input"
              value={policyForm.maxDays}
              onChange={handlePolicyMaxDaysChange}
              placeholder="0（無制限）"
              disabled={policyLoading || policySaving || policyForm.mode !== 'custom'}
            />
            <span className="policy__hint">0 または空欄で無制限（最大 {MAX_CUSTOM_DAYS} 日）</span>
          </div>
          <div className="policy__field">
            <label className="policy__label" htmlFor="policy-count">
              保持件数
            </label>
            <input
              id="policy-count"
              type="number"
              min={0}
              max={MAX_CUSTOM_ENTRIES}
              className="policy__input"
              value={policyForm.maxEntries}
              onChange={handlePolicyMaxEntriesChange}
              placeholder="0（無制限）"
              disabled={policyLoading || policySaving || policyForm.mode !== 'custom'}
            />
            <span className="policy__hint">0 または空欄で無制限（最大 {MAX_CUSTOM_ENTRIES} 件）</span>
          </div>
        </div>

        <div className="policy__schedule">
          <span className="policy__label policy__label--inline">自動整理のタイミング</span>
          <div className="policy__schedule-options">
            {(['12h', '24h', 'startup', 'custom'] as const).map((option) => (
              <button
                key={option}
                type="button"
                className={`button button--ghost policy__toggle ${policyForm.scheduleOption === option ? 'policy__toggle--active' : ''}`}
                onClick={() => handlePolicyScheduleOptionChange(option)}
                disabled={policyLoading || policySaving}
              >
                {scheduleOptionLabels[option]}
              </button>
            ))}
          </div>
          {policyForm.scheduleOption === 'custom' && (
            <div className="policy__custom-interval">
              <input
                type="number"
                min={MIN_INTERVAL_HOURS}
                max={MAX_INTERVAL_HOURS}
                className="policy__input policy__input--small"
                value={policyForm.scheduleHours}
                onChange={handlePolicyScheduleHoursChange}
                disabled={policyLoading || policySaving}
              />
              <span className="policy__unit">時間</span>
              <span className="policy__hint">{MIN_INTERVAL_HOURS}〜{MAX_INTERVAL_HOURS} 時間</span>
            </div>
          )}
        </div>

        {policyForm.mode === 'recommended' && (
          <div className="policy__summary">
            推奨プリセット: {RECOMMENDED_POLICY.maxDays}日または {RECOMMENDED_POLICY.maxEntries}件を超えた履歴を自動削除します。
          </div>
        )}

        {policyErrors.length > 0 && (
          <ul className="policy__errors">
            {policyErrors.map((error, index) => (
              <li key={index}>{error}</li>
            ))}
          </ul>
        )}

        <div className="policy__footer">
          {policySuccess ? (
            <span className="policy__success">{policySuccess}</span>
          ) : (
            <span className="policy__hint policy__footer-hint">保存すると次回の自動整理から適用されます。</span>
          )}
          <button type="button" className="button button--primary" onClick={handlePolicySave} disabled={policySaveDisabled}>
            {policySaving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </section>
  );

  const renderTranscribe = (
    <div className="transcribe-view">
      <div className="transcribe-tabs">
        <button type="button" className="transcribe-tabs__button transcribe-tabs__button--active">
          タブ 1
        </button>
        <button type="button" className="transcribe-tabs__button transcribe-tabs__button--add">
          ＋
        </button>
      </div>

      <div className="output-style">
        <span className="output-style__label">出力スタイル</span>
        <div className="output-style__controls">
          {(['timestamps', 'plain'] as const).map((style) => (
            <button
              key={style}
              type="button"
              className={`output-style__button ${outputStyle === style ? 'output-style__button--active' : ''}`}
              onClick={() => handleOutputStyleChange(style)}
              disabled={outputStyleLoading}
            >
              {OUTPUT_STYLE_LABELS[style]}
            </button>
          ))}
          {outputStyleLoading && <span className="output-style__hint">読み込み中…</span>}
        </div>
      </div>

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
          <button type="button" className="button button--primary" onClick={handleStart} disabled={disabled || !inputPath}>
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

      <section className="panel panel--transcript">
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
    </div>
  );

  const renderHistory = (
    <div className="history-page">
      <header className="page-header">
        <h1>履歴</h1>
        <div className="page-header__tools">
          <span className="page-header__count">{historyTotal}件</span>
          {history.length > 0 && (
            <button type="button" className="button button--ghost button--small" onClick={handleClearHistory}>
              クリア
            </button>
          )}
        </div>
      </header>
      {history.length === 0 ? (
        <div className="history-page__empty">まだ履歴はありません。</div>
      ) : (
        <div className="history-page__body">
          <div className="history-list">
            <ul className="history-list__items">
              {history.map((entry) => {
                const active = entry.id === selectedHistoryId;
                return (
                  <li key={entry.id}>
                    <button
                      type="button"
                      className={`history-list__item ${active ? 'history-list__item--active' : ''}`}
                      onClick={() => {
                        void handleSelectHistory(entry);
                      }}
                    >
                      <span className="history-list__title">{entry.label}</span>
                      {entry.status && (
                        <span className={`history-list__status history-list__status--${entry.status}`}>
                          {entry.status === 'completed'
                            ? '完了'
                            : entry.status === 'failed'
                            ? '失敗'
                            : entry.status}
                        </span>
                      )}
                      <span className="history-list__time">{formatHistoryTime(entry.finishedAt)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {historyHasMore && (
              <button
                type="button"
                className="history-list__more button button--outline"
                onClick={handleLoadMoreHistory}
                disabled={historyLoading}
              >
                {historyLoading ? '読み込み中…' : 'さらに読み込む'}
              </button>
            )}
          </div>
          <div className="history-detail">
            {selectedHistory ? (
              <>
                <div className="history-detail__header">
                  <div className="history-detail__header-main">
                    <h2>{selectedHistory.label}</h2>
                    <div className="history-detail__meta">
                      {selectedHistory.status && (
                        <span className={`history-detail__status history-detail__status--${selectedHistory.status}`}>
                          {selectedHistory.status === 'completed'
                            ? '完了'
                            : selectedHistory.status === 'failed'
                            ? '失敗'
                            : selectedHistory.status}
                        </span>
                      )}
                      <span className="history-detail__time">{formatHistoryTime(selectedHistory.finishedAt)}</span>
                    </div>
                  </div>
                  <div className="history-detail__actions">
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => {
                        void handleSelectHistory(selectedHistory);
                      }}
                    >
                      <IconEye />
                      <span className="sr-only">内容を読み込む</span>
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => {
                        void handleCopyHistoryTranscript(selectedHistory);
                      }}
                    >
                      <IconCopy />
                      <span className="sr-only">文字起こしをコピー</span>
                    </button>
                    <button
                      type="button"
                      className="icon-button icon-button--danger"
                      onClick={() => {
                        void handleDeleteHistory(selectedHistory);
                      }}
                    >
                      <IconTrash />
                      <span className="sr-only">削除</span>
                    </button>
                  </div>
                </div>
                <div className="history-detail__content">
                  {selectedHistory.transcript ? (
                    <pre className="history-detail__text">{selectedHistory.transcript}</pre>
                  ) : (
                    <div className="history-detail__placeholder">左のリストから履歴を選択すると内容が表示されます。</div>
                  )}
                </div>
              </>
            ) : (
              <div className="history-detail__placeholder">表示する履歴を左のリストから選択してください。</div>
            )}
          </div>
        </div>
      )}
    </div>
  );

  const renderLogs = (
    <div className="logs-page">
      <section className="panel panel--logs">
        <header className="panel__header">
          <h2>ログ</h2>
          <div className="panel__tools">
            <button type="button" className="button button--ghost button--small" onClick={handleCopyLogs}>
              コピー
            </button>
          </div>
        </header>
        <div className="log log--full" ref={logContainerRef}>
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
  );

  const renderPlaceholder = (title: string, description: string) => (
    <div className="placeholder-view">
      <section className="panel panel--placeholder">
        <header className="panel__header">
          <h2>{title}</h2>
        </header>
        <p className="placeholder-view__description">{description}</p>
        <p className="placeholder-view__note">準備中の機能です。</p>
      </section>
    </div>
  );

  let mainContent: JSX.Element;
  switch (activePage) {
    case 'vtt-transcribe':
      mainContent = renderTranscribe;
      break;
    case 'vtt-history':
      mainContent = renderHistory;
      break;
    case 'vtt-logs':
      mainContent = renderLogs;
      break;
    case 'settings-vtt':
      mainContent = <div className="settings-view">{retentionSettingsPanel}</div>;
      break;
    case 'mtv-convert':
      mainContent = renderPlaceholder('Movie to Voice - 変換', '映像から音声への変換ワークフローをここに追加予定です。');
      break;
    case 'mtv-logs':
      mainContent = renderPlaceholder('Movie to Voice - ログ', '変換処理のログは今後ここに表示されます。');
      break;
    case 'settings-mtv':
      mainContent = renderPlaceholder('Movie to Voice の設定', '現在準備中です。');
      break;
    default:
      mainContent = renderPlaceholder('準備中', '今後のアップデートをお待ちください。');
  }

  const navGroups: {
    title: string;
    items: { key: ActivePage; label: string }[];
  }[] = [
    {
      title: 'Voice to Text',
      items: [
        { key: 'vtt-transcribe', label: '文字起こし' },
        { key: 'vtt-history', label: '履歴' },
        { key: 'vtt-logs', label: 'ログ' },
      ],
    },
    {
      title: 'Movie to Voice',
      items: [
        { key: 'mtv-convert', label: '変換' },
        { key: 'mtv-logs', label: 'ログ' },
      ],
    },
    {
      title: 'Setting',
      items: [
        { key: 'settings-vtt', label: 'Voice to textの設定' },
        { key: 'settings-mtv', label: 'Movie to Voiceの設定' },
      ],
    },
  ];

  return (
    <div className="app-shell">
      <aside className="app-shell__sidebar">
        <div className="sidebar__brand">Revoice</div>
        <nav className="sidebar__groups">
          {navGroups.map((group) => (
            <div key={group.title} className="sidebar__group">
              <h3 className="sidebar__group-title">{group.title}</h3>
              <ul className="sidebar__group-list">
                {group.items.map((item) => {
                  const active = activePage === item.key;
                  return (
                    <li key={item.key}>
                      <button
                        type="button"
                        className={`sidebar__nav-button ${active ? 'sidebar__nav-button--active' : ''}`}
                        onClick={() => setActivePage(item.key)}
                      >
                        <span className={`sidebar__nav-marker ${active ? 'sidebar__nav-marker--active' : ''}`} />
                        <span className="sidebar__nav-label">{item.label}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
        <div className="sidebar__foot">
          <span className="sidebar__status-label">現行ステータス</span>
          <span className={`sidebar__status-value sidebar__status-value--${status}`}>{statusLabel}</span>
        </div>
      </aside>

      <main className="app-shell__main">{mainContent}</main>
    </div>
  );
};

export default App;
