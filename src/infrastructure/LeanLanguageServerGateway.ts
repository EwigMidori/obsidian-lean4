import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CancellationTokenSource } from "vscode-jsonrpc";
import type {
  LeanDiagnostic,
  LeanDiagnosticsEvent,
  LeanDocument,
  LeanGateway,
  LeanGoals,
  LeanProgressEvent,
  LeanServiceStatus,
  TextPosition,
  Unsubscribe,
} from "../application/contracts";
import { LeanProjectSession } from "./LeanProjectSession";
import { LeanProtocol } from "./LeanProtocol";
import { ManagedLeanEnvironment } from "./ManagedLeanEnvironment";
import type { LeanEnvironmentRuntime } from "./LeanToolchainDiscovery";

export interface LeanLanguageServerOptions {
  readonly projectRoot?: string;
  readonly environment?: ManagedLeanEnvironment;
  readonly cacheRoot?: string;
  readonly lakeExecutable?: string;
  readonly startupTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
}

interface OpenDocument {
  uri: string;
  session?: LeanProjectSession;
  document: LeanDocument;
  opening?: Promise<void>;
  opened: boolean;
  fatal?: { readonly version: number | null; readonly diagnostic: LeanDiagnostic };
  goalCancellation?: CancellationTokenSource;
}

/**
 * Adapts application-owned check documents to Lean. A document can represent one independent
 * block or a named session; composition and Markdown position mapping stay in the application.
 */
export class LeanLanguageServerGateway implements LeanGateway {
  private readonly blocks = new Map<string, OpenDocument>();
  private readonly byUri = new Map<string, string>();
  private readonly diagnosticsListeners = new Set<(event: LeanDiagnosticsEvent) => void>();
  private readonly progressListeners = new Set<(event: LeanProgressEvent) => void>();
  private readonly statusListeners = new Set<(status: LeanServiceStatus) => void>();
  private readonly identity = randomUUID().replaceAll("-", "");
  private nextDocument = 0;
  private generation = 0;
  private session: LeanProjectSession | undefined;
  private sessionStarting: Promise<LeanProjectSession> | undefined;
  private activeRuntime: LeanEnvironmentRuntime | undefined;
  private environmentCancellation = new AbortController();
  private readonly environment: ManagedLeanEnvironment;
  private disposed = false;
  private status: LeanServiceStatus = { state: "stopped" };

  constructor(private readonly options: LeanLanguageServerOptions = {}) {
    this.environment = options.environment ?? new ManagedLeanEnvironment({ cacheRoot: options.cacheRoot });
  }

  async open(document: LeanDocument): Promise<void> {
    this.assertUsable();
    if (this.blocks.has(document.documentId)) return this.change(document);
    const block: OpenDocument = {
      uri: "",
      document,
      opened: false,
    };
    this.blocks.set(document.documentId, block);
    block.opening = this.openDocument(block);
    return block.opening;
  }

  private async openDocument(block: OpenDocument): Promise<void> {
    const document = block.document;
    try {
      const session = await this.getSession();
      if (this.blocks.get(document.documentId) !== block || this.session !== session || !this.activeRuntime) return;
      block.session = session;
      // URI assignment happens only after the environment is resolved and ownership is rechecked.
      block.uri = pathToFileURL(resolve(
        this.activeRuntime.projectRoot,
        `ObsidianBlock_${this.identity}_${++this.nextDocument}.lean`,
      )).href;
      this.byUri.set(block.uri, document.documentId);
      await session.start();
      if (this.blocks.get(document.documentId) !== block || this.session !== session) return;
      await session.notify("textDocument/didOpen", {
        textDocument: {
          uri: block.uri,
          languageId: "lean4",
          version: document.version,
          text: document.code,
        },
        // Only consume already-built imports. Opening a note must not rebuild a project.
        dependencyBuildMode: "never",
      });
      block.opened = true;
    } catch (error) {
      if (this.blocks.get(document.documentId) === block) {
        this.blocks.delete(document.documentId);
        this.byUri.delete(block.uri);
      }
      throw error;
    }
  }

