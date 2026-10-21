export type Unsubscribe = () => void;

/** Lean and CodeMirror both count UTF-16 code units. Lines are zero based. */
export interface TextPosition {
  readonly line: number;
  readonly character: number;
}

export interface TextRange {
  readonly start: TextPosition;
  readonly end: TextPosition;
}

export interface LeanDiagnostic {
  readonly range: TextRange;
  readonly message: string;
  readonly severity: "error" | "warning" | "information" | "hint";
}

export interface LeanDocument {
  readonly documentId: string;
  readonly version: number;
  readonly code: string;
}

export interface LeanDiagnosticsEvent {
  readonly documentId: string;
  /** Null means the server did not identify a version. Never fabricate one. */
  readonly version: number | null;
  readonly diagnostics: readonly LeanDiagnostic[];
}

export interface LeanProgressEvent {
  readonly documentId: string;
  readonly version: number | null;
  readonly processing: boolean;
}

export interface LeanServiceStatus {
  readonly state: "stopped" | "starting" | "ready" | "error";
  readonly message?: string;
}

export interface LeanGoals {
  readonly goals: readonly string[];
}

/** Owns the Lean process and protocol. Application callers never see an LSP URI. */
export interface LeanGateway {
  open(document: LeanDocument): Promise<void>;
  change(document: LeanDocument): Promise<void>;
  close(documentId: string): Promise<void>;
  goals(documentId: string, position: TextPosition, signal?: AbortSignal): Promise<LeanGoals>;
  onDiagnostics(listener: (event: LeanDiagnosticsEvent) => void): Unsubscribe;
  onProgress(listener: (event: LeanProgressEvent) => void): Unsubscribe;
  onStatus(listener: (status: LeanServiceStatus) => void): Unsubscribe;
  restart(): Promise<void>;
  dispose(): Promise<void>;
}

export type BlockCheckState =
  | "display-only"
  | "idle"
  | "scheduled"
  | "queued"
  | "checking"
  | "checked"
  | "error";

export interface MappedDiagnostic extends LeanDiagnostic {
  readonly from: number;
  readonly to: number;
}

export interface ProofBlockSnapshot {
  readonly id: string;
  readonly noteId: string;
  readonly ordinal: number;
  readonly code: string;
  readonly version: number;
  readonly language: string;
  readonly info: string;
  readonly title?: string;
  readonly metadataError?: string;
  readonly session?: string;
  readonly documentId?: string;
  readonly documentVersion?: number;
  readonly mappingEpoch?: number;
  readonly documentBlockCount?: number;
  readonly documentErrorCount?: number;
  readonly documentDiagnostics?: readonly LeanDiagnostic[];
  readonly displayOnly: boolean;
  /** Includes opening and closing fences; offsets refer to the current Markdown. */
  readonly from: number;
  readonly to: number;
  readonly codeFrom: number;
  readonly codeTo: number;
  /** True only for an unfinished fence whose final editable position is Markdown EOF. */
  readonly includesEnd: boolean;
  readonly state: BlockCheckState;
  readonly diagnostics: readonly MappedDiagnostic[];
  readonly message?: string;
}

export interface GoalSnapshot {
  readonly noteId: string;
  readonly blockId: string;
  readonly offset: number;
  readonly state: "loading" | "ready" | "error" | "unavailable";
  readonly goals: readonly string[];
  readonly message?: string;
}

export interface WorkspaceSnapshot {
  readonly service: LeanServiceStatus;
  readonly blocks: readonly ProofBlockSnapshot[];
  readonly goal: GoalSnapshot | null;
}

export interface WorkspaceOptions {
  readonly debounceMs?: number;
  readonly maxWaitMs?: number;
  readonly maxOpenBlocks?: number;
  readonly maxQueuedBlocks?: number;
  readonly idleTimeoutMs?: number;
}

export interface WorkspaceRestartOptions {
  /** Environment preparation replays its latest UI intent instead of an older active block. */
  readonly resumeActive?: boolean;
}
