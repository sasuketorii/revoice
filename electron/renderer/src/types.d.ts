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
};

declare global {
  interface Window {
    revoice: RevoiceBridge;
  }
}

export {};
