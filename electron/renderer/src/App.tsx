import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, SVGProps } from 'react';
import type {
  HistoryRecord,
  JobEventMessage,
  JobStatus,
  JobSummary,
  RetentionPolicy,
  TabSummary,
  TranscriptionJobPayload,
} from './types';

type LogEntry = {
  id: number;
  timestamp: string;
  message: string;
  level: 'info' | 'error';
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

type TabState = {
  id: string;
  title: string;
  inputPath: string;
  jobId: string | null;
  status: JobStatus | 'idle';
  queuePosition: number | null;
  progress: number | null;
  pid: number | null;
  outputPath: string | null;
  transcript: string;
  logs: LogEntry[];
  errorMessage: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

type ScheduleOption = '12h' | '24h' | 'startup' | 'custom';

type RetentionFormState = {
  mode: 'recommended' | 'custom';
  maxDays: string;
  maxEntries: string;
  scheduleOption: ScheduleOption;
  scheduleHours: string;
};

const HISTORY_PAGE_SIZE = 20;
const PREVIEW_MAX_LENGTH = 400;
const MAX_CUSTOM_DAYS = 365;
const MAX_CUSTOM_ENTRIES = 10000;
const MIN_INTERVAL_HOURS = 1;
const MAX_INTERVAL_HOURS = 72;
const MAX_VISIBLE_TABS = 4;
const OUTPUT_STYLE_LABELS: Record<'timestamps' | 'plain', string> = {
  timestamps: 'タイムスタンプあり',
  plain: 'タイムスタンプなし',
};

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

const TAB_STATUS_LABEL: Record<JobStatus | 'idle', string> = {
  idle: '待機中',
  queued: '待機中',
  running: '解析中…',
  completed: '完了',
  failed: '失敗',
  cancelled: 'キャンセル',
};

const STATUS_PILL_CLASS: Record<JobStatus | 'idle', string> = {
  idle: 'idle',
  queued: 'running',
  running: 'running',
  completed: 'success',
  failed: 'error',
  cancelled: 'error',
};

const revoiceLogo = new URL('./assets/revoice-logo.png', import.meta.url).href;

const IconRefresh = (props: SVGProps<SVGSVGElement>) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <polyline points="23 4 23 10 17 10" />
    <polyline points="1 20 1 14 7 14" />
    <path d="M3.51 9a9 9 0 0 1 14.13-3.36L23 10" />
    <path d="M20.49 15a9 9 0 0 1-14.13 3.36L1 14" />
  </svg>
);

const IconCopy = (props: SVGProps<SVGSVGElement>) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

const IconTrash = (props: SVGProps<SVGSVGElement>) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
    <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
  </svg>
);

const createPreview = (text: string) => {
  if (!text) return '';
  const trimmed = text.trim();
  return trimmed.length <= PREVIEW_MAX_LENGTH ? trimmed : `${trimmed.slice(0, PREVIEW_MAX_LENGTH)}…`;
};

const formatHistoryTime = (iso: string) => {
  try {
    return new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(iso));
  } catch (err) {
    return iso;
  }
};

const fileNameFromPath = (path: string) => path.split(/[\\/]/).pop() ?? path;

