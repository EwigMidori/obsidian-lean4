import { ProofBlock } from "../domain/ProofBlock";
import { ProofDocument } from "../domain/ProofDocument";
import {
  BlockCheckState,
  LeanDiagnostic,
  LeanDiagnosticsEvent,
  LeanDocument,
  LeanProgressEvent,
  ProofBlockSnapshot,
  MappedDiagnostic,
} from "./contracts";

/** Owns synchronization and results for one independent or named Lean document. */
export class DocumentSession {
  private state: BlockCheckState = "idle";
  private diagnostics: readonly LeanDiagnostic[] = [];
  private message: string | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private scheduledSince: number | undefined;
  private lastSentVersion: number | undefined;
  private synchronizedVersion: number | undefined;
  private firstSentVersion: number | undefined;
  private generation = 0;
  private isOpen = false;
  private busy = false;
  private checkedVersion: number | undefined;
  private projectedSource: readonly LeanDiagnostic[] | undefined;
  private projectedEpoch = -1;
  private readonly projected = new Map<string, MappedDiagnostic[]>();
  private documentDiagnostics: readonly LeanDiagnostic[] = [];
  private documentErrorCount = 0;
  lastUsed = Date.now();

  constructor(readonly unit: ProofDocument) {}

  get opened(): boolean { return this.isOpen; }
  get processing(): boolean { return this.busy; }
  get epoch(): number { return this.generation; }
  get sentVersion(): number | undefined { return this.lastSentVersion; }
  get readyVersion(): number | undefined { return this.synchronizedVersion; }
  get currentVersionChecked(): boolean { return this.checkedVersion === this.unit.version; }
  get attemptFinished(): boolean {
    return this.currentVersionChecked || this.state === "error"
      || this.state === "idle" && !this.busy && this.lastSentVersion === this.unit.version;
  }

  touch(): void { this.lastUsed = Date.now(); }

  invalidate(): void {
    this.generation += 1;
    this.diagnostics = [];
    this.message = undefined;
    this.checkedVersion = undefined;
    this.state = "idle";
  }

  schedule(callback: () => void, debounceMs: number, maxWaitMs: number): void {
    const now = Date.now();
    this.scheduledSince ??= now;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.state = "scheduled";
    const remaining = Math.max(0, maxWaitMs - (now - this.scheduledSince));
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.scheduledSince = undefined;
      callback();
    }, Math.min(debounceMs, remaining));
  }

  cancelSchedule(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
    this.scheduledSince = undefined;
  }

  enqueue(): void {
    this.cancelSchedule();
    this.state = "queued";
  }

  document(): LeanDocument {
    return { documentId: this.unit.id, code: this.unit.code, version: this.unit.version };
  }

  beginSync(): { readonly document: LeanDocument; readonly opening: boolean; readonly epoch: number } {
    this.touch();
    const opening = !this.isOpen;
    this.isOpen = true;
    this.firstSentVersion ??= this.unit.version;
    this.lastSentVersion = this.unit.version;
    this.synchronizedVersion = undefined;
    this.busy = true;
    this.state = "checking";
    this.message = undefined;
    return { document: this.document(), opening, epoch: this.generation };
  }

  synchronized(version: number, epoch: number): void {
    if (epoch === this.generation && this.isOpen && version === this.unit.version) {
      this.synchronizedVersion = version;
    }
  }

  acceptDiagnostics(event: LeanDiagnosticsEvent): boolean {
    if (!this.isOpen || !this.acceptsVersion(event.version)) return false;
    this.diagnostics = [...event.diagnostics];
    return true;
  }

  acceptProgress(event: LeanProgressEvent): boolean {
    if (!this.isOpen || !this.acceptsVersion(event.version)) return false;
    this.busy = event.processing;
    if (event.processing) {
      this.state = "checking";
    } else if (event.version !== null) {
      this.state = "checked";
      this.checkedVersion = event.version;
      this.message = undefined;
    } else {
      this.state = "idle";
      this.message = "Lean 未返回版本号，检查完成状态无法核对。";
    }
    return true;
  }

  fail(message: string): void {
    this.cancelSchedule();
    this.busy = false;
    this.state = "error";
    this.message = message;
  }

  closed(): void {
    this.cancelSchedule();
    this.isOpen = false;
    this.busy = false;
    this.lastSentVersion = undefined;
    this.synchronizedVersion = undefined;
    this.firstSentVersion = undefined;
    this.generation += 1;
    if (this.state === "checking" || this.state === "queued" || this.state === "scheduled") {
      this.state = "idle";
    }
  }

  reset(): void {
    this.closed();
    this.invalidate();
  }

  snapshot(block: ProofBlock): ProofBlockSnapshot {
    this.projectDiagnostics();
    const diagnostics = this.projected.get(block.id) ?? [];
    const sharedMessage = this.documentDiagnostics.length > 0
      ? `会话级消息：${this.documentDiagnostics.map((diagnostic) => diagnostic.message).join("\n")}`
      : this.documentErrorCount > 0 && !diagnostics.some((diagnostic) => diagnostic.severity === "error")
        ? "同一会话的其他代码块有错误。"
        : undefined;
    return {
      ...DocumentSession.presentation(block),
      documentId: this.unit.id,
      documentVersion: this.unit.version,
      mappingEpoch: this.unit.mappingEpoch,
      documentBlockCount: this.unit.members.length,
      documentErrorCount: this.documentErrorCount,
      documentDiagnostics: this.documentDiagnostics,
      state: this.state,
      diagnostics,
      message: this.message ?? sharedMessage,
    };
  }

  private projectDiagnostics(): void {
    if (this.projectedSource === this.diagnostics && this.projectedEpoch === this.unit.mappingEpoch) return;
    this.projectedSource = this.diagnostics;
    this.projectedEpoch = this.unit.mappingEpoch;
    this.projected.clear();
    const unmapped: LeanDiagnostic[] = [];
    let errors = 0;
    for (const diagnostic of this.diagnostics) {
      if (diagnostic.severity === "error") errors += 1;
      const ranges = this.unit.mapRange(diagnostic.range);
      if (ranges.length === 0) unmapped.push(diagnostic);
      for (const mapped of ranges) {
        const diagnostics = this.projected.get(mapped.blockId) ?? [];
        diagnostics.push({ ...diagnostic, range: mapped.range, from: mapped.from, to: mapped.to });
        this.projected.set(mapped.blockId, diagnostics);
      }
    }
    this.documentDiagnostics = unmapped;
    this.documentErrorCount = errors;
  }

  static displaySnapshot(block: ProofBlock): ProofBlockSnapshot {
    return {
      ...DocumentSession.presentation(block),
      state: "display-only",
      diagnostics: [],
      message: block.metadataError,
    };
  }

  private static presentation(block: ProofBlock): Omit<ProofBlockSnapshot, "state" | "diagnostics"> {
    return {
      id: block.id,
      noteId: block.noteId,
      ordinal: block.ordinal,
      code: block.code,
      version: block.version,
      language: block.language,
      info: block.info,
      title: block.title,
      metadataError: block.metadataError,
      session: block.session,
      displayOnly: block.displayOnly,
      from: block.from,
      to: block.to,
      codeFrom: block.sourceMap.from,
      codeTo: block.sourceMap.to,
      includesEnd: block.sourceMap.includesEnd,
    };
  }

  private acceptsVersion(version: number | null): boolean {
    if (this.lastSentVersion !== this.unit.version) return false;
    if (version !== null) return version === this.unit.version;
    // Unversioned notifications are usable only before any change on this open document.
    return this.firstSentVersion === this.lastSentVersion;
  }
}