  async change(document: LeanDocument): Promise<void> {
    this.assertUsable();
    const block = this.blocks.get(document.documentId);
    if (!block) return this.open(document);
    await block.opening;
    if (this.blocks.get(document.documentId) !== block) return;
    if (document.version <= block.document.version) return;
    block.goalCancellation?.cancel();
    block.fatal = undefined;
    block.document = document;
    await block.session?.notify("textDocument/didChange", {
      textDocument: { uri: block.uri, version: document.version },
      contentChanges: [{ text: document.code }],
    });
  }

  async close(documentId: string): Promise<void> {
    const block = this.blocks.get(documentId);
    if (!block) return;
    this.blocks.delete(documentId);
    this.byUri.delete(block.uri);
    block.goalCancellation?.cancel();
    block.goalCancellation?.dispose();
    if (!block.session) return;
    await block.opening?.catch(() => {});
    if (block.opened && this.session === block.session) {
      await block.session.notify("textDocument/didClose", { textDocument: { uri: block.uri } });
    }
  }

  async goals(documentId: string, position: TextPosition, signal?: AbortSignal): Promise<LeanGoals> {
    if (signal?.aborted) throw new Error("Lean request cancelled.");
    const block = this.blocks.get(documentId);
    if (!block) throw new Error("This Lean block is not open.");
    block.goalCancellation?.cancel();
    block.goalCancellation?.dispose();
    const cancellation = new CancellationTokenSource();
    // Materialize the mutable token before any early abort. jsonrpc 8's lazy
    // cancelled singleton cannot be cancelled again by close/restart.
    const token = cancellation.token;
    block.goalCancellation = cancellation;
    let abort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => {
        cancellation.cancel();
        reject(new Error("Lean request cancelled."));
      };
    });
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await Promise.race([block.opening, aborted]);
      if (this.blocks.get(documentId) !== block) throw new Error("This Lean block is not open.");
      if (signal?.aborted) throw new Error("Lean request cancelled.");
      const session = block.session;
      if (!session) throw new Error("This Lean block is not open.");
      const generation = this.generation;
      const version = block.document.version;
      const params = { textDocument: { uri: block.uri }, position };
      const plain = LeanProtocol.record(
        await Promise.race([session.request("$/lean/plainGoal", params, token), aborted]),
      );
      let goals: readonly string[];
      if (plain && Array.isArray(plain.goals)) {
        goals = plain.goals.filter((goal): goal is string => typeof goal === "string");
      } else {
        const term = LeanProtocol.record(
          await Promise.race([session.request("$/lean/plainTermGoal", params, token), aborted]),
        );
        goals = typeof term?.goal === "string" ? [term.goal] : [];
      }
      if (
        generation !== this.generation ||
        this.blocks.get(documentId) !== block ||
        block.document.version !== version ||
        token.isCancellationRequested
      ) throw new Error("Lean goal result became stale.");
      return { goals };
    } finally {
      signal?.removeEventListener("abort", abort);
      if (block.goalCancellation === cancellation) block.goalCancellation = undefined;
      cancellation.dispose();
    }
  }

  onDiagnostics(listener: (event: LeanDiagnosticsEvent) => void): Unsubscribe {
    this.diagnosticsListeners.add(listener);
    return () => this.diagnosticsListeners.delete(listener);
  }

  onProgress(listener: (event: LeanProgressEvent) => void): Unsubscribe {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  onStatus(listener: (status: LeanServiceStatus) => void): Unsubscribe {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  async restart(): Promise<void> {
    this.assertUsable();
    await this.reset();
    await (await this.getSession()).start();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.reset();
    this.diagnosticsListeners.clear();
    this.progressListeners.clear();
    this.statusListeners.clear();
  }

  recentLog(): string {
    return this.session?.recentLog() ?? this.environment.recentLog();
  }

  private async getSession(): Promise<LeanProjectSession> {
    this.assertUsable();
    if (this.session) return this.session;
    if (this.sessionStarting) return this.sessionStarting;
    const generation = this.generation;
    const starting = this.createSession(generation);
    this.sessionStarting = starting;
    try {
      return await starting;
    } finally {
      if (this.sessionStarting === starting) this.sessionStarting = undefined;
    }
  }

  private async createSession(generation: number): Promise<LeanProjectSession> {
    const projectRoot = this.options.projectRoot?.trim();
    const runtime: LeanEnvironmentRuntime = projectRoot
      ? { projectRoot, lakeExecutable: this.options.lakeExecutable?.trim() || "lake" }
      : await this.environment.resolve(this.environmentCancellation.signal);
    if (this.disposed || generation !== this.generation) throw new Error("Lean environment startup cancelled.");
    this.activeRuntime = runtime;
    this.session = new LeanProjectSession({
        projectRoot: runtime.projectRoot,
        executable: runtime.lakeExecutable,
        env: runtime.env,
        startupTimeoutMs: this.options.startupTimeoutMs,
        requestTimeoutMs: this.options.requestTimeoutMs,
      }, {
        notification: (method, params) => {
          if (generation === this.generation && !this.disposed) this.notification(method, params);
        },
        status: (status) => {
          if (generation === this.generation && !this.disposed) this.publishStatus(status);
        },
      });
    return this.session;
  }

  private notification(method: string, params: unknown): void {
    const value = LeanProtocol.record(params);
    if (!value) return;
    if (method === "textDocument/publishDiagnostics") {
      const documentId = typeof value.uri === "string" ? this.byUri.get(value.uri) : undefined;
      const diagnostics = LeanProtocol.diagnostics(value.diagnostics);
      if (!documentId || !diagnostics) return;
      const version = LeanProtocol.version(value.version);
      const fatal = this.blocks.get(documentId)?.fatal;
      const event = {
        documentId,
        version,
        diagnostics: fatal && fatal.version === version && !diagnostics.some((item) => item.severity === "error")
          ? [...diagnostics, fatal.diagnostic] : diagnostics,
      };
      for (const listener of this.diagnosticsListeners) listener(event);
    } else if (method === "$/lean/fileProgress") {
      const document = LeanProtocol.record(value.textDocument);
      const documentId = typeof document?.uri === "string" ? this.byUri.get(document.uri) : undefined;
      if (!documentId || !Array.isArray(value.processing)) return;
      const version = LeanProtocol.version(document?.version);
      const fatal = value.processing.map((item) => LeanProtocol.record(item)).find((item) => item?.kind === 2);
      if (fatal) {
        const diagnostic: LeanDiagnostic = {
          severity: "error",
          message: "Lean stopped checking this block after a fatal worker error. Check the Lean log or restart the service.",
          range: LeanProtocol.range(fatal.range) ?? {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
        };
        const block = this.blocks.get(documentId);
        if (block) block.fatal = { version, diagnostic };
        for (const listener of this.diagnosticsListeners) {
          listener({ documentId, version, diagnostics: [diagnostic] });
        }
      }
      const event = {
        documentId,
        version,
        processing: !fatal && value.processing.length > 0,
      };
      for (const listener of this.progressListeners) listener(event);
    }
  }

  private publishStatus(status: LeanServiceStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }

  private async reset(): Promise<void> {
    ++this.generation;
    const session = this.session;
    this.environmentCancellation.abort();
    this.environmentCancellation = new AbortController();
    this.session = undefined;
    this.sessionStarting = undefined;
    this.activeRuntime = undefined;
    for (const block of this.blocks.values()) {
      block.goalCancellation?.cancel();
      block.goalCancellation?.dispose();
    }
    this.blocks.clear();
    this.byUri.clear();
    await session?.close();
    this.publishStatus({ state: "stopped" });
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error("Lean gateway has been disposed.");
  }
}
