export type TranscriptionPayload = {
  inputPath: string;
  outputDir: string;
  model: string;
  language: string;
  beamSize: number;
  computeType: string;
  initialPrompt?: string;
  withTimestamps?: boolean;
  formats?: string;
  replace?: string;
  noVad?: boolean;
  minSegment?: number;
  preset?: string;
  memo?: boolean;
};

type DoneEvent = {
  ok: boolean;
  code?: number;
  outputPath?: string | null;
  transcript?: string | null;
};

export type HistoryRecord = {
  id: number;
  inputPath: string | null;
  outputPath: string | null;
  transcriptPreview: string | null;
  model: string | null;
  language: string | null;
  createdAt: string;
  duration: number | null;
  status: string | null;
  notes: string | null;
};

type ListenerDisposer = () => void;

export type RevoiceBridge = {
  openFileDialog: () => Promise<string | null>;
  startTranscription: (payload: TranscriptionPayload) => void;
  onLog: (cb: (msg: string) => void) => ListenerDisposer | void;
  onPid: (cb: (pid: number) => void) => ListenerDisposer | void;
  onDone: (cb: (event: DoneEvent) => void) => ListenerDisposer | void;
  onError: (cb: (error: string) => void) => ListenerDisposer | void;
  kill: (pid: number) => void;
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
};

declare global {
  interface Window {
    revoice: RevoiceBridge;
  }
}

export {};