const historyRecordToEntry = (record: HistoryRecord): HistoryEntry => ({
  id: record.id,
  label: fileNameFromPath(record.outputPath ?? record.inputPath ?? ''),
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

const toFormState = (policy: RetentionPolicy): RetentionFormState => {
  const schedule = policy.schedule ?? RECOMMENDED_POLICY.schedule;
  const scheduleOption: ScheduleOption = (() => {
    if (schedule.type === 'startup') return 'startup';
    if (schedule.preset === '12h' || schedule.preset === '24h') return schedule.preset;
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

const buildTabState = (summary: TabSummary, job: JobSummary | null): TabState => {
  const status = job?.status ?? 'idle';
  return {
    id: summary.id,
    title: summary.title ?? 'タブ',
    inputPath: job?.inputPath ?? '',
    jobId: job?.id ?? summary.jobId ?? null,
    status,
    queuePosition: job?.queuePosition ?? null,
    progress: job?.progress ?? (status === 'completed' ? 100 : null),
    pid: job?.pid ?? null,
    outputPath: job?.outputPath ?? null,
    transcript: job?.transcript ?? '',
    logs: [],
    errorMessage: job?.error ?? null,
    createdAt: summary.createdAt ?? null,
    updatedAt: summary.updatedAt ?? null,
  };
};

const mergeJobIntoTab = (tab: TabState, job: JobSummary): TabState => {
  const status = job.status ?? tab.status;
  let transcript = tab.transcript;
  if (job.transcript && job.transcript.length > 0) {
    transcript = job.transcript;
  }
  const outputPath = job.outputPath ?? tab.outputPath;
  const progress = typeof job.progress === 'number' ? job.progress : tab.progress;
  const errorMessage = job.error ?? (status === 'failed' ? 'ジョブが失敗しました' : status === 'cancelled' ? 'ジョブがキャンセルされました' : null);
  return {
    ...tab,
    jobId: job.id,
    status,
    queuePosition: job.queuePosition ?? null,
    progress,
    pid: job.pid ?? null,
    outputPath,
    transcript,
    errorMessage,
  };
};

const App = () => {
  const [tabs, setTabs] = useState<TabState[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [tabsLoading, setTabsLoading] = useState(true);
  const [jobsLoading, setJobsLoading] = useState(true);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyCursor, setHistoryCursor] = useState(0);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [activePage, setActivePage] = useState<'vtt-transcribe' | 'vtt-history' | 'vtt-logs' | 'settings-vtt' | 'mtv-convert' | 'mtv-logs' | 'settings-mtv'>('vtt-transcribe');
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

  const logCounter = useRef(0);
  const jobMapRef = useRef<Map<string, JobSummary>>(new Map());
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const tabsRef = useRef<TabState[]>([]);
  const activeTabIdRef = useRef<string | null>(null);

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  const activeTab = useMemo(() => {
    if (!activeTabId) return null;
    return tabs.find((tab) => tab.id === activeTabId) ?? null;
  }, [tabs, activeTabId]);

  const statusLabel = useMemo(() => TAB_STATUS_LABEL[activeTab?.status ?? 'idle'], [activeTab]);
  const statusPillClass = useMemo(() => STATUS_PILL_CLASS[activeTab?.status ?? 'idle'], [activeTab]);
  const startDisabled = !activeTab || activeTab.status === 'running' || activeTab.status === 'queued';

  const scheduleOptionLabels: Record<ScheduleOption, string> = useMemo(
    () => ({
      '12h': '12時間ごと',
      '24h': '24時間ごと',
      startup: '起動時のみ',
      custom: 'カスタム',
    }),
    []
  );

  const policySaveDisabled = useMemo(() => policyLoading || policySaving || !policyDirty, [policyLoading, policySaving, policyDirty]);
  const selectedHistory = useMemo(() => {
    if (selectedHistoryId === null) return null;
    return history.find((entry) => entry.id === selectedHistoryId) ?? null;
  }, [history, selectedHistoryId]);

  const patchTab = useCallback((tabId: string, updater: (tab: TabState) => TabState) => {
    setTabs((prev) => prev.map((tab) => (tab.id === tabId ? updater(tab) : tab)));
  }, []);

  const appendTabLog = useCallback(
    (tabId: string, message: string, level: LogEntry['level'] = 'info') => {
      const id = ++logCounter.current;
      const timestamp = new Date().toLocaleTimeString('ja-JP', { hour12: false });
      patchTab(tabId, (tab) => {
        const nextLogs = [...tab.logs, { id, timestamp, message, level }];
        return {
          ...tab,
          logs: nextLogs.length > 300 ? nextLogs.slice(nextLogs.length - 300) : nextLogs,
        };
      });
    },
    [patchTab]
  );

  const appendAppLog = useCallback(
    (message: string, level: LogEntry['level'] = 'info', targetTabId?: string | null) => {
      const target = targetTabId ?? activeTabIdRef.current ?? tabsRef.current[0]?.id ?? null;
      if (target) {
        appendTabLog(target, message, level);
      }
    },
    [appendTabLog]
  );

  const ensureActiveTab = useCallback(
    (candidates: TabState[]) => {
      setActiveTabId((prev) => {
        if (prev && candidates.some((tab) => tab.id === prev)) {
          return prev;
        }
        return candidates[0]?.id ?? null;
      });
    },
    []
  );

  const getNextTabTitle = useCallback(() => {
    const numbers = tabsRef.current
      .map((tab) => {
        const match = /^タブ\s*(\d+)$/u.exec(tab.title ?? '');
        return match ? Number(match[1]) : null;
      })
      .filter((value): value is number => value !== null && Number.isFinite(value));
    const maxNumber = numbers.length > 0 ? Math.max(...numbers) : 0;
    return `タブ ${maxNumber + 1}`;
  }, []);

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
          appendAppLog(`[WARN] 履歴の読み込みに失敗しました: ${response.error ?? '不明なエラー'}`, 'error');
        }
      } catch (err) {
        appendAppLog(`[WARN] 履歴の読み込み中にエラーが発生しました: ${err}`, 'error');
      } finally {
        setHistoryLoading(false);
      }
    },
    [appendAppLog]
  );

  useEffect(() => {
    let cancelled = false;
    const bootstrap = async () => {
      try {
        setTabsLoading(true);
        setJobsLoading(true);
        const [tabResponse, jobResponse] = await Promise.all([
          window.revoice.listTabs?.() ?? { ok: true, tabs: [] },
          window.revoice.listJobs?.() ?? { ok: true, jobs: [] },
        ]);
        if (cancelled) return;

        const jobMap = new Map<string, JobSummary>();
        if (jobResponse.ok && jobResponse.jobs) {
          for (const job of jobResponse.jobs) {
            jobMap.set(job.id, job);
          }
        } else if (!jobResponse.ok && jobResponse.error) {
          appendAppLog(`[WARN] ジョブ一覧の取得に失敗しました: ${jobResponse.error}`, 'error');
        }
        jobMapRef.current = jobMap;

        let tabSummaries = tabResponse.ok && tabResponse.tabs ? tabResponse.tabs : [];
        if (tabSummaries.length === 0) {
          const created = await window.revoice.createTab?.({ title: 'タブ 1' });
          if (created?.ok && created.tab) {
            tabSummaries = [created.tab];
          }
        }

        const initialTabs = tabSummaries.map((summary) => {
          const job = summary.jobId ? jobMap.get(summary.jobId) ?? null : null;
          return buildTabState(summary, job);
        });
        setTabs(initialTabs);
        ensureActiveTab(initialTabs);
      } catch (err) {
        if (!cancelled) {
          appendAppLog(`[WARN] タブ情報の初期化に失敗しました: ${err}`, 'error');
        }
      } finally {
        if (!cancelled) {
          setTabsLoading(false);
          setJobsLoading(false);
        }
      }
    };

    void bootstrap();

    const disposeJobEvent = window.revoice.onJobEvent?.((event: JobEventMessage) => {
      if (cancelled) return;
      if (event.kind === 'updated') {
        const job = event.job;
        jobMapRef.current.set(job.id, job);
        if (job.tabId) {
          patchTab(job.tabId, (tab) => mergeJobIntoTab(tab, job));
        }
      } else if (event.kind === 'log') {
        const job = jobMapRef.current.get(event.jobId);
        const tabId = job?.tabId;
        if (tabId) {
          appendTabLog(tabId, event.message, event.level);
        }
      }
    });

    const disposeTabEvent = window.revoice.onTabEvent?.((event) => {
      if (cancelled) return;
      if (event.kind === 'updated') {
        const summary = event.tab;
        const job = summary.jobId ? jobMapRef.current.get(summary.jobId) ?? null : null;
        setTabs((prev) => {
          const existing = prev.find((tab) => tab.id === summary.id);
          if (existing) {
            return prev.map((tab) =>
              tab.id === summary.id
                ? {
                    ...existing,
                    title: summary.title ?? existing.title,
                    jobId: summary.jobId ?? existing.jobId,
                    createdAt: summary.createdAt ?? existing.createdAt,
                    updatedAt: summary.updatedAt ?? existing.updatedAt,
                  }
                : tab
            );
          }
          return [...prev, buildTabState(summary, job)];
        });
      } else if (event.kind === 'removed') {
        setTabs((prev) => {
          const next = prev.filter((tab) => tab.id !== event.tabId);
          if (next.length !== prev.length) {
            setActiveTabId((prevActive) => (prevActive === event.tabId ? next[0]?.id ?? null : prevActive));
          }
          return next;
        });
      }
    });

    return () => {
      cancelled = true;
      disposeJobEvent?.();
      disposeTabEvent?.();
    };
  }, [appendAppLog, appendTabLog, ensureActiveTab, patchTab]);

  useEffect(() => {
    let cancelled = false;

    const loadTranscriptionDefaults = async () => {
      if (!window.revoice.getTranscriptionDefaults) {
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
          appendAppLog(`[WARN] 出力スタイルの取得に失敗しました: ${response.error}`, 'error');
          setOutputStyle('plain');
        }
      } catch (err) {
        if (!cancelled) {
          appendAppLog(`[WARN] 出力スタイルの取得中にエラーが発生しました: ${err}`, 'error');
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
  }, [appendAppLog]);

  useEffect(() => {
    void fetchHistory(0, false);
  }, [fetchHistory]);
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
          appendAppLog(`[WARN] 履歴ポリシーの保存に失敗しました: ${response.error}`, 'error');
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
      appendAppLog(`[WARN] 履歴ポリシーの保存中にエラーが発生しました: ${message}`, 'error');
    } finally {
      setPolicySaving(false);
    }
  }, [appendAppLog, policyForm, validatePolicyForm]);

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
            appendAppLog(`[WARN] 履歴ポリシーの取得に失敗しました: ${response.error}`, 'error');
          }
          setRetentionPolicy(RECOMMENDED_POLICY);
          setPolicyForm(toFormState(RECOMMENDED_POLICY));
          setPolicyDirty(false);
        }
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          appendAppLog(`[WARN] 履歴ポリシーの取得中にエラーが発生しました: ${message}`, 'error');
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
  }, [appendAppLog]);

  useEffect(() => {
    if (!policySuccess) return;
    const timer = window.setTimeout(() => setPolicySuccess(null), 4000);
    return () => window.clearTimeout(timer);
  }, [policySuccess]);

  useEffect(() => {
    const disposeAdded = window.revoice.onHistoryAdded?.((record) => {
      const entry = historyRecordToEntry(record);
      setHistory((prev) => [entry, ...prev]);
      setHistoryTotal((prevTotal) => prevTotal + 1);
    });
    const disposeCleared = window.revoice.onHistoryCleared?.((payload) => {
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

  const handleNativeFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      if (!activeTabId) return;
      const file = event.target.files?.[0];
      if (!file) return;
      const filePath = (file as unknown as { path?: string }).path ?? file.name;
      patchTab(activeTabId, (tab) => ({
        ...tab,
        inputPath: filePath,
        outputPath: null,
        transcript: '',
        logs: [],
        errorMessage: null,
      }));
      event.target.value = '';
    },
    [activeTabId, patchTab]
  );

  const handleBrowse = useCallback(async () => {
    if (!activeTabId) return;
    if (window.revoice?.openFileDialog) {
      try {
        const selected = await window.revoice.openFileDialog();
        if (selected) {
          patchTab(activeTabId, (tab) => ({
            ...tab,
            inputPath: selected,
            outputPath: null,
            transcript: '',
            logs: [],
            errorMessage: null,
          }));
        }
        return;
      } catch (err) {
        appendAppLog(`[WARN] ファイル選択に失敗しました: ${err}`, 'error', activeTabId);
      }
    }
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  }, [activeTabId, appendAppLog, patchTab]);

  const handleStart = useCallback(async () => {
    const tab = activeTab;
    if (!tab) return;
    if (!tab.inputPath) {
      appendTabLog(tab.id, '入力ファイルを選択してください', 'error');
      patchTab(tab.id, (current) => ({ ...current, errorMessage: '入力ファイルを選択してください' }));
      return;
    }
    if (!window.revoice.enqueueJob) {
      appendTabLog(tab.id, 'このビルドではジョブのキュー登録に対応していません。', 'error');
      return;
    }

    const payload: TranscriptionJobPayload = {
      inputPath: tab.inputPath,
      tabId: tab.id,
      tabTitle: tab.title,
      outputDir: 'archive',
      model: 'large-v3',
      language: 'ja',
      beamSize: 5,
      computeType: 'int8',
      outputStyle,
      formats: 'txt,srt,vtt',
      minSegment: 0.6,
      preset: 'balanced',
      memo: false,
    };

    try {
      const response = await window.revoice.enqueueJob(payload);
      if (response.ok && response.job) {
        jobMapRef.current.set(response.job.id, response.job);
        patchTab(tab.id, (current) => mergeJobIntoTab(current, response.job!));
        appendTabLog(tab.id, 'ジョブをキューに追加しました。', 'info');
      } else {
        appendTabLog(tab.id, `ジョブのキュー追加に失敗しました: ${response.error ?? '不明なエラー'}`, 'error');
      }
    } catch (err) {
      appendTabLog(tab.id, `ジョブのキュー追加でエラーが発生しました: ${err}`, 'error');
    }
  }, [activeTab, appendTabLog, outputStyle, patchTab]);

  const handleCancel = useCallback(async () => {
    const tab = activeTab;
    if (!tab || !tab.jobId) return;
    if (!window.revoice.cancelJob) {
      appendTabLog(tab.id, 'このビルドではキャンセルに対応していません。', 'error');
      return;
    }
    try {
      const response = await window.revoice.cancelJob(tab.jobId);
      if (!response.ok && response.error) {
        appendTabLog(tab.id, `キャンセルに失敗しました: ${response.error}`, 'error');
      }
    } catch (err) {
      appendTabLog(tab.id, `キャンセルでエラーが発生しました: ${err}`, 'error');
    }
  }, [activeTab, appendTabLog]);

  const handleReset = useCallback(() => {
    if (!activeTabId) return;
    patchTab(activeTabId, (tab) => ({
      ...tab,
      inputPath: '',
      jobId: null,
      status: 'idle',
      queuePosition: null,
      progress: null,
      pid: null,
      outputPath: null,
      transcript: '',
      logs: [],
      errorMessage: null,
    }));
  }, [activeTabId, patchTab]);

  const historyHasSelection = selectedHistoryId !== null;

  const handleSelectHistory = useCallback(
    async (entry: HistoryEntry) => {
      setSelectedHistoryId(entry.id);
      if (window.revoice?.getHistoryDetail) {
        try {
          const response = await window.revoice.getHistoryDetail(entry.id);
          if (response?.ok && response.item?.transcriptFull) {
            const transcript = response.item.transcriptFull.trim();
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
          }
        } catch (err) {
          appendAppLog(`[WARN] 履歴の取得に失敗しました: ${err}`, 'error');
        }
      }
    },
    [appendAppLog]
  );

  const handleLoadMoreHistory = useCallback(() => {
    if (historyLoading) return;
    void fetchHistory(historyCursor, true);
  }, [fetchHistory, historyCursor, historyLoading]);

  const handleDeleteHistory = useCallback(
    async (entry: HistoryEntry) => {
      if (!window.revoice.deleteHistory) {
        appendAppLog('このビルドでは履歴の削除に対応していません。', 'error');
        return;
      }
      const confirmed = window.confirm(`履歴 "${entry.label}" を削除しますか？`);
      if (!confirmed) {
        return;
      }
      try {
        const response = await window.revoice.deleteHistory([entry.id]);
        if (response?.ok) {
          setHistory((prev) => prev.filter((item) => item.id !== entry.id));
          setHistoryTotal((prev) => Math.max(prev - 1, 0));
          if (selectedHistoryId === entry.id) {
            setSelectedHistoryId(null);
          }
          appendAppLog(`履歴 #${entry.id} を削除しました。`, 'info');
        } else {
          appendAppLog(`[WARN] 履歴の削除に失敗しました: ${response?.error ?? '不明なエラー'}`, 'error');
        }
      } catch (err) {
        appendAppLog(`[WARN] 履歴の削除でエラーが発生しました: ${err}`, 'error');
      }
    },
    [appendAppLog, selectedHistoryId]
  );

  const handleClearHistory = useCallback(async () => {
    if (!window.revoice.clearHistory) {
      setHistory([]);
      appendAppLog('履歴をクリアしました。', 'info');
      return;
    }
    try {
      const response = await window.revoice.clearHistory();
      if (response?.ok) {
        setHistory([]);
        setHistoryTotal(0);
        setHistoryCursor(0);
        setHistoryHasMore(false);
        appendAppLog(`履歴をクリアしました (${response.removed ?? 0}件)`, 'info');
      } else {
        appendAppLog(`[WARN] 履歴の消去に失敗しました: ${response?.error ?? '不明なエラー'}`, 'error');
      }
    } catch (err) {
      appendAppLog(`[WARN] 履歴の消去でエラーが発生しました: ${err}`, 'error');
    }
  }, [appendAppLog]);

  const handleCopyText = useCallback(
    async (content: string, successMessage: string, emptyMessage?: string) => {
      if (!content) {
        if (emptyMessage) appendAppLog(emptyMessage, 'info');
        return;
      }
      if (!navigator?.clipboard?.writeText) {
        appendAppLog('クリップボード API が利用できません。', 'error');
        return;
      }
      try {
        await navigator.clipboard.writeText(content);
        appendAppLog(successMessage, 'info');
      } catch (err) {
        appendAppLog(`クリップボードへのコピーに失敗しました: ${err}`, 'error');
      }
    },
    [appendAppLog]
  );

  const handleCopyTranscript = useCallback(() => {
    if (!activeTab) return;
    handleCopyText(
      activeTab.transcript,
      '文字起こしをクリップボードにコピーしました。',
      'コピーできる文字起こしがまだありません'
    );
  }, [activeTab, handleCopyText]);

  const handleCopyLogs = useCallback(() => {
    if (!activeTab) return;
    const body = activeTab.logs.map((entry) => `[${entry.timestamp}] ${entry.message}`).join('\n');
    handleCopyText(body, 'ログをクリップボードにコピーしました。', 'コピーできるログがまだありません');
  }, [activeTab, handleCopyText]);

  const handleCopyHistoryTranscript = useCallback(
    async (entry: HistoryEntry) => {
      await handleCopyText(
        entry.transcript,
        '履歴の文字起こしをコピーしました。',
        'この履歴にはコピーできる文字起こしがありません'
      );
    },
    [handleCopyText]
  );

  const handleAddTab = useCallback(async () => {
    if (tabsRef.current.length >= MAX_VISIBLE_TABS) {
      appendAppLog(`同時に開けるタブは最大 ${MAX_VISIBLE_TABS} 件です。`, 'error');
      return;
    }
    if (!window.revoice.createTab) return;
    const title = getNextTabTitle();
    try {
      const response = await window.revoice.createTab({ title });
      if (response?.ok && response.tab) {
        setTabs((prev) => {
          if (prev.some((tab) => tab.id === response.tab!.id)) {
            return prev;
          }
          return [...prev, buildTabState(response.tab!, null)];
        });
        setActiveTabId(response.tab!.id);
      } else if (response?.error) {
        appendAppLog(`タブの作成に失敗しました: ${response.error}`, 'error');
      }
    } catch (err) {
      appendAppLog(`タブの作成でエラーが発生しました: ${err}`, 'error');
    }
  }, [appendAppLog, getNextTabTitle]);

  const handleTitleChange = useCallback(
    async (tabId: string, title: string) => {
      patchTab(tabId, (tab) => ({ ...tab, title }));
      try {
        await window.revoice.updateTab?.({ id: tabId, title });
      } catch (err) {
        appendAppLog(`タブ名の更新に失敗しました: ${err}`, 'error');
      }
    },
    [appendAppLog, patchTab]
  );

  const handleDeleteTab = useCallback(
    async (tabId: string) => {
      if (!window.revoice.deleteTab) return;
      try {
        const response = await window.revoice.deleteTab(tabId);
        if (response?.ok) {
          setTabs((prev) => {
            const next = prev.filter((tab) => tab.id !== tabId);
            if (next.length !== prev.length) {
              setActiveTabId((prevActive) => (prevActive === tabId ? next[0]?.id ?? null : prevActive));
            }
            return next;
          });
        } else if (response?.error) {
          appendAppLog(`タブの削除に失敗しました: ${response.error}`, 'error');
        }
      } catch (err) {
        appendAppLog(`タブの削除でエラーが発生しました: ${err}`, 'error');
      }
    },
    [appendAppLog]
  );

  const retentionSettingsPanel = (
    <section className="panel panel--settings">
      <header className="panel__header">
        <h2>履歴保持ポリシー</h2>
        <div className="panel__tools">
          {policyLoading && <span className="policy__loader">読み込み中…</span>}
          {retentionPolicy && !policyLoading && (
            <span className="policy__badge">{retentionPolicy.mode === 'recommended' ? '推奨プリセット' : 'カスタム設定'}</span>
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
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          return (
            <div key={tab.id} className={`transcribe-tabs__item ${isActive ? 'transcribe-tabs__item--active' : ''}`}>
              <button
                type="button"
                className={`transcribe-tabs__button ${isActive ? 'transcribe-tabs__button--active' : ''}`}
                onClick={() => setActiveTabId(tab.id)}
                aria-pressed={isActive}
                aria-current={isActive ? 'page' : undefined}
              >
                {tab.title}
              </button>
              {tabs.length > 1 && (
                <button
                  type="button"
                  className="transcribe-tabs__close"
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleDeleteTab(tab.id);
                  }}
                  aria-label={`${tab.title} を閉じる`}
                >
                  <span aria-hidden="true">×</span>
                </button>
              )}
            </div>
          );
        })}
        <button
          type="button"
          className="transcribe-tabs__button transcribe-tabs__button--add"
          onClick={handleAddTab}
          disabled={tabs.length >= MAX_VISIBLE_TABS}
          aria-label="タブを追加"
        >
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
              onClick={() => {
                setOutputStyle(style);
                window.revoice.setTranscriptionDefaults?.({ outputStyle: style }).catch((err) => {
                  appendAppLog(`[WARN] 出力スタイルの保存に失敗しました: ${err}`, 'error', activeTabId);
                });
              }}
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
        <div className={`dropzone ${activeTab?.inputPath ? 'dropzone--selected' : ''}`}>
          <div className="dropzone__path">
            {activeTab?.inputPath || 'ファイルをドラッグ&ドロップ、またはボタンから選択してください'}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".wav,.mp3,.m4a,.aac,.flac,.ogg,.mp4,.mov,.mkv"
            className="sr-only"
            onChange={handleNativeFileChange}
          />
          <button type="button" className="button button--primary" onClick={handleBrowse} disabled={!activeTab}>
            ファイルを選ぶ
          </button>
        </div>
        <div className="panel__actions">
          <button type="button" className="button button--primary" onClick={handleStart} disabled={startDisabled || tabsLoading}>
            {activeTab?.status === 'queued' ? '待機中…' : activeTab?.status === 'running' ? '解析中…' : '文字起こしを開始'}
          </button>
          <button type="button" className="button button--outline" onClick={handleCancel} disabled={!activeTab || !activeTab.jobId}>
            キャンセル
          </button>
          <button type="button" className="button button--subtle" onClick={handleReset} disabled={!activeTab}>
            リセット
          </button>
        </div>
        <div className="run-status">
          {activeTab?.queuePosition && activeTab.queuePosition > 0 && (
            <span>待機順: {activeTab.queuePosition}</span>
          )}
          {activeTab?.pid && <span>PID: {activeTab.pid}</span>}
          {activeTab?.outputPath && <span>出力ファイル: {activeTab.outputPath}</span>}
          {activeTab?.errorMessage && <span className="run-status__error">{activeTab.errorMessage}</span>}
        </div>
        {(() => {
          const progressValue = activeTab?.progress;
          if (progressValue === null || progressValue === undefined) return null;
          const clamped = Math.min(Math.max(progressValue, 0), 100);
          return (
            <div className="progress">
              <div className="progress__track">
                <div className="progress__bar" style={{ width: `${clamped}%` }} />
              </div>
              <span className="progress__label">{clamped.toFixed(1)}%</span>
            </div>
          );
        })()}
      </section>

      <section className="panel panel--transcript">
        <header className="panel__header">
          <h2>文字起こし結果</h2>
          <div className="panel__tools">
            <button type="button" className="button button--ghost button--small" onClick={handleCopyTranscript} disabled={!activeTab || !activeTab.transcript}>
              コピー
            </button>
          </div>
        </header>
        <div className="transcript">
          {activeTab?.transcript ? (
            <pre className="transcript__body">{activeTab.transcript}</pre>
          ) : (
            <div className="transcript__placeholder">
              {activeTab?.status === 'running'
                ? '解析中です…'
                : '解析が完了すると、ここに結果が表示されます。'}
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
                  <li key={entry.id} className="history-list__entry">
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
                            : entry.status === 'cancelled'
                            ? 'キャンセル'
                            : entry.status}
                        </span>
                      )}
                      <span className="history-list__time">{formatHistoryTime(entry.finishedAt)}</span>
                    </button>
                    <button
                      type="button"
                      className="history-list__delete"
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleDeleteHistory(entry);
                      }}
                    >
                      <IconTrash aria-hidden="true" />
                      <span className="sr-only">履歴を削除</span>
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
            {historyHasSelection && selectedHistory ? (
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
                            : selectedHistory.status === 'cancelled'
                            ? 'キャンセル'
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
                      <IconRefresh aria-hidden="true" />
                      <span className="sr-only">内容を再読み込み</span>
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => {
                        void handleCopyHistoryTranscript(selectedHistory);
                      }}
                    >
                      <IconCopy aria-hidden="true" />
                      <span className="sr-only">文字起こしをコピー</span>
                    </button>
                    <button
                      type="button"
                      className="icon-button icon-button--danger"
                      onClick={() => {
                        void handleDeleteHistory(selectedHistory);
                      }}
                    >
                      <IconTrash aria-hidden="true" />
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
            <button type="button" className="button button--ghost button--small" onClick={handleCopyLogs} disabled={!activeTab || activeTab.logs.length === 0}>
              コピー
            </button>
          </div>
        </header>
        <div className="log log--full">
          {!activeTab || activeTab.logs.length === 0 ? (
            <div className="log__placeholder">処理の進行状況がここに表示されます。</div>
          ) : (
            activeTab.logs.map((entry) => (
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

  const mainContent = useMemo(() => {
    switch (activePage) {
      case 'vtt-transcribe':
        return renderTranscribe;
      case 'vtt-history':
        return renderHistory;
      case 'vtt-logs':
        return renderLogs;
      case 'settings-vtt':
        return <div className="settings-view">{retentionSettingsPanel}</div>;
      case 'mtv-convert':
        return renderPlaceholder('Movie to Voice - 変換', '映像から音声への変換ワークフローをここに追加予定です。');
      case 'mtv-logs':
        return renderPlaceholder('Movie to Voice - ログ', '変換処理のログは今後ここに表示されます。');
      case 'settings-mtv':
        return renderPlaceholder('Movie to Voice の設定', '現在準備中です。');
      default:
        return renderPlaceholder('準備中', '今後のアップデートをお待ちください。');
    }
  }, [activePage, renderHistory, renderLogs, renderTranscribe, retentionSettingsPanel]);

  const navGroups: {
    title: string;
    items: { key: typeof activePage; label: string }[];
  }[] = [
    {
      title: '動画音声→テキスト',
      items: [
        { key: 'vtt-transcribe', label: '文字起こし' },
        { key: 'vtt-history', label: '履歴' },
        { key: 'vtt-logs', label: 'ログ' },
      ],
    },
    {
      title: '動画→音声',
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
        <div className="sidebar__brand">
          <img className="sidebar__brand-logo" src={revoiceLogo} alt="Revoice" />
        </div>
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
                        aria-current={active ? 'page' : undefined}
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
      </aside>

      <main className="app-shell__main">
        <div className="main-header">
          <div className="main-header__titles">
            <h1 className="main-header__title">
              {(() => {
                switch (activePage) {
                  case 'vtt-transcribe':
                    return '文字起こし';
                  case 'vtt-history':
                    return '履歴';
                  case 'vtt-logs':
                    return 'ログ';
                  case 'settings-vtt':
                    return 'Voice to textの設定';
                  case 'mtv-convert':
                    return 'Movie to Voice - 変換';
                  case 'mtv-logs':
                    return 'Movie to Voice - ログ';
                  case 'settings-mtv':
                    return 'Movie to Voiceの設定';
                  default:
                    return 'Revoice';
                }
              })()}
            </h1>
          </div>
          <div className="main-header__controls">
            <div className={`status-pill status-pill--${statusPillClass}`}>
              <span className="status-pill__label">STATUS</span>
              <span className="status-pill__value">{statusLabel}</span>
            </div>
          </div>
        </div>
        {mainContent}
      </main>
    </div>
  );
};

export default App;
