import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, CSSProperties, DragEvent, SVGProps } from 'react';
import type {
  ConversionPreset,
  ConversionSettings,
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
  processingMs?: number | null;
  transcriptCharCount?: number | null;
  sourceConversionJobId?: string | null;
  errorMessage?: string | null;
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
  processingMs: number | null;
  transcriptCharCount: number | null;
  sourceConversionJobId?: string | null;
};

type ScheduleOption = '12h' | '24h' | 'startup' | 'custom';

type RetentionFormState = {
  mode: 'recommended' | 'custom';
  maxDays: string;
  maxEntries: string;
  scheduleOption: ScheduleOption;
  scheduleHours: string;
};

type ConversionJobState = {
  job: JobSummary;
  logs: LogEntry[];
  linkedJobId: string | null;
  linkedJob: JobSummary | null;
};

type ConversionSettingsForm = {
  presetKey: ConversionPresetKey;
  outputDir: string;
  format: 'aac' | 'flac' | 'ogg' | 'wav';
  bitrateKbps: string;
  sampleRate: string;
  channels: string;
  maxParallelJobs: string;
  autoCreateTranscribeTab: boolean;
  ffmpegPath: string;
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

type ConversionPresetKey = 'balanced' | 'highQuality' | 'lightweight' | 'custom';

type ConversionPresetOption = {
  key: ConversionPresetKey;
  label: string;
  description: string;
  preset?: ConversionPreset;
};

const DEFAULT_CONVERSION_PRESET_VALUE: ConversionPreset = {
  format: 'aac',
  bitrateKbps: 128,
  sampleRate: 16000,
  channels: 1,
};

const CONVERSION_PRESET_OPTIONS: ConversionPresetOption[] = [
  {
    key: 'balanced',
    label: 'バランス（推奨）',
    description: 'AAC / 16kHz / モノラル / 128kbps',
    preset: DEFAULT_CONVERSION_PRESET_VALUE,
  },
  {
    key: 'highQuality',
    label: '高音質',
    description: 'FLAC / 44.1kHz / ステレオ',
    preset: { format: 'flac', bitrateKbps: 0, sampleRate: 44100, channels: 2 },
  },
  {
    key: 'lightweight',
    label: '軽量（高速）',
    description: 'AAC / 16kHz / モノラル / 64kbps',
    preset: { format: 'aac', bitrateKbps: 64, sampleRate: 16000, channels: 1 },
  },
  {
    key: 'custom',
    label: 'カスタム',
    description: '自分で詳細設定を行う',
  },
];

const CONVERSION_FORMAT_LABELS: Record<ConversionSettingsForm['format'], string> = {
  aac: 'AAC (m4a)',
  flac: 'FLAC',
  ogg: 'OGG (Vorbis)',
  wav: 'WAV (PCM)',
};

const CONVERSION_SAMPLE_RATE_OPTIONS = [16000, 24000, 44100] as const;
const CONVERSION_CHANNEL_OPTIONS = [1, 2] as const;
const CONVERSION_BITRATE_OPTIONS = [64, 128, 192] as const;
const MAX_CONVERSION_JOB_LOGS = 300;
const CONVERSION_HISTORY_PAGE_SIZE = 20;

const DEFAULT_CONVERSION_PRESET_KEY: ConversionPresetKey = 'balanced';

const DEFAULT_CONVERSION_FORM: ConversionSettingsForm = {
  presetKey: DEFAULT_CONVERSION_PRESET_KEY,
  outputDir: '',
  format: DEFAULT_CONVERSION_PRESET_VALUE.format,
  bitrateKbps: String(DEFAULT_CONVERSION_PRESET_VALUE.bitrateKbps),
  sampleRate: String(DEFAULT_CONVERSION_PRESET_VALUE.sampleRate),
  channels: String(DEFAULT_CONVERSION_PRESET_VALUE.channels),
  maxParallelJobs: '2',
  autoCreateTranscribeTab: false,
  ffmpegPath: '',
};

const normalizeConversionPresetFromSettings = (preset?: ConversionPreset | null): ConversionPreset => {
  const base = CONVERSION_PRESET_OPTIONS.find((option) => option.key === DEFAULT_CONVERSION_PRESET_KEY)?.preset ?? DEFAULT_CONVERSION_PRESET_VALUE;
  if (!preset) {
    return { ...base };
  }
  return {
    format: (['aac', 'flac', 'ogg', 'wav'] as const).includes(preset.format as ConversionSettingsForm['format'])
      ? (preset.format as ConversionSettingsForm['format'])
      : base.format,
    bitrateKbps: Number.isFinite(preset.bitrateKbps) ? Number(preset.bitrateKbps) : base.bitrateKbps,
    sampleRate: Number.isFinite(preset.sampleRate) ? Number(preset.sampleRate) : base.sampleRate,
    channels: Number.isFinite(preset.channels) ? Number(preset.channels) : base.channels,
  };
};

const detectPresetKeyForPreset = (preset: ConversionPreset): ConversionPresetKey => {
  const matched = CONVERSION_PRESET_OPTIONS.find(
    (option) =>
      option.preset &&
      option.preset.format === preset.format &&
      option.preset.sampleRate === preset.sampleRate &&
      option.preset.channels === preset.channels &&
      (option.preset.format === 'aac' || option.preset.format === 'ogg'
        ? option.preset.bitrateKbps === preset.bitrateKbps
        : true)
  );
  return matched?.key ?? 'custom';
};

const toConversionFormState = (settings: ConversionSettings): ConversionSettingsForm => {
  const normalizedPreset = normalizeConversionPresetFromSettings(settings.defaultPreset);
  const presetKey = detectPresetKeyForPreset(normalizedPreset);
  return {
    presetKey,
    outputDir: settings.outputDir ?? '',
    format: normalizedPreset.format,
    bitrateKbps: String(normalizedPreset.bitrateKbps),
    sampleRate: String(normalizedPreset.sampleRate),
    channels: String(normalizedPreset.channels),
    maxParallelJobs: String(settings.maxParallelJobs ?? Number(DEFAULT_CONVERSION_FORM.maxParallelJobs)),
    autoCreateTranscribeTab: Boolean(settings.autoCreateTranscribeTab),
    ffmpegPath: settings.ffmpegPath ?? '',
  };
};

const formatSeconds = (value: unknown): string => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '—';
  }
  const total = Math.max(0, value);
  const minutes = Math.floor(total / 60);
  const seconds = Math.floor(total % 60);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
};

const formatBytes = (value: unknown): string => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '—';
  const mb = value / (1024 * 1024);
  if (mb >= 1) {
    return `${mb.toFixed(1)} MB`;
  }
  const kb = value / 1024;
  return `${kb.toFixed(1)} KB`;
};

const formatDurationMs = (value: unknown): string => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '—';
  const totalSeconds = Math.max(0, Math.floor(value / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) {
    return `${seconds}s`;
  }
  return `${minutes}m ${seconds}s`;
};

const formatCompression = (sourceBytes: unknown, outputBytes: unknown, savedPercent: unknown) => {
  const sourceLabel = formatBytes(sourceBytes);
  const outputLabel = formatBytes(outputBytes);
  if (typeof savedPercent === 'number' && Number.isFinite(savedPercent)) {
    const sign = savedPercent >= 0 ? '-' : '+';
    return `${sourceLabel} → ${outputLabel} (${sign}${Math.abs(savedPercent).toFixed(1)}%)`;
  }
  return `${sourceLabel} → ${outputLabel}`;
};

const truncateLabel = (input: string, max = 10): string => {
  if (!input) return '';
  const chars = Array.from(input.trim());
  if (chars.length <= max) {
    return chars.join('');
  }
  return `${chars.slice(0, max).join('')}…`;
};

const titleFromPath = (fullPath: string | null | undefined, max = 10): string => {
  if (!fullPath) return 'タブ';
  const base = fileNameFromPath(fullPath) || fullPath;
  const truncated = truncateLabel(base, max);
  return truncated || 'タブ';
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

const GPTS_URL = 'https://chatgpt.com/g/g-68df6cd0042c8191a2e8adf4717400b0-revoice-supporter';

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

const IconLaunch = (props: SVGProps<SVGSVGElement>) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M5 12V5a2 2 0 0 1 2-2h7" />
    <path d="M5 19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7" />
    <path d="M12 12l10-10" />
    <path d="M15 2h7v7" />
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

const historyRecordToEntry = (record: HistoryRecord): HistoryEntry => {
  let processingMs: number | null = null;
  let transcriptCharCount: number | null = null;
  let sourceConversionJobId: string | null = null;
  let errorMessage: string | null = null;
  if (record.notes) {
    try {
      const parsed = JSON.parse(record.notes) as Record<string, unknown>;
      if (typeof parsed.processingMs === 'number') processingMs = parsed.processingMs;
      if (typeof parsed.transcriptCharCount === 'number') transcriptCharCount = parsed.transcriptCharCount;
      if (typeof parsed.sourceConversionJobId === 'string') sourceConversionJobId = parsed.sourceConversionJobId;
      if (typeof parsed.error === 'string') {
        errorMessage = parsed.error;
      } else if (typeof parsed.message === 'string') {
        errorMessage = parsed.message;
      }
    } catch (err) {
      // ignore non-JSON notes
    }
  }
  return {
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
    processingMs,
    transcriptCharCount,
    sourceConversionJobId,
    errorMessage,
  };
};

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
  const metadata = job?.metadata as Record<string, unknown> | undefined;
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
    processingMs: typeof metadata?.processingMs === 'number' ? metadata.processingMs : null,
    transcriptCharCount: typeof metadata?.transcriptCharCount === 'number' ? metadata.transcriptCharCount : null,
    sourceConversionJobId: typeof metadata?.sourceConversionJobId === 'string' ? metadata.sourceConversionJobId : null,
  };
};

