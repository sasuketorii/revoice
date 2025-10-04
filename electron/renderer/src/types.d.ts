export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export type JobSummary = {
  id: string;
  tabId: string | null;
  status: JobStatus;
  type: string | null;
  inputPath: string | null;
  outputPath: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  progress: number | null;
  queuePosition: number | null;
  pid: number | null;
  error: string | null;
  transcript: string | null;
  params: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
};

export type JobEventMessage =
  | { kind: 'updated'; job: JobSummary }
  | { kind: 'log'; jobId: string; message: string; level: 'info' | 'error'; createdAt: string };

export type TabSummary = {
  id: string;
  title: string;
  jobId: string | null;
  state: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string | null;
  updatedAt: string | null;
  lastOpenedAt: string | null;
};

export type TranscriptionJobPayload = {
  inputPath: string;
  tabId: string;
  tabTitle?: string;
  outputDir?: string;
  model?: string;
  language?: string;
  beamSize?: number;
  computeType?: string;
  initialPrompt?: string;
  outputStyle?: 'timestamps' | 'plain';
  formats?: string;
  replace?: string;
  noVad?: boolean;
  minSegment?: number;
  preset?: string;
  memo?: boolean;
  sourceConversionJobId?: string;
};

export type HistoryRecord = {
  id: number;
  inputPath: string | null;
  outputPath: string | null;
  transcriptPreview: string | null;
  transcriptFull?: string | null;
  model: string | null;
  language: string | null;
  createdAt: string;
  duration: number | null;
  status: string | null;
  notes: string | null;
};

export type RetentionPolicySchedule = {
  type: 'interval' | 'startup';
  preset: '12h' | '24h' | 'startup' | null;
  intervalHours: number | null;
};

export type RetentionPolicy = {
  mode: 'recommended' | 'custom';
  maxDays: number | null;
  maxEntries: number | null;
  schedule: RetentionPolicySchedule;
};

export type ConversionPreset = {
  format: 'aac' | 'flac' | 'ogg' | 'wav';
  bitrateKbps: number;
  sampleRate: number;
  channels: number;
};

export type ConversionJobPayload = {
  inputPath: string;
  preset?: Partial<ConversionPreset>;
  outputDir?: string;
  autoTranscribe?: boolean;
  tabTitle?: string;
  presetKey?: string;
  presetLabel?: string;
  presetSummary?: string;
};

export type ConversionSettings = {
  outputDir: string | null;
  defaultPreset: ConversionPreset;
  maxParallelJobs: number;
  autoCreateTranscribeTab: boolean;
  ffmpegPath: string | null;
};

type ListenerDisposer = () => void;

export type RevoiceBridge = {
  openFileDialog: (
    options?: {
      allowMultiple?: boolean;
      filters?: { name: string; extensions: string[] }[];
      defaultPath?: string;
      properties?: string[];
    }
  ) => Promise<string | string[] | null>;
  enqueueJob: (payload: TranscriptionJobPayload) => Promise<{ ok: boolean; job?: JobSummary; error?: string }>;
  listJobs: () => Promise<{ ok: boolean; jobs?: JobSummary[]; error?: string }>;
  cancelJob: (jobId: string) => Promise<{ ok: boolean; error?: string }>;
  onJobEvent: (cb: (event: JobEventMessage) => void) => ListenerDisposer | void;
  readTextFile: (path: string) => Promise<string>;
  listHistory: (options?: { limit?: number; offset?: number }) => Promise<
    { ok: true; items: HistoryRecord[]; total: number; limit: number; offset: number } |
    { ok: false; error: string }
  >;
  getHistoryDetail: (id: number) => Promise<{ ok: boolean; item?: HistoryRecord | null; error?: string }>;
  clearHistory: () => Promise<{ ok: boolean; removed?: number; error?: string }>;
  deleteHistory: (ids: number[]) => Promise<{ ok: boolean; removed?: number; error?: string }>;
  onHistoryAdded: (cb: (record: HistoryRecord) => void) => ListenerDisposer | void;
  onHistoryCleared: (cb: (payload: { removed: number }) => void) => ListenerDisposer | void;
  onHistoryDeleted: (cb: (payload: { removed: number; ids: number[]; total: number }) => void) => ListenerDisposer | void;
  onHistoryPruned: (
    cb: (payload: {
      removed: number;
      removedByAge: number;
      removedByCount: number;
      total: number;
      reason: string;
      policy: RetentionPolicy;
    }) => void
  ) => ListenerDisposer | void;
  getRetentionPolicy: () => Promise<{ ok: boolean; policy?: RetentionPolicy; error?: string }>;
  setRetentionPolicy: (
    policy: RetentionPolicy
  ) => Promise<{ ok: boolean; policy?: RetentionPolicy; error?: string }>;
  getTranscriptionDefaults: () => Promise<{ ok: boolean; outputStyle?: 'timestamps' | 'plain'; error?: string }>;
  setTranscriptionDefaults: (
    payload: { outputStyle: 'timestamps' | 'plain' }
  ) => Promise<{ ok: boolean; outputStyle?: 'timestamps' | 'plain'; error?: string }>;
  listTabs: () => Promise<{ ok: boolean; tabs?: TabSummary[]; error?: string }>;
  createTab: (payload: { title?: string }) => Promise<{ ok: boolean; tab?: TabSummary; error?: string }>;
  updateTab: (
    payload: Partial<TabSummary> & { id: string }
  ) => Promise<{ ok: boolean; tab?: TabSummary; error?: string }>;
  deleteTab: (tabId: string) => Promise<{ ok: boolean; removed?: number; error?: string }>;
  onTabEvent: (cb: (event: { kind: 'updated'; tab: TabSummary } | { kind: 'removed'; tabId: string }) => void) =>
    ListenerDisposer | void;
  copyToClipboard: (text: string) => Promise<{ ok: boolean; error?: string }>;
  openExternal: (url: string) => Promise<{ ok: boolean; error?: string }>;
  enqueueConversion: (
    payload: ConversionJobPayload | ConversionJobPayload[]
  ) => Promise<
    { ok: true; job?: JobSummary; jobs?: JobSummary[] } |
    { ok: false; error: string }
  >;
  listConversionJobs: () => Promise<{ ok: boolean; jobs?: JobSummary[]; error?: string }>;
  cancelConversionJob: (jobId: string) => Promise<{ ok: boolean; error?: string }>;
  listConversionHistory: (options?: { limit?: number; offset?: number }) => Promise<
    { ok: true; jobs: JobSummary[]; limit: number; offset: number; total: number } | { ok: false; error: string }
  >;
  linkConversionTranscription: (conversionJobId: string, transcriptionJobId: string) => Promise<{ ok: boolean; error?: string }>;
  getConversionSettings: () => Promise<{ ok: boolean; settings?: ConversionSettings; error?: string }>;
  setConversionSettings: (
    settings: ConversionSettings
  ) => Promise<{ ok: boolean; settings?: ConversionSettings; error?: string }>;
};

declare global {
  interface Window {
    revoice: RevoiceBridge;
  }
}

export {};
