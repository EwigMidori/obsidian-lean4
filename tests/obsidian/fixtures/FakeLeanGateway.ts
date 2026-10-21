import type {
  LeanDiagnostic, LeanDiagnosticsEvent, LeanDocument, LeanGateway, LeanProgressEvent,
  LeanServiceStatus, TextPosition, Unsubscribe
} from "../../../src/application/contracts";

export class FakeLeanGateway implements LeanGateway {
  static readonly instances: FakeLeanGateway[] = [];
  readonly documents = new Map<string, LeanDocument>();
  readonly closed: string[] = [];
  disposeCalls = 0;
  disposeGate: Promise<void> | null = null;
  private readonly diagnosticListeners = new Set<(event: LeanDiagnosticsEvent) => void>();
  private readonly progressListeners = new Set<(event: LeanProgressEvent) => void>();
  private readonly statusListeners = new Set<(status: LeanServiceStatus) => void>();

  constructor(readonly options: { projectRoot?: string; environment?: { resolve(): Promise<unknown> } }) { FakeLeanGateway.instances.push(this); }
  async open(document: LeanDocument): Promise<void> {
    await this.options.environment?.resolve();
    this.documents.set(document.documentId, document);
  }
  async change(document: LeanDocument): Promise<void> { this.documents.set(document.documentId, document); }
  async close(documentId: string): Promise<void> { this.closed.push(documentId); this.documents.delete(documentId); }
  async goals(_documentId: string, _position: TextPosition): Promise<{ goals: readonly string[] }> { return { goals: ["⊢ True"] }; }
  async restart(): Promise<void> {}
  async dispose(): Promise<void> {
    this.disposeCalls++;
    await this.disposeGate;
  }
  onDiagnostics(listener: (event: LeanDiagnosticsEvent) => void): Unsubscribe {
    this.diagnosticListeners.add(listener);
    return () => { this.diagnosticListeners.delete(listener); };
  }
  onProgress(listener: (event: LeanProgressEvent) => void): Unsubscribe {
    this.progressListeners.add(listener);
    return () => { this.progressListeners.delete(listener); };
  }
  onStatus(listener: (status: LeanServiceStatus) => void): Unsubscribe {
    this.statusListeners.add(listener);
    return () => { this.statusListeners.delete(listener); };
  }
  diagnostics(document: LeanDocument, diagnostics: readonly LeanDiagnostic[]): void {
    for (const listener of this.diagnosticListeners) {
      listener({ documentId: document.documentId, version: document.version, diagnostics });
    }
  }
  progress(document: LeanDocument, processing: boolean): void {
    for (const listener of this.progressListeners) {
      listener({ documentId: document.documentId, version: document.version, processing });
    }
  }
}

export class Deferred {
  readonly promise: Promise<void>;
  resolve!: () => void;
  constructor() { this.promise = new Promise(resolve => { this.resolve = resolve; }); }
}