const mergeJobIntoTab = (tab: TabState, job: JobSummary): TabState => {
  const status = job.status ?? tab.status;
  const metadata = job.metadata as Record<string, unknown> | undefined;
  let transcript = tab.transcript;
  if (job.transcript && job.transcript.length > 0) {
    transcript = job.transcript;
  }
  const outputPath = job.outputPath ?? tab.outputPath;
  const progress = typeof job.progress === 'number' ? job.progress : tab.progress;
  const errorMessage = job.error ?? (status === 'failed' ? 'ジョブが失敗しました' : status === 'cancelled' ? 'ジョブがキャンセルされました' : null);
  const inputPath = job.inputPath ?? tab.inputPath;
  const derivedTitle = tab.title === 'タブ' && inputPath ? titleFromPath(inputPath, 10) : tab.title;
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
    inputPath,
    title: derivedTitle,
    processingMs: typeof metadata?.processingMs === 'number' ? metadata.processingMs : tab.processingMs,
    transcriptCharCount: typeof metadata?.transcriptCharCount === 'number' ? metadata.transcriptCharCount : tab.transcriptCharCount,
    sourceConversionJobId: typeof metadata?.sourceConversionJobId === 'string' ? metadata.sourceConversionJobId : tab.sourceConversionJobId,
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
  const [activePage, setActivePage] = useState<'vtt-transcribe' | 'vtt-history' | 'settings-vtt' | 'mtv-convert' | 'mtv-history' | 'settings-mtv' | 'settings-logs'>('vtt-transcribe');
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

  const [conversionJobs, setConversionJobs] = useState<ConversionJobState[]>([]);
  const conversionJobMapRef = useRef<Map<string, ConversionJobState>>(new Map());
  const [conversionSettings, setConversionSettings] = useState<ConversionSettings | null>(null);
  const [conversionForm, setConversionForm] = useState<ConversionSettingsForm>(DEFAULT_CONVERSION_FORM);
  const [conversionSettingsDirty, setConversionSettingsDirty] = useState(false);
  const [conversionSettingsSaving, setConversionSettingsSaving] = useState(false);
  const [conversionSettingsErrors, setConversionSettingsErrors] = useState<string[]>([]);
  const [conversionSettingsSuccess, setConversionSettingsSuccess] = useState<string | null>(null);
  const [conversionDragActive, setConversionDragActive] = useState(false);
  const [conversionEnqueueing, setConversionEnqueueing] = useState(false);
  const conversionDragCounterRef = useRef(0);
  const [conversionHistory, setConversionHistory] = useState<JobSummary[]>([]);
  const [conversionHistoryOffset, setConversionHistoryOffset] = useState(0);
  const conversionHistoryOffsetRef = useRef(0);
  const [conversionHistoryTotal, setConversionHistoryTotal] = useState(0);
  const [conversionHistoryLoading, setConversionHistoryLoading] = useState(false);
  const [conversionHistoryHasMore, setConversionHistoryHasMore] = useState(false);
  const [selectedConversionHistoryId, setSelectedConversionHistoryId] = useState<string | null>(null);

  const logCounter = useRef(0);
  const jobMapRef = useRef<Map<string, JobSummary>>(new Map());
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const tabsRef = useRef<TabState[]>([]);
  const activeTabIdRef = useRef<string | null>(null);
  const initialTabEnsuredRef = useRef(false);
  const [gptsSending, setGptsSending] = useState<Record<string, boolean>>({});

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

  const ensureTabForJob = useCallback((job: JobSummary) => {
    if (!job.tabId) return;
    setTabs((prev) => {
      if (prev.some((tab) => tab.id === job.tabId)) {
        return prev;
      }
      const metadata = job.metadata as Record<string, unknown> | undefined;
      const payload = metadata?.payload as Record<string, unknown> | undefined;
      const payloadTitle = payload && typeof payload.tabTitle === 'string' ? payload.tabTitle : null;
      const derivedTitle = payloadTitle && payloadTitle.trim().length > 0
        ? payloadTitle.trim()
        : titleFromPath(job.inputPath ?? job.outputPath ?? job.id, 10);
      const summary: TabSummary = {
        id: job.tabId,
        title: derivedTitle,
        jobId: job.id,
        state: job.status ?? null,
        meta: null,
        createdAt: job.createdAt ?? null,
        updatedAt: job.updatedAt ?? null,
        lastOpenedAt: job.updatedAt ?? null,
      };
      return [...prev, buildTabState(summary, job)];
    });
  }, []);

  const statusLabel = useMemo(() => TAB_STATUS_LABEL[activeTab?.status ?? 'idle'], [activeTab]);
  const statusPillClass = useMemo(() => STATUS_PILL_CLASS[activeTab?.status ?? 'idle'], [activeTab]);
  const startDisabled = !activeTab || activeTab.status === 'running' || activeTab.status === 'queued';

  const conversionPresetOption = useMemo(
    () => CONVERSION_PRESET_OPTIONS.find((option) => option.key === conversionForm.presetKey) ?? null,
    [conversionForm.presetKey]
  );

  const conversionPreset = useMemo(() => {
    if (conversionPresetOption?.preset) {
      return conversionPresetOption.preset;
    }
    return {
      format: conversionForm.format,
      bitrateKbps: Number(conversionForm.bitrateKbps) || Number(DEFAULT_CONVERSION_FORM.bitrateKbps),
      sampleRate: Number(conversionForm.sampleRate) || Number(DEFAULT_CONVERSION_FORM.sampleRate),
      channels: Number(conversionForm.channels) || Number(DEFAULT_CONVERSION_FORM.channels),
    };
  }, [conversionForm, conversionPresetOption]);

  const conversionRequiresBitrate = useMemo(
    () => conversionPreset.format === 'aac' || conversionPreset.format === 'ogg',
    [conversionPreset.format]
  );

  const conversionSettingsSaveDisabled = useMemo(
    () => conversionSettingsSaving || !conversionSettingsDirty,
    [conversionSettingsDirty, conversionSettingsSaving]
  );

  const conversionPresetSummary = useMemo(() => {
    if (conversionPresetOption && conversionPresetOption.key !== 'custom') {
      return conversionPresetOption.description;
    }
    const rateLabel = `${Math.round(conversionPreset.sampleRate / 1000)}kHz`;
    const channelLabel = conversionPreset.channels === 1 ? 'モノラル' : 'ステレオ';
    const bitratePart = conversionRequiresBitrate ? ` / ${conversionPreset.bitrateKbps}kbps` : '';
    return `${CONVERSION_FORMAT_LABELS[conversionPreset.format]} / ${rateLabel} / ${channelLabel}${bitratePart}`;
  }, [conversionPreset, conversionPresetOption, conversionRequiresBitrate]);

  const transcriptionActiveCount = useMemo(
    () => tabs.filter((tab) => tab.status === 'running' || tab.status === 'queued').length,
    [tabs]
  );

  const conversionActiveCount = useMemo(
    () => conversionJobs.filter((entry) => entry.job.status === 'running' || entry.job.status === 'queued').length,
    [conversionJobs]
  );

  const selectedConversionHistoryJob = useMemo(
    () => conversionHistory.find((job) => job.id === selectedConversionHistoryId) ?? conversionHistory[0] ?? null,
    [conversionHistory, selectedConversionHistoryId]
  );

  const scheduleOptionLabels: Record<ScheduleOption, string> = useMemo(
    () => ({
      '12h': '12時間ごと',
      '24h': '24時間ごと',
      startup: '起動時のみ',
      custom: 'カスタム',
    }),
    []
  );

  const activeConversionEntries = useMemo(
    () => conversionJobs.filter((entry) => entry.job.status === 'queued' || entry.job.status === 'running'),
    [conversionJobs]
  );

  const recentConversionEntries = useMemo(() => {
    const completed = conversionJobs.filter((entry) => entry.job.status === 'completed' || entry.job.status === 'failed' || entry.job.status === 'cancelled');
    return completed.slice(0, 3);
  }, [conversionJobs]);

  const sessionConversionEntries = useMemo(() => {
    const ids = new Set<string>();
    const ordered: ConversionJobState[] = [];
    [...activeConversionEntries, ...recentConversionEntries].forEach((entry) => {
      if (!ids.has(entry.job.id)) {
        ids.add(entry.job.id);
        ordered.push(entry);
      }
    });
    return ordered;
  }, [activeConversionEntries, recentConversionEntries]);

  const policySaveDisabled = useMemo(() => policyLoading || policySaving || !policyDirty, [policyLoading, policySaving, policyDirty]);
  const selectedHistory = useMemo(() => {
    if (selectedHistoryId === null) return null;
    return history.find((entry) => entry.id === selectedHistoryId) ?? null;
  }, [history, selectedHistoryId]);

  const activeTabGptsSending = useMemo(() => (activeTab ? Boolean(gptsSending[`tab:${activeTab.id}`]) : false), [activeTab, gptsSending]);
  const historyGptsSending = useMemo(
    () => (selectedHistory ? Boolean(gptsSending[`history:${selectedHistory.id}`]) : false),
    [selectedHistory, gptsSending]
  );

  const patchTab = useCallback(
    (tabId: string, updater: (tab: TabState) => TabState, fallbackJob?: JobSummary | null) => {
    setTabs((prev) => {
      let found = false;
      const next = prev.map((tab) => {
        if (tab.id === tabId) {
          found = true;
          return updater(tab);
        }
        return tab;
      });
      if (!found && fallbackJob && fallbackJob.tabId === tabId) {
        if (prev.length >= MAX_VISIBLE_TABS) {
          return prev;
        }
        const metadata = fallbackJob.metadata as Record<string, unknown> | undefined;
        const payload = metadata?.payload as Record<string, unknown> | undefined;
        const payloadTitle = payload && typeof payload.tabTitle === 'string' ? payload.tabTitle.trim() : '';
        const titleSource = payloadTitle && payloadTitle.length > 0
          ? payloadTitle
            : titleFromPath(fallbackJob.inputPath ?? fallbackJob.outputPath ?? fallbackJob.id, 10);
          const summary: TabSummary = {
            id: fallbackJob.tabId ?? tabId,
            title: titleSource,
            jobId: fallbackJob.id,
            state: fallbackJob.status ?? null,
            meta: null,
            createdAt: fallbackJob.createdAt ?? null,
            updatedAt: fallbackJob.updatedAt ?? null,
            lastOpenedAt: fallbackJob.updatedAt ?? null,
          };
          const seed = buildTabState(summary, fallbackJob);
          const merged = updater(seed);
          return [...next, merged];
        }
        return next;
      });
    },
    []
  );

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

  const looksLikeConversionJob = useCallback((job: JobSummary | null | undefined) => {
    if (!job) return false;
    if (job.type === 'conversion') return true;
    if (job.type === 'transcription') return false;
    const metadata = (job.metadata ?? {}) as Record<string, unknown>;
    if (typeof metadata.preset === 'object' && metadata.preset !== null) {
      const preset = metadata.preset as Record<string, unknown>;
      if (typeof preset.format === 'string') {
        return true;
      }
    }
    if (typeof metadata.sourceInputPath === 'string') {
      return true;
    }
    return false;
  }, []);

  const normalizeConversionJobSummary = useCallback(
    (job: JobSummary): JobSummary => (looksLikeConversionJob(job) && job.type !== 'conversion' ? { ...job, type: 'conversion' } : job),
    [looksLikeConversionJob]
  );

  const findLinkedTranscriptionJobId = useCallback(
    (conversionId: string): string | null => {
      for (const job of jobMapRef.current.values()) {
        if (looksLikeConversionJob(job)) continue;
        const metadata = (job.metadata ?? {}) as Record<string, unknown>;
        if (typeof metadata.sourceConversionJobId === 'string' && metadata.sourceConversionJobId === conversionId) {
          return job.id;
        }
      }
      return null;
    },
    [looksLikeConversionJob]
  );

  const deriveLinkedTranscriptionJob = useCallback(
    (job: JobSummary): { linkedJobId: string | null; linkedJob: JobSummary | null } => {
      const metadata = (job.metadata ?? {}) as Record<string, unknown>;
      let linkedJobId = typeof metadata.linkedTranscriptionJobId === 'string' ? metadata.linkedTranscriptionJobId : null;
      if (!linkedJobId) {
        linkedJobId = findLinkedTranscriptionJobId(job.id);
      }
      const linkedJob = linkedJobId ? jobMapRef.current.get(linkedJobId) ?? null : null;
      return { linkedJobId, linkedJob };
    },
    [findLinkedTranscriptionJobId]
  );

  const buildConversionJobState = useCallback(
    (job: JobSummary, existing?: ConversionJobState | null): ConversionJobState => {
      const normalizedJob = normalizeConversionJobSummary(job);
      const baseEntry = existing ?? conversionJobMapRef.current.get(normalizedJob.id) ?? null;
      const logs = baseEntry?.logs ?? [];
      const { linkedJobId, linkedJob } = deriveLinkedTranscriptionJob(normalizedJob);
      return {
        job: normalizedJob,
        logs,
        linkedJobId,
        linkedJob,
      };
    },
    [deriveLinkedTranscriptionJob, normalizeConversionJobSummary]
  );

  const syncConversionJobs = useCallback(() => {
    const entries = Array.from(conversionJobMapRef.current.values()).sort((a, b) => {
      const timeOf = (summary: JobSummary) => {
        const candidate = summary.updatedAt ?? summary.finishedAt ?? summary.startedAt ?? summary.createdAt;
        const parsed = candidate ? Date.parse(candidate) : NaN;
        return Number.isFinite(parsed) ? parsed : 0;
      };
      return timeOf(b.job) - timeOf(a.job);
    });
    setConversionJobs(entries);
  }, []);

  const upsertConversionJob = useCallback(
    (job: JobSummary) => {
      if (!looksLikeConversionJob(job)) return;
      const existing = conversionJobMapRef.current.get(job.id) ?? null;
      const state = buildConversionJobState(job, existing);
      conversionJobMapRef.current.set(state.job.id, state);
      syncConversionJobs();
    },
    [buildConversionJobState, looksLikeConversionJob, syncConversionJobs]
  );

  const appendConversionLog = useCallback(
    (jobId: string, message: string, level: LogEntry['level'] = 'info') => {
      const baseEntry = conversionJobMapRef.current.get(jobId) ?? null;
      const currentJob = baseEntry?.job ?? jobMapRef.current.get(jobId);
      if (!currentJob || !looksLikeConversionJob(currentJob)) {
        return;
      }
      const baseLogs = baseEntry?.logs ?? [];
      const record: LogEntry = {
        id: ++logCounter.current,
        timestamp: new Date().toLocaleTimeString('ja-JP', { hour12: false }),
        message,
        level,
      };
      const nextLogs = [...baseLogs, record];
      const trimmedLogs = nextLogs.length > MAX_CONVERSION_JOB_LOGS ? nextLogs.slice(nextLogs.length - MAX_CONVERSION_JOB_LOGS) : nextLogs;
      const updatedState = buildConversionJobState(currentJob, baseEntry);
      conversionJobMapRef.current.set(jobId, {
        ...updatedState,
        logs: trimmedLogs,
      });
      syncConversionJobs();
    },
    [buildConversionJobState, looksLikeConversionJob, syncConversionJobs]
  );

  const refreshConversionLinkage = useCallback(
    (conversionId: string) => {
      const conversionJob = jobMapRef.current.get(conversionId);
      if (conversionJob && looksLikeConversionJob(conversionJob)) {
        upsertConversionJob(conversionJob);
        return;
      }
      const existing = conversionJobMapRef.current.get(conversionId);
      if (existing) {
        const updatedState = buildConversionJobState(existing.job, existing);
        conversionJobMapRef.current.set(conversionId, updatedState);
        syncConversionJobs();
      }
    },
    [buildConversionJobState, looksLikeConversionJob, syncConversionJobs, upsertConversionJob]
  );

  const fetchConversionHistory = useCallback(
    async (reset = false) => {
      if (!window.revoice?.listConversionHistory) return;
      setConversionHistoryLoading(true);
      try {
        if (reset) {
          setConversionHistoryOffset(0);
          conversionHistoryOffsetRef.current = 0;
        }
        const offset = reset ? 0 : conversionHistoryOffsetRef.current;
        const response = await window.revoice.listConversionHistory({ limit: CONVERSION_HISTORY_PAGE_SIZE, offset });
        if (response?.ok) {
          setConversionHistory((prev) => (reset ? response.jobs : [...prev, ...response.jobs]));
          const nextOffset = offset + response.jobs.length;
          setConversionHistoryOffset(nextOffset);
          conversionHistoryOffsetRef.current = nextOffset;
          setConversionHistoryTotal(response.total);
          setConversionHistoryHasMore(nextOffset < response.total);
          if (reset) {
            setSelectedConversionHistoryId(response.jobs[0]?.id ?? null);
          }
        } else if (response?.error) {
          appendAppLog(`[WARN] 変換履歴の取得に失敗しました: ${response.error}`, 'error');
        }
      } catch (err) {
        appendAppLog(`[WARN] 変換履歴の取得でエラーが発生しました: ${err}`, 'error');
      } finally {
        setConversionHistoryLoading(false);
      }
    },
    [appendAppLog]
  );

  useEffect(() => {
    void fetchConversionHistory(true);
  }, [fetchConversionHistory]);

  useEffect(() => {
    if (activePage === 'mtv-history') {
      void fetchConversionHistory(true);
    }
  }, [activePage, fetchConversionHistory]);

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

  const markGptsSending = useCallback((key: string, value: boolean) => {
    setGptsSending((prev) => {
      if (value) {
        return { ...prev, [key]: true };
      }
      if (!prev[key]) {
        return prev;
      }
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const getNextTabTitle = useCallback(() => 'タブ', []);

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

  const handleSendToGPTs = useCallback(
    async ({ transcript, contextKey, logTabId }: { transcript: string; contextKey: string; logTabId?: string | null }) => {
      const trimmed = transcript?.trim();
      if (!trimmed) {
        if (logTabId) {
          appendTabLog(logTabId, 'GPTsに送信できる文字起こしがありません。', 'error');
        } else {
          appendAppLog('GPTsに送信できる文字起こしがありません。', 'error');
        }
        return;
      }
      if (!window.revoice?.copyToClipboard || !window.revoice?.openExternal) {
        if (logTabId) {
          appendTabLog(logTabId, 'GPTs連携はこのビルドでは利用できません。', 'error');
        } else {
          appendAppLog('GPTs連携はこのビルドでは利用できません。', 'error');
        }
        return;
      }
      markGptsSending(contextKey, true);
      try {
        const copyResult = await window.revoice.copyToClipboard(trimmed);
        if (!copyResult?.ok) {
          throw new Error(copyResult?.error ?? 'copy failed');
        }
        if (logTabId) {
          appendTabLog(logTabId, '[SYSTEM] GPTs用に文字起こしをコピーしました。', 'info');
        } else {
          appendAppLog('[SYSTEM] GPTs用に文字起こしをコピーしました。', 'info');
        }
        const openResult = await window.revoice.openExternal(GPTS_URL);
        if (!openResult?.ok) {
          throw new Error(openResult?.error ?? 'open failed');
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (logTabId) {
          appendTabLog(logTabId, `[ERROR] GPTs連携に失敗しました: ${message}`, 'error');
        } else {
          appendAppLog(`[ERROR] GPTs連携に失敗しました: ${message}`, 'error');
        }
      } finally {
        markGptsSending(contextKey, false);
      }
    },
    [appendAppLog, appendTabLog, markGptsSending]
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
            const normalized = looksLikeConversionJob(job) ? normalizeConversionJobSummary(job) : job;
            jobMap.set(job.id, normalized);
          }
        } else if (!jobResponse.ok && jobResponse.error) {
          appendAppLog(`[WARN] ジョブ一覧の取得に失敗しました: ${jobResponse.error}`, 'error');
        }
        jobMapRef.current = jobMap;
        conversionJobMapRef.current = new Map(
          Array.from(conversionJobMapRef.current.entries()).filter(([id]) => {
            const mapped = jobMap.get(id);
            return looksLikeConversionJob(mapped);
          })
        );
        jobMap.forEach((job) => {
          if (!looksLikeConversionJob(job)) return;
          const existing = conversionJobMapRef.current.get(job.id) ?? null;
          const state = buildConversionJobState(job, existing);
          conversionJobMapRef.current.set(state.job.id, state);
        });
        syncConversionJobs();

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
        const normalizedJob = looksLikeConversionJob(job) ? normalizeConversionJobSummary(job) : job;
        jobMapRef.current.set(normalizedJob.id, normalizedJob);
        ensureTabForJob(normalizedJob);
        if (looksLikeConversionJob(normalizedJob)) {
          upsertConversionJob(normalizedJob);
          if (normalizedJob.status === 'completed' || normalizedJob.status === 'failed' || normalizedJob.status === 'cancelled') {
            void fetchConversionHistory(true);
          }
        } else if (typeof (normalizedJob.metadata as Record<string, unknown> | undefined)?.sourceConversionJobId === 'string') {
          const conversionId = (normalizedJob.metadata as Record<string, unknown>).sourceConversionJobId as string;
          if (conversionJobMapRef.current.has(conversionId)) {
            refreshConversionLinkage(conversionId);
          }
        }
        if (normalizedJob.tabId) {
          patchTab(normalizedJob.tabId, (tab) => mergeJobIntoTab(tab, normalizedJob), normalizedJob);
        }
      } else if (event.kind === 'log') {
        const job = jobMapRef.current.get(event.jobId);
        if (looksLikeConversionJob(job)) {
          appendConversionLog(event.jobId, event.message, event.level);
        } else {
          const tabId = job?.tabId;
          if (tabId) {
            appendTabLog(tabId, event.message, event.level);
          }
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
  }, [
    appendAppLog,
    appendTabLog,
    appendConversionLog,
    ensureActiveTab,
    ensureTabForJob,
    fetchConversionHistory,
    looksLikeConversionJob,
    buildConversionJobState,
    normalizeConversionJobSummary,
    patchTab,
    refreshConversionLinkage,
    syncConversionJobs,
    upsertConversionJob,
  ]);

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
    let cancelled = false;

    const fallbackSettings: ConversionSettings = {
      outputDir: null,
      defaultPreset: {
        format: 'aac',
        bitrateKbps: 128,
        sampleRate: 16000,
        channels: 1,
      },
      maxParallelJobs: 2,
      autoCreateTranscribeTab: false,
      ffmpegPath: null,
    };

    const loadConversionSettings = async () => {
      if (!window.revoice?.getConversionSettings) {
        if (!cancelled) {
          setConversionSettings(fallbackSettings);
          setConversionForm(toConversionFormState(fallbackSettings));
          setConversionSettingsDirty(false);
        }
        return;
      }
      try {
        const response = await window.revoice.getConversionSettings();
        if (cancelled) return;
        if (response?.ok && response.settings) {
          setConversionSettings(response.settings);
          setConversionForm(toConversionFormState(response.settings));
          setConversionSettingsDirty(false);
          setConversionSettingsErrors([]);
        } else {
          if (response?.error) {
            appendAppLog(`[WARN] 変換設定の取得に失敗しました: ${response.error}`, 'error');
          }
          setConversionSettings(fallbackSettings);
          setConversionForm(toConversionFormState(fallbackSettings));
          setConversionSettingsDirty(false);
        }
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          appendAppLog(`[WARN] 変換設定の取得中にエラーが発生しました: ${message}`, 'error');
          setConversionSettings(fallbackSettings);
          setConversionForm(toConversionFormState(fallbackSettings));
          setConversionSettingsDirty(false);
        }
      }
    };

    void loadConversionSettings();

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

  const markConversionSettingsDirty = useCallback(() => {
    setConversionSettingsDirty(true);
    setConversionSettingsErrors([]);
    setConversionSettingsSuccess(null);
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

  const handleConversionPresetKeyChange = useCallback(
    (key: ConversionPresetKey) => {
      let changed = false;
      setConversionForm((prev) => {
        if (prev.presetKey === key) return prev;
        changed = true;
        if (key === 'custom') {
          return { ...prev, presetKey: key };
        }
        const option = CONVERSION_PRESET_OPTIONS.find((presetOption) => presetOption.key === key);
        if (option?.preset) {
          return {
            ...prev,
            presetKey: key,
            format: option.preset.format,
            bitrateKbps: String(option.preset.bitrateKbps),
            sampleRate: String(option.preset.sampleRate),
            channels: String(option.preset.channels),
          };
        }
        return { ...prev, presetKey: key };
      });
      if (changed) {
        markConversionSettingsDirty();
      }
    },
    [markConversionSettingsDirty]
  );

  const handleConversionFormatChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const value = event.target.value as ConversionSettingsForm['format'];
      let changed = false;
      setConversionForm((prev) => {
        if (prev.format === value && prev.presetKey === 'custom') return prev;
        changed = true;
        return { ...prev, presetKey: 'custom', format: value };
      });
      if (changed) {
        markConversionSettingsDirty();
      }
    },
    [markConversionSettingsDirty]
  );

  const handleConversionSampleRateChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const value = event.target.value;
      let changed = false;
      setConversionForm((prev) => {
        if (prev.sampleRate === value && prev.presetKey === 'custom') return prev;
        changed = true;
        return { ...prev, presetKey: 'custom', sampleRate: value };
      });
      if (changed) {
        markConversionSettingsDirty();
      }
    },
    [markConversionSettingsDirty]
  );

  const handleConversionChannelsChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const value = event.target.value;
      let changed = false;
      setConversionForm((prev) => {
        if (prev.channels === value && prev.presetKey === 'custom') return prev;
        changed = true;
        return { ...prev, presetKey: 'custom', channels: value };
      });
      if (changed) {
        markConversionSettingsDirty();
      }
    },
    [markConversionSettingsDirty]
  );

  const handleConversionBitrateChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const value = event.target.value;
      let changed = false;
      setConversionForm((prev) => {
        if (prev.bitrateKbps === value && prev.presetKey === 'custom') return prev;
        changed = true;
        return { ...prev, presetKey: 'custom', bitrateKbps: value };
      });
      if (changed) {
        markConversionSettingsDirty();
      }
    },
    [markConversionSettingsDirty]
  );

  const handleConversionMaxParallelChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const raw = event.target.value;
      setConversionForm((prev) => {
        if (prev.maxParallelJobs === raw) return prev;
        markConversionSettingsDirty();
        return { ...prev, maxParallelJobs: raw };
      });
    },
    [markConversionSettingsDirty]
  );

  const handleConversionAutoToggle = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const value = event.target.checked;
      setConversionForm((prev) => {
        if (prev.autoCreateTranscribeTab === value) return prev;
        markConversionSettingsDirty();
        return { ...prev, autoCreateTranscribeTab: value };
      });
    },
    [markConversionSettingsDirty]
  );

  const handleConversionFfmpegPathChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value;
      setConversionForm((prev) => {
        if (prev.ffmpegPath === value) return prev;
        markConversionSettingsDirty();
        return { ...prev, ffmpegPath: value };
      });
    },
    [markConversionSettingsDirty]
  );

  const handleConversionSelectOutputDir = useCallback(async () => {
    if (!window.revoice?.openFileDialog) {
      appendAppLog('このビルドではフォルダ選択に対応していません。', 'error');
      return;
    }
    try {
      const result = await window.revoice.openFileDialog({
        allowMultiple: false,
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: conversionForm.outputDir.trim().length > 0 ? conversionForm.outputDir.trim() : undefined,
      });
      const selectedPath = Array.isArray(result) ? result?.[0] : result;
      if (!selectedPath) return;
      let changed = false;
      setConversionForm((prev) => {
        if (prev.outputDir === selectedPath) return prev;
        changed = true;
        return { ...prev, outputDir: selectedPath };
      });
      if (changed) {
        markConversionSettingsDirty();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendAppLog(`[WARN] 出力先フォルダの選択に失敗しました: ${message}`, 'error');
    }
  }, [appendAppLog, conversionForm.outputDir, markConversionSettingsDirty]);

  const handleConversionClearOutputDir = useCallback(() => {
    let changed = false;
    setConversionForm((prev) => {
      if (prev.outputDir === '') return prev;
      changed = true;
      return { ...prev, outputDir: '' };
    });
    if (changed) {
      markConversionSettingsDirty();
    }
  }, [markConversionSettingsDirty]);

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

  const validateConversionForm = useCallback(() => {
    const errors: string[] = [];
    const sampleRate = conversionPreset.sampleRate;
    if (!CONVERSION_SAMPLE_RATE_OPTIONS.includes(sampleRate as (typeof CONVERSION_SAMPLE_RATE_OPTIONS)[number])) {
      errors.push('サンプリングレートの選択が不正です。');
    }
    const channels = conversionPreset.channels;
    if (!CONVERSION_CHANNEL_OPTIONS.includes(channels as (typeof CONVERSION_CHANNEL_OPTIONS)[number])) {
      errors.push('チャンネル数の選択が不正です。');
    }
    if (conversionRequiresBitrate) {
      const bitrate = conversionPreset.bitrateKbps;
      if (!CONVERSION_BITRATE_OPTIONS.includes(bitrate as (typeof CONVERSION_BITRATE_OPTIONS)[number])) {
        errors.push('ビットレートの選択が不正です。');
      }
    }
    const maxParallel = Number(conversionForm.maxParallelJobs);
    if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 8) {
      errors.push('同時変換数は1〜8の範囲で指定してください。');
    }
    return errors;
  }, [conversionForm.maxParallelJobs, conversionPreset, conversionRequiresBitrate]);

  const handleConversionSettingsSave = useCallback(async () => {
    if (!window.revoice?.setConversionSettings) {
      setConversionSettingsErrors(['このビルドでは変換設定の保存に対応していません。']);
      return;
    }
    const errors = validateConversionForm();
    if (errors.length > 0) {
      setConversionSettingsErrors(errors);
      return;
    }
    const trimmedOutput = conversionForm.outputDir.trim();
    const trimmedFfmpeg = conversionForm.ffmpegPath.trim();
    const payload: ConversionSettings = {
      outputDir: trimmedOutput.length > 0 ? trimmedOutput : null,
      defaultPreset: {
        format: conversionPreset.format,
        bitrateKbps: conversionPreset.bitrateKbps,
        sampleRate: conversionPreset.sampleRate,
        channels: conversionPreset.channels,
      },
      maxParallelJobs: Math.max(1, Math.min(8, Number(conversionForm.maxParallelJobs) || 2)),
      autoCreateTranscribeTab: conversionForm.autoCreateTranscribeTab,
      ffmpegPath: trimmedFfmpeg.length > 0 ? trimmedFfmpeg : null,
    };

    setConversionSettingsSaving(true);
    try {
      const response = await window.revoice.setConversionSettings(payload);
      if (response?.ok && response.settings) {
        setConversionSettings(response.settings);
        setConversionForm(toConversionFormState(response.settings));
        setConversionSettingsDirty(false);
        setConversionSettingsErrors([]);
        setConversionSettingsSuccess('保存しました');
      } else if (response?.error) {
        setConversionSettingsErrors([response.error]);
        appendAppLog(`[WARN] 変換設定の保存に失敗しました: ${response.error}`, 'error');
      } else {
        setConversionSettings(payload);
        setConversionForm(toConversionFormState(payload));
        setConversionSettingsDirty(false);
        setConversionSettingsErrors([]);
        setConversionSettingsSuccess('保存しました');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setConversionSettingsErrors([`変換設定の保存に失敗しました: ${message}`]);
      appendAppLog(`[WARN] 変換設定の保存中にエラーが発生しました: ${message}`, 'error');
    } finally {
      setConversionSettingsSaving(false);
    }
  }, [appendAppLog, conversionForm, conversionPreset, validateConversionForm]);

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
    if (!conversionSettingsSuccess) return;
    const timer = window.setTimeout(() => setConversionSettingsSuccess(null), 4000);
    return () => window.clearTimeout(timer);
  }, [conversionSettingsSuccess]);

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
      const tabTitle = titleFromPath(filePath, 10);
      patchTab(activeTabId, (tab) => ({
        ...tab,
        inputPath: filePath,
        outputPath: null,
        transcript: '',
        logs: [],
        errorMessage: null,
        title: tabTitle,
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
          const inputPath = Array.isArray(selected) ? selected[0] : selected;
          patchTab(activeTabId, (tab) => ({
            ...tab,
            inputPath,
            outputPath: null,
            transcript: '',
            logs: [],
            errorMessage: null,
            title: titleFromPath(inputPath, 10),
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

    const derivedTitle = tab.title && tab.title !== 'タブ' ? tab.title : titleFromPath(tab.inputPath, 10);
    patchTab(tab.id, (current) => ({ ...current, title: derivedTitle }));

    const payload: TranscriptionJobPayload = {
      inputPath: tab.inputPath,
      tabId: tab.id,
      tabTitle: derivedTitle,
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
        patchTab(tab.id, (current) => mergeJobIntoTab(current, response.job!), response.job);
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
      processingMs: null,
      transcriptCharCount: null,
      sourceConversionJobId: null,
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

  const extractPathsFromFileList = useCallback((files: FileList) => {
    return Array.from(files)
      .map((file) => (file as unknown as { path?: string }).path)
      .filter((value): value is string => Boolean(value && value.trim().length > 0));
  }, []);

  const handleEnqueueConversions = useCallback(
    async (paths: string[]) => {
      const unique = Array.from(new Set(paths.map((path) => path.trim()).filter((path) => path.length > 0)));
      if (unique.length === 0) {
        appendAppLog('ファイルパスを取得できませんでした。ドラッグ＆ドロップではなく「ファイルを選ぶ」を利用してください。', 'error');
        return;
      }
      if (!window.revoice?.enqueueConversion) {
        appendAppLog('このビルドでは動画→音声変換機能が利用できません。', 'error');
        return;
      }
      setConversionEnqueueing(true);
      try {
        const presetLabel = conversionPresetOption?.label ?? 'カスタム';
        const presetKey = conversionForm.presetKey;
        const presetSummaryForPayload = conversionPresetOption && conversionPresetOption.key !== 'custom'
          ? conversionPresetOption.description
          : conversionPresetSummary;
        const payloads = unique.map((inputPath) => ({
          inputPath,
          preset: {
            format: conversionPreset.format,
            bitrateKbps: conversionPreset.bitrateKbps,
            sampleRate: conversionPreset.sampleRate,
            channels: conversionPreset.channels,
          },
          outputDir: conversionForm.outputDir.trim() ? conversionForm.outputDir.trim() : undefined,
          autoTranscribe: conversionForm.autoCreateTranscribeTab,
          tabTitle: titleFromPath(inputPath, 10),
          presetKey,
          presetLabel,
          presetSummary: presetSummaryForPayload,
        }));
        const response = await window.revoice.enqueueConversion(payloads);
        if (!response?.ok) {
          appendAppLog(`[WARN] 変換ジョブの登録に失敗しました: ${response?.error ?? '不明なエラー'}`, 'error');
          return;
        }
        const created = response.jobs ?? (response.job ? [response.job] : []);
        created?.forEach((job) => {
          if (!job) return;
          const normalizedJob = looksLikeConversionJob(job) ? normalizeConversionJobSummary(job) : job;
          jobMapRef.current.set(normalizedJob.id, normalizedJob);
          upsertConversionJob(normalizedJob);
        });
        appendAppLog(`${created?.length ?? 0}件の変換ジョブをキューに追加しました。`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        appendAppLog(`[WARN] 変換ジョブの登録中にエラーが発生しました: ${message}`, 'error');
      } finally {
        setConversionEnqueueing(false);
      }
    },
    [
      appendAppLog,
      conversionForm.autoCreateTranscribeTab,
      conversionForm.outputDir,
      conversionForm.presetKey,
      conversionPreset,
      conversionPresetOption,
      conversionPresetSummary,
      upsertConversionJob,
    ]
  );

  const handleConversionBrowse = useCallback(async () => {
    try {
      if (!window.revoice?.openFileDialog) {
        appendAppLog('このビルドではファイル選択に対応していません。', 'error');
        return;
      }
      const result = await window.revoice.openFileDialog({
        allowMultiple: true,
        filters: [
          { name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm'] },
          { name: 'Media', extensions: ['mp3', 'm4a', 'aac', 'flac', 'ogg', 'wav'] },
        ],
      });
      if (!result) return;
      const paths = Array.isArray(result) ? result : [result];
      await handleEnqueueConversions(paths);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendAppLog(`[WARN] ファイル選択に失敗しました: ${message}`, 'error');
    }
  }, [appendAppLog, handleEnqueueConversions]);

  const handleConversionDragEnter = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    conversionDragCounterRef.current += 1;
    setConversionDragActive(true);
  }, []);

  const handleConversionDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleConversionDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    conversionDragCounterRef.current = Math.max(0, conversionDragCounterRef.current - 1);
    if (conversionDragCounterRef.current === 0) {
      setConversionDragActive(false);
    }
  }, []);

  const handleConversionDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      conversionDragCounterRef.current = 0;
      setConversionDragActive(false);
      const files = event.dataTransfer?.files;
      if (!files || files.length === 0) return;
      const paths = extractPathsFromFileList(files);
      if (paths.length === 0) {
        appendAppLog('ドラッグしたファイルのパスを取得できませんでした。ファイル選択ボタンを利用してください。', 'error');
        return;
      }
      void handleEnqueueConversions(paths);
    },
    [appendAppLog, extractPathsFromFileList, handleEnqueueConversions]
  );

  const handleCancelConversionJob = useCallback(
    async (job: JobSummary) => {
      if (!window.revoice?.cancelConversionJob) {
        appendAppLog('このビルドでは変換ジョブのキャンセルに対応していません。', 'error');
        return;
      }
      try {
        const response = await window.revoice.cancelConversionJob(job.id);
        if (response?.ok) {
          appendAppLog(`変換ジョブをキャンセルしました: ${fileNameFromPath(job.inputPath ?? job.id)}`);
        } else {
          appendAppLog(`[WARN] 変換ジョブのキャンセルに失敗しました: ${response?.error ?? '不明なエラー'}`, 'error');
        }
      } catch (err) {
        appendAppLog(`[WARN] 変換ジョブのキャンセルでエラーが発生しました: ${err}`, 'error');
      }
    },
    [appendAppLog]
  );

  const handleCopyConversionOutput = useCallback(
    (job: JobSummary) => {
      if (!job.outputPath) return;
      handleCopyText(job.outputPath, '変換後ファイルのパスをコピーしました。');
    },
    [handleCopyText]
  );

  const handleSendConversionToTranscription = useCallback(
    async (job: JobSummary) => {
      if (!job.outputPath) {
        appendAppLog('変換後ファイルが見つかりません。', 'error');
        return;
      }
      if (!window.revoice?.enqueueJob) {
        appendAppLog('このビルドでは文字起こしジョブの作成に対応していません。', 'error');
        return;
      }
      try {
        const response = await window.revoice.enqueueJob({
          inputPath: job.outputPath,
          tabTitle: titleFromPath(job.outputPath, 10),
          sourceConversionJobId: job.id,
        });
        if (response?.ok && response.job) {
          appendAppLog('変換結果を文字起こしタブに送信しました。');
          jobMapRef.current.set(response.job.id, response.job);
          ensureTabForJob(response.job);
          if (response.job.tabId) {
            setActiveTabId(response.job.tabId);
          patchTab(response.job.tabId, (tab) => mergeJobIntoTab(tab, response.job!), response.job);
          }
          window.revoice.linkConversionTranscription?.(job.id, response.job.id).catch(() => {
            /* ignore */
          });
        } else {
          appendAppLog(`[WARN] 文字起こしジョブの作成に失敗しました: ${response?.error ?? '不明なエラー'}`, 'error');
        }
      } catch (err) {
        appendAppLog(`[WARN] 文字起こしジョブの作成でエラーが発生しました: ${err}`, 'error');
      }
    },
    [appendAppLog, ensureTabForJob, mergeJobIntoTab, patchTab]
  );

  const handleSelectConversionHistory = useCallback((jobId: string) => {
    setSelectedConversionHistoryId(jobId);
  }, []);

  const handleSendConversionHistoryToTranscription = useCallback(
    async (job: JobSummary) => {
      if (!job.outputPath) {
        appendAppLog('変換後ファイルが見つかりません。', 'error');
        return;
      }
      if (!window.revoice?.enqueueJob) {
        appendAppLog('このビルドでは文字起こしジョブの作成に対応していません。', 'error');
        return;
      }
      try {
        const response = await window.revoice.enqueueJob({
          inputPath: job.outputPath,
          tabTitle: titleFromPath(job.outputPath, 10),
          sourceConversionJobId: job.id,
        });
        if (response?.ok && response.job) {
          appendAppLog('変換履歴から文字起こしジョブを作成しました。');
          jobMapRef.current.set(response.job.id, response.job);
          ensureTabForJob(response.job);
          if (response.job.tabId) {
            setActiveTabId(response.job.tabId);
          patchTab(response.job.tabId, (tab) => mergeJobIntoTab(tab, response.job!), response.job);
          }
          window.revoice.linkConversionTranscription?.(job.id, response.job.id).catch(() => {
            /* ignore */
          });
        } else {
          appendAppLog(`[WARN] 文字起こしジョブの作成に失敗しました: ${response?.error ?? '不明なエラー'}`, 'error');
        }
      } catch (err) {
        appendAppLog(`[WARN] 文字起こしジョブの作成でエラーが発生しました: ${err}`, 'error');
      }
    },
    [appendAppLog, ensureTabForJob, mergeJobIntoTab, patchTab]
  );

  const handleCopyConversionHistoryPath = useCallback(
    (job: JobSummary) => {
      if (!job.outputPath) return;
      handleCopyText(job.outputPath, '変換済みファイルのパスをコピーしました。');
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

  useEffect(() => {
    if (tabsLoading) return;
    if (initialTabEnsuredRef.current) return;
    initialTabEnsuredRef.current = true;
    if (tabsRef.current.length === 0) {
      void handleAddTab();
    }
  }, [handleAddTab, tabsLoading]);

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
          let shouldCreateFallbackTab = false;
          setTabs((prev) => {
            const next = prev.filter((tab) => tab.id !== tabId);
            if (next.length !== prev.length) {
              setActiveTabId((prevActive) => (prevActive === tabId ? next[0]?.id ?? null : prevActive));
            }
            if (next.length === 0) {
              shouldCreateFallbackTab = true;
            }
            return next;
          });
          if (shouldCreateFallbackTab) {
            await handleAddTab();
          }
        } else if (response?.error) {
          appendAppLog(`タブの削除に失敗しました: ${response.error}`, 'error');
        }
      } catch (err) {
        appendAppLog(`タブの削除でエラーが発生しました: ${err}`, 'error');
      }
    },
    [appendAppLog, handleAddTab]
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
          {activeTab?.processingMs && activeTab.processingMs > 0 && (
            <span>処理時間: {formatDurationMs(activeTab.processingMs)}</span>
          )}
          {activeTab?.transcriptCharCount !== null && activeTab?.transcriptCharCount !== undefined && activeTab.transcriptCharCount >= 0 && (
            <span>文字数: {activeTab.transcriptCharCount.toLocaleString('ja-JP')}</span>
          )}
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
            <button
              type="button"
              className="button button--ghost button--small"
              onClick={() => {
                if (activeTab) {
                  void handleSendToGPTs({ transcript: activeTab.transcript, contextKey: `tab:${activeTab.id}`, logTabId: activeTab.id });
                }
              }}
              disabled={!activeTab || !activeTab.transcript || activeTabGptsSending}
            >
              {activeTabGptsSending ? 'GPTs起動中…' : 'GPTsで開く'}
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
                        if (selectedHistory?.transcript) {
                          void handleSendToGPTs({
                            transcript: selectedHistory.transcript,
                            contextKey: `history:${selectedHistory.id}`,
                            logTabId: activeTab?.id ?? null,
                          });
                        }
                      }}
                      disabled={historyGptsSending || !selectedHistory?.transcript}
                    >
                      {historyGptsSending ? <span className="icon-button__glyph" aria-hidden="true">…</span> : <IconLaunch aria-hidden="true" />}
                      <span className="sr-only">GPTsで開く</span>
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
                <div className="history-detail__stats">
                  <span>処理時間: {formatDurationMs(selectedHistory.processingMs ?? null)}</span>
                  <span>文字数: {selectedHistory.transcriptCharCount !== null && selectedHistory.transcriptCharCount !== undefined ? selectedHistory.transcriptCharCount.toLocaleString('ja-JP') : '—'}</span>
                </div>
                {selectedHistory.status === 'failed' && selectedHistory.errorMessage ? (
                  <div className="history-detail__error">エラー: {selectedHistory.errorMessage}</div>
                ) : null}
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

  const conversionSettingsPanel = (
    <section className="panel convert-settings">
      <header className="panel__header">
        <h2>変換プリセットと設定</h2>
        <div className="panel__tools">
          <span className="convert-settings__summary">最大 {conversionForm.maxParallelJobs} 件を同時に変換</span>
        </div>
      </header>
      <form
        className="convert-settings__form"
        onSubmit={(event) => {
          event.preventDefault();
          void handleConversionSettingsSave();
        }}
      >
        <div className="convert-presets" role="radiogroup" aria-label="変換プリセット">
          {CONVERSION_PRESET_OPTIONS.map((option) => {
            const active = conversionForm.presetKey === option.key;
            return (
              <label key={option.key} className={`convert-presets__item ${active ? 'convert-presets__item--active' : ''}`}>
                <input
                  type="radio"
                  name="conversion-preset"
                  value={option.key}
                  checked={active}
                  onChange={() => handleConversionPresetKeyChange(option.key)}
                />
                <div className="convert-presets__content">
                  <span className="convert-presets__label">{option.label}</span>
                  <span className="convert-presets__description">{option.description}</span>
                </div>
              </label>
            );
          })}
        </div>

        {conversionForm.presetKey === 'custom' && (
          <div className="convert-settings__advanced">
            <div className="convert-settings__grid">
              <label className="convert-settings__field">
                <span className="convert-settings__label">フォーマット</span>
                <select className="convert-settings__select" value={conversionForm.format} onChange={handleConversionFormatChange}>
                  {Object.entries(CONVERSION_FORMAT_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="convert-settings__field">
                <span className="convert-settings__label">サンプリングレート</span>
                <select className="convert-settings__select" value={conversionForm.sampleRate} onChange={handleConversionSampleRateChange}>
                  {CONVERSION_SAMPLE_RATE_OPTIONS.map((value) => (
                    <option key={value} value={value}>{`${Math.round(value / 1000)}kHz`}</option>
                  ))}
                </select>
              </label>
              <label className="convert-settings__field">
                <span className="convert-settings__label">チャンネル</span>
                <select className="convert-settings__select" value={conversionForm.channels} onChange={handleConversionChannelsChange}>
                  {CONVERSION_CHANNEL_OPTIONS.map((value) => (
                    <option key={value} value={value}>{value === 1 ? 'モノラル' : 'ステレオ'}</option>
                  ))}
                </select>
              </label>
              <label className="convert-settings__field">
                <span className="convert-settings__label">ビットレート</span>
                <select
                  className="convert-settings__select"
                  value={conversionForm.bitrateKbps}
                  onChange={handleConversionBitrateChange}
                  disabled={!conversionRequiresBitrate}
                >
                  {CONVERSION_BITRATE_OPTIONS.map((value) => (
                    <option key={value} value={value}>{`${value}kbps`}</option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        )}

        <div className="convert-settings__field convert-settings__field--path">
          <span className="convert-settings__label">出力先</span>
          <div className="convert-settings__path">
            <span className="convert-settings__path-text">
              {conversionForm.outputDir.trim().length > 0 ? conversionForm.outputDir : 'ダウンロードフォルダ（既定）'}
            </span>
            <div className="convert-settings__path-actions">
              <button type="button" className="button button--ghost" onClick={handleConversionSelectOutputDir}>
                フォルダを選ぶ
              </button>
              {conversionForm.outputDir.trim().length > 0 && (
                <button type="button" className="button button--ghost" onClick={handleConversionClearOutputDir}>
                  クリア
                </button>
              )}
            </div>
          </div>
        </div>

        <label className="convert-settings__field convert-settings__field--checkbox">
          <input type="checkbox" checked={conversionForm.autoCreateTranscribeTab} onChange={handleConversionAutoToggle} />
          <span>変換完了後に自動で文字起こしタブを作成する</span>
        </label>

        <label className="convert-settings__field convert-settings__field--compact">
          <span className="convert-settings__label">同時変換数</span>
          <div className="convert-settings__parallel">
            <input
              type="range"
              min={1}
              max={8}
              value={conversionForm.maxParallelJobs}
              onChange={handleConversionMaxParallelChange}
            />
            <span className="convert-settings__parallel-value">{conversionForm.maxParallelJobs}</span>
          </div>
        </label>

        <label className="convert-settings__field">
          <span className="convert-settings__label">FFmpeg パス (任意)</span>
          <input
            type="text"
            className="convert-settings__input"
            value={conversionForm.ffmpegPath}
            onChange={handleConversionFfmpegPathChange}
            placeholder="システムPATHを利用する場合は空欄"
          />
        </label>

        {conversionSettingsErrors.length > 0 && (
          <ul className="convert-settings__errors">
            {conversionSettingsErrors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        )}
        {conversionSettingsSuccess && <div className="convert-settings__success">{conversionSettingsSuccess}</div>}

        <div className="convert-settings__actions">
          <button type="submit" className="button button--primary" disabled={conversionSettingsSaveDisabled}>
            {conversionSettingsSaving ? '保存中…' : '設定を保存'}
          </button>
        </div>
      </form>
    </section>
  );

  const renderConversion = (
    <div className="convert-page">
      <div className="convert-grid">
        <div className="convert-main">
          <section
            className={`panel convert-upload ${conversionDragActive ? 'convert-upload--active' : ''}`}
            onDragEnter={handleConversionDragEnter}
            onDragOver={handleConversionDragOver}
            onDragLeave={handleConversionDragLeave}
            onDrop={handleConversionDrop}
          >
            <header className="panel__header">
              <h2>ファイルを追加</h2>
              <div className="panel__tools">
                <span className="convert-upload__preset">{conversionPresetSummary}</span>
              </div>
            </header>
            <div className="convert-upload__body">
              <div className="convert-upload__zone">
                <p className="convert-upload__lead">動画ファイルをここにドラッグ＆ドロップ</p>
                <p className="convert-upload__sub">または</p>
                <button
                  type="button"
                  className="button button--primary"
                  onClick={handleConversionBrowse}
                  disabled={conversionEnqueueing}
                >
                  ファイルを選ぶ
                </button>
              </div>
              <div className="convert-upload__meta">
                <p>出力先: {conversionForm.outputDir.trim().length > 0 ? conversionForm.outputDir.trim() : 'ダウンロードフォルダ（既定）'}</p>
                <p>完了後に自動で文字起こしタブを作成: {conversionForm.autoCreateTranscribeTab ? 'はい' : 'いいえ'}</p>
              </div>
            </div>
          </section>

          <section className="panel convert-active">
            <header className="panel__header">
              <h2>進行中のジョブ</h2>
              <div className="panel__tools">
                <span className="convert-jobs__count">{activeConversionEntries.length}件</span>
              </div>
            </header>
            {activeConversionEntries.length === 0 ? (
              <div className="convert-jobs__empty">現在進行中のジョブはありません。</div>
            ) : (
              <ul className="convert-jobs__items">
                {activeConversionEntries.map(({ job, linkedJob }) => {
                  const statusLabel = TAB_STATUS_LABEL[job.status];
                  const progress = typeof job.progress === 'number' ? Math.max(0, Math.min(100, Math.floor(job.progress))) : null;
                  const rawTitle = fileNameFromPath(job.inputPath ?? ((job.metadata as Record<string, unknown>)?.sourceInputPath as string | undefined) ?? job.id);
                  const displayTitle = truncateLabel(rawTitle, 24);
                  const linkedProgress = linkedJob && typeof linkedJob.progress === 'number' ? Math.max(0, Math.min(100, linkedJob.progress)) : null;
                  const linkedStatus = linkedJob ? TAB_STATUS_LABEL[linkedJob.status] : null;
                  return (
                    <li key={job.id} className="convert-jobs__item">
                      <div className="convert-jobs__select convert-jobs__select--static">
                        <div className="convert-jobs__title">{displayTitle}</div>
                        <div className="convert-jobs__meta">
                          <span className={`convert-jobs__status convert-jobs__status--${job.status}`}>{statusLabel}</span>
                          {job.queuePosition && job.status === 'queued' ? <span className="convert-jobs__queue">#{job.queuePosition}</span> : null}
                          {progress !== null && <span className="convert-jobs__progress-value">{progress}%</span>}
                        </div>
                          {progress !== null && (
                            <div className="convert-jobs__progress">
                              <div
                                className="convert-jobs__progress-bar"
                                style={{ '--progress-width': `${progress}%` } as CSSProperties}
                              />
                            </div>
                          )}
                          {linkedJob && (
                            <div className="convert-linked">
                              <span className="convert-linked__label">文字起こし: {linkedStatus}</span>
                              {linkedProgress !== null && (
                                <div className="convert-linked__progress">
                                  <div className="convert-linked__progress-track">
                                    <div
                                      className="convert-linked__progress-fill"
                                      style={{ '--progress-width': `${linkedProgress}%` } as CSSProperties}
                                    />
                                  </div>
                                  <span className="convert-linked__value">{linkedProgress.toFixed(1)}%</span>
                                </div>
                              )}
                            </div>
                        )}
                      </div>
                      <button type="button" className="convert-jobs__action" onClick={() => handleCancelConversionJob(job)}>
                        キャンセル
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="panel convert-recent">
            <header className="panel__header">
              <h2>最近の完了</h2>
              <div className="panel__tools">
                <span className="convert-jobs__count">{recentConversionEntries.length}件</span>
              </div>
            </header>
            {recentConversionEntries.length === 0 ? (
              <div className="convert-jobs__empty">最近完了したジョブはありません。</div>
            ) : (
              <ul className="convert-recent__items">
                {recentConversionEntries.map(({ job }) => {
                  const metadata = (job.metadata ?? {}) as Record<string, unknown>;
                  const durationSec = typeof metadata.durationSec === 'number' ? metadata.durationSec : null;
                  const outputBytes = typeof metadata.outputBytes === 'number' ? metadata.outputBytes : null;
                  const processingMs = typeof metadata.processingMs === 'number' ? metadata.processingMs : null;
                  const sourceBytes = typeof metadata.sourceBytes === 'number' ? metadata.sourceBytes : null;
                  const savedPercent = typeof metadata.compressionSavedPercent === 'number' ? metadata.compressionSavedPercent : null;
                  const presetSummary = typeof metadata.presetSummary === 'string' ? metadata.presetSummary : conversionPresetSummary;
                  const presetLabel = typeof metadata.presetLabel === 'string' ? metadata.presetLabel : 'カスタム設定';
                  const title = truncateLabel(fileNameFromPath(job.outputPath ?? job.inputPath ?? job.id), 24);
                  return (
                    <li key={job.id} className="convert-recent__item">
                      <div className="convert-recent__meta">
                        <div className="convert-recent__title">{title}</div>
                        <div className={`convert-recent__status convert-recent__status--${job.status}`}>{TAB_STATUS_LABEL[job.status]}</div>
                        <div className="convert-recent__preset">
                          <span className="convert-detail__preset-title">{presetLabel}</span>
                          <span className="convert-detail__preset-summary">{presetSummary}</span>
                        </div>
                        <div className="convert-recent__info">
                          <span>長さ: {formatSeconds(durationSec)}</span>
                          <span>処理時間: {formatDurationMs(processingMs)}</span>
                          <span>サイズ: {formatCompression(sourceBytes, outputBytes, savedPercent)}</span>
                        </div>
                      </div>
                      <div className="convert-recent__actions">
                        {job.outputPath && (
                          <button type="button" className="button button--primary" onClick={() => handleSendConversionToTranscription(job)}>
                            文字起こしに送る
                          </button>
                        )}
                        <button type="button" className="button button--ghost" onClick={() => handleCopyConversionOutput(job)} disabled={!job.outputPath}>
                          パスをコピー
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

        </div>

        {conversionSettingsPanel}
      </div>
    </div>
  );

  const renderConversionHistory = (
    <div className="conversion-history-page">
      <section className="panel conversion-history">
        <header className="panel__header">
          <h2>変換履歴</h2>
          <div className="panel__tools">
            <span className="conversion-history__count">{conversionHistoryTotal}件</span>
            {conversionHistoryHasMore && (
              <button
                type="button"
                className="button button--ghost button--small"
                onClick={() => void fetchConversionHistory(false)}
                disabled={conversionHistoryLoading}
              >
                {conversionHistoryLoading ? '読み込み中…' : 'さらに読み込む'}
              </button>
            )}
          </div>
        </header>
        <div className="conversion-history__body">
          <div className="conversion-history__list">
            {conversionHistory.length === 0 ? (
              <div className="conversion-history__empty">変換履歴はまだありません。</div>
            ) : (
              <ul>
                {conversionHistory.map((job) => {
                  const metadata = (job.metadata ?? {}) as Record<string, unknown>;
                  const durationSec = typeof metadata.durationSec === 'number' ? metadata.durationSec : null;
                  const outputBytes = typeof metadata.outputBytes === 'number' ? metadata.outputBytes : null;
                  const sourceBytes = typeof metadata.sourceBytes === 'number' ? metadata.sourceBytes : null;
                  const savedPercent = typeof metadata.compressionSavedPercent === 'number' ? metadata.compressionSavedPercent : null;
                  const processingMs = typeof metadata.processingMs === 'number' ? metadata.processingMs : null;
                  const title = fileNameFromPath(job.outputPath ?? job.inputPath ?? job.id);
                  const active = selectedConversionHistoryId === job.id;
                  return (
                    <li key={job.id}>
                      <button
                        type="button"
                        className={`conversion-history__item ${active ? 'conversion-history__item--active' : ''}`}
                        onClick={() => handleSelectConversionHistory(job.id)}
                      >
                        <span className="conversion-history__item-title">{title}</span>
                        <span className={`conversion-history__status conversion-history__status--${job.status}`}>
                          {TAB_STATUS_LABEL[job.status]}
                        </span>
                        <span className="conversion-history__time">
                          {job.finishedAt ? formatHistoryTime(job.finishedAt) : job.updatedAt ? formatHistoryTime(job.updatedAt) : '—'}
                        </span>
                        <span className="conversion-history__meta">{formatSeconds(durationSec)} ・ {formatDurationMs(processingMs)}</span>
                        <span className="conversion-history__meta">{formatCompression(sourceBytes, outputBytes, savedPercent)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <div className="conversion-history__detail">
            {selectedConversionHistoryJob ? (
              (() => {
                const job = selectedConversionHistoryJob;
                const metadata = (job.metadata ?? {}) as Record<string, unknown>;
                const presetLabel = typeof metadata.presetLabel === 'string' ? metadata.presetLabel : 'カスタム設定';
                const presetSummary = typeof metadata.presetSummary === 'string' ? metadata.presetSummary : conversionPresetSummary;
                const durationSec = typeof metadata.durationSec === 'number' ? metadata.durationSec : null;
                const outputBytes = typeof metadata.outputBytes === 'number' ? metadata.outputBytes : null;
                const sourceBytes = typeof metadata.sourceBytes === 'number' ? metadata.sourceBytes : null;
                const processingMs = typeof metadata.processingMs === 'number' ? metadata.processingMs : null;
                const savedPercent = typeof metadata.compressionSavedPercent === 'number' ? metadata.compressionSavedPercent : null;
                return (
                  <div className="conversion-history__detail-card">
                    <h3>{fileNameFromPath(job.outputPath ?? job.inputPath ?? job.id)}</h3>
                    <div className={`conversion-history__status-badge conversion-history__status-badge--${job.status}`}>
                      {TAB_STATUS_LABEL[job.status]}
                    </div>
                    <dl>
                      <div>
                        <dt>入力</dt>
                        <dd>{job.inputPath ?? '—'}</dd>
                      </div>
                      <div>
                        <dt>出力</dt>
                        <dd>
                          {job.outputPath ?? '—'}
                          {job.outputPath && (
                            <button type="button" className="link-button" onClick={() => handleCopyConversionHistoryPath(job)}>
                              コピー
                            </button>
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>プリセット</dt>
                        <dd>
                          <span className="convert-detail__preset-title">{presetLabel}</span>
                          <span className="convert-detail__preset-summary">{presetSummary}</span>
                        </dd>
                      </div>
                      <div>
                        <dt>推定長さ</dt>
                        <dd>{formatSeconds(durationSec)}</dd>
                      </div>
                      <div>
                        <dt>処理時間</dt>
                        <dd>{formatDurationMs(processingMs)}</dd>
                      </div>
                      <div>
                        <dt>サイズ</dt>
                        <dd>
                          {formatCompression(sourceBytes, outputBytes, savedPercent)}
                        </dd>
                      </div>
                    </dl>
                    <div className="conversion-history__actions">
                      {job.outputPath && (
                        <button type="button" className="button button--primary" onClick={() => handleSendConversionHistoryToTranscription(job)}>
                          文字起こしに送る
                        </button>
                      )}
                    </div>
                  </div>
                );
              })()
            ) : (
              <div className="conversion-history__empty-detail">左のリストから変換履歴を選択してください。</div>
            )}
          </div>
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
      case 'settings-vtt':
        return <div className="settings-view">{retentionSettingsPanel}</div>;
      case 'mtv-convert':
        return renderConversion;
      case 'mtv-history':
        return renderConversionHistory;
      case 'settings-mtv':
        return <div className="settings-view">{conversionSettingsPanel}</div>;
      case 'settings-logs':
        return renderLogs;
      default:
        return renderPlaceholder('準備中', '今後のアップデートをお待ちください。');
    }
  }, [activePage, conversionSettingsPanel, renderConversion, renderConversionHistory, renderHistory, renderLogs, renderTranscribe, retentionSettingsPanel]);

  const navGroups: {
    title: string;
    items: { key: typeof activePage; label: string }[];
  }[] = [
    {
      title: '動画音声→テキスト',
      items: [
        { key: 'vtt-transcribe', label: '文字起こし' },
        { key: 'vtt-history', label: '履歴' },
      ],
    },
    {
      title: '動画→音声',
      items: [
        { key: 'mtv-convert', label: '変換' },
        { key: 'mtv-history', label: '履歴' },
      ],
    },
    {
      title: 'Setting',
      items: [
        { key: 'settings-vtt', label: 'Voice to textの設定' },
        { key: 'settings-mtv', label: 'Movie to Voiceの設定' },
        { key: 'settings-logs', label: 'ログ' },
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
                  const badgeCount = item.key === 'vtt-transcribe'
                    ? transcriptionActiveCount
                    : item.key === 'mtv-convert'
                    ? conversionActiveCount
                    : 0;
                  return (
                    <li key={item.key}>
                      <button
                        type="button"
                        className={`sidebar__nav-button ${active ? 'sidebar__nav-button--active' : ''}`}
                        onClick={() => setActivePage(item.key)}
                        aria-current={active ? 'page' : undefined}
                      >
                        <span className={`sidebar__nav-marker ${active ? 'sidebar__nav-marker--active' : ''}`} />
                        <span className="sidebar__nav-label">
                          <span className="sidebar__nav-text">{item.label}</span>
                          {badgeCount > 0 && <span className="sidebar__nav-badge">{badgeCount}</span>}
                        </span>
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
                  case 'settings-vtt':
                    return 'Voice to textの設定';
                  case 'mtv-convert':
                    return 'Movie to Voice - 変換';
                  case 'mtv-history':
                    return 'Movie to Voice - 履歴';
                  case 'settings-mtv':
                    return 'Movie to Voiceの設定';
                  case 'settings-logs':
                    return 'ログ';
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
