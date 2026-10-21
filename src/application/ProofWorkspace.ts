import { BlockCatalog } from "../domain/BlockCatalog";
import { DocumentCatalog } from "../domain/DocumentCatalog";
import { ProofBlock } from "../domain/ProofBlock";
import { DocumentSession } from "./DocumentSession";
import {
  GoalSnapshot,
  LeanGateway,
  LeanServiceStatus,
  TextPosition,
  Unsubscribe,
  WorkspaceOptions,
  WorkspaceRestartOptions,
  WorkspaceSnapshot,
} from "./contracts";

interface GoalRequest {
  readonly serial: number;
  readonly noteId: string;
  readonly blockId: string;
  readonly documentId: string;
  readonly version: number;
  readonly mappingEpoch: number;
  readonly offset: number;
  readonly position: TextPosition;
  readonly localPosition: TextPosition;
}

/** Coordinates note editing, bounded Lean sessions and the active goal inspection. */
export class ProofWorkspace {
  private readonly catalogs = new Map<string, BlockCatalog>();
  private readonly documents = new Map<string, DocumentCatalog>();
  private readonly blocks = new Map<string, ProofBlock>();
  private readonly sessions = new Map<string, DocumentSession>();
  private readonly listeners = new Set<(snapshot: WorkspaceSnapshot) => void>();
  private readonly subscriptions: Unsubscribe[];
  private readonly queue: string[] = [];
  private readonly queuedByNote = new Set<string>();
  private readonly noteChecks = new Map<string, number>();
  private readonly options: Required<WorkspaceOptions>;
  private service: LeanServiceStatus = { state: "stopped" };
  private goal: GoalSnapshot | null = null;
  private desiredGoal: GoalRequest | null = null;
  private goalSerial = 0;
  private goalRunning = false;
  private goalCancellation: AbortController | undefined;
  private pumping = false;
  private stopped = false;
  private restarting = false;
  private lifecycle = 0;
  private activeBlockId: string | undefined;
  private readonly idleTimer: ReturnType<typeof setInterval>;
  private readonly syncWatchdogs = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly gateway: LeanGateway, options: WorkspaceOptions = {}) {
    this.options = {
      debounceMs: Math.max(0, options.debounceMs ?? 200),
      maxWaitMs: Math.max(1, options.maxWaitMs ?? 1_000),
      maxOpenBlocks: Math.max(1, options.maxOpenBlocks ?? 4),
      maxQueuedBlocks: Math.max(1, options.maxQueuedBlocks ?? 64),
      idleTimeoutMs: Math.max(1, options.idleTimeoutMs ?? 60_000),
    };
    this.subscriptions = [
      gateway.onDiagnostics((event) => {
        if (this.stopped || this.restarting) return;
        if (this.sessions.get(event.documentId)?.acceptDiagnostics(event)) this.publish();
      }),
      gateway.onProgress((event) => {
        if (this.stopped || this.restarting) return;
        if (this.sessions.get(event.documentId)?.acceptProgress(event)) {
          if (!event.processing) this.clearWatchdog(event.documentId);
          this.publish();
          void this.pump();
          void this.pumpGoals();
        }
      }),
      gateway.onStatus((status) => {
        if (this.stopped) return;
        this.service = status;
        if (status.state === "error" || status.state === "stopped") {
          for (const [id, session] of this.sessions) {
            if (session.opened || this.queue.includes(id)) {
              session.closed();
              session.fail(status.message ?? "Lean 服务已停止。");
              this.clearWatchdog(id);
            }
          }
          this.queue.length = 0;
          this.queuedByNote.clear();
          this.noteChecks.clear();
          this.clearAllWatchdogs();
          this.cancelGoal("Lean 服务不可用。");
        }
        this.publish();
      }),
    ];
    this.idleTimer = setInterval(() => void this.retireIdle(), Math.min(10_000, this.options.idleTimeoutMs));
  }

  updateNote(noteId: string, text: string): void {
    if (this.stopped) return;
    let catalog = this.catalogs.get(noteId);
    if (!catalog) {
      catalog = new BlockCatalog(noteId);
      this.catalogs.set(noteId, catalog);
      this.documents.set(noteId, new DocumentCatalog(noteId));
    }
    const previousGoal = this.desiredGoal?.noteId === noteId ? this.desiredGoal : undefined;
    const previouslyOpenBlocks = new Set(
      [...this.sessions.values()].filter((session) => session.opened)
        .flatMap((session) => session.unit.members.map((block) => block.id)),
    );
    const previouslyQueuedBlocks = new Set(
      this.queue.flatMap((id) => this.sessions.get(id)?.unit.members.map((block) => block.id) ?? []),
    );
    const blockChanges = catalog.update(text);
    for (const block of blockChanges.removed) this.blocks.delete(block.id);
    for (const block of catalog.blocks) this.blocks.set(block.id, block);
    const changes = this.documents.get(noteId)!.update(catalog.blocks);
    for (const document of changes.removed) this.removeSession(document.id);
    for (const document of changes.added) this.sessions.set(document.id, new DocumentSession(document));
    for (const document of changes.changed) {
      const session = this.sessions.get(document.id)!;
      session.invalidate();
      this.clearWatchdog(document.id);
      // A queued request already owns the intent to check the latest contents.
      if (this.queue.includes(document.id)) session.enqueue();
    }
    for (const document of [...changes.added, ...changes.changed]) {
      const session = this.sessions.get(document.id)!;
      if (this.queue.includes(document.id)) continue;
      if (!this.noteChecks.has(noteId) && document.members.some((block) => previouslyQueuedBlocks.has(block.id))) {
        this.enqueue(document.id, true);
        continue;
      }
      if (session.opened || document.members.some((block) =>
        block.id === this.activeBlockId || previouslyOpenBlocks.has(block.id),
      )) {
        session.schedule(() => this.checkDocument(document.id), this.options.debounceMs, this.options.maxWaitMs);
      }
    }
    if (this.activeBlockId && !this.blocks.has(this.activeBlockId)) this.activeBlockId = undefined;
    if (previousGoal) {
      const block = this.blocks.get(previousGoal.blockId);
      const unit = block && this.documents.get(noteId)!.documentFor(block.id);
      if (!unit || unit.id !== previousGoal.documentId || unit.version !== previousGoal.version) {
        this.cancelGoal("代码或会话成员已更改。");
      } else if (unit.mappingEpoch !== previousGoal.mappingEpoch) {
        this.cancelGoal();
        this.inspectAt(noteId, block!.sourceMap.offsetAt(previousGoal.localPosition));
      }
    }
    if (this.noteChecks.has(noteId)
      && (changes.added.length || changes.removed.length || changes.changed.length || changes.mappingChanged.length)) {
      this.noteChecks.set(noteId, 0);
      this.fillQueue();
    }
    this.publish();
    void this.pump();
  }

  inspectAt(noteId: string, offset: number): void {
    if (this.stopped) return;
    const block = this.catalogs.get(noteId)?.blockAt(offset);
    this.activeBlockId = block?.id;
    if (!block || block.displayOnly) {
      this.cancelGoal();
      if (block) {
        this.goal = {
          noteId,
          blockId: block.id,
          offset,
          state: "unavailable",
          goals: [],
          message: block.metadataError ?? "此代码块仅用于展示。",
        };
      }
      this.publish();
      return;
    }
    const unit = this.documents.get(noteId)!.documentFor(block.id)!;
    const position = unit.positionAt(block.id, offset);
    const localPosition = block.sourceMap.positionAt(offset);
    if (!position || !localPosition) return;
    const session = this.sessions.get(unit.id)!;
    session.touch();
    const previous = this.desiredGoal;
    if (previous?.blockId === block.id && previous.documentId === unit.id
      && previous.version === unit.version && previous.mappingEpoch === unit.mappingEpoch && previous.offset === offset) return;
    const request: GoalRequest = {
      serial: ++this.goalSerial,
      noteId,
      blockId: block.id,
      documentId: unit.id,
      version: unit.version,
      mappingEpoch: unit.mappingEpoch,
      offset,
      position,
      localPosition,
    };
    this.goalCancellation?.abort();
    this.desiredGoal = request;
    this.goal = { noteId, blockId: block.id, offset, state: "loading", goals: [] };
    if (!session.opened || session.sentVersion !== unit.version) {
      session.schedule(() => this.checkDocument(unit.id), this.options.debounceMs, this.options.maxWaitMs);
    } else {
      void this.pumpGoals();
    }
    this.publish();
  }

  checkBlock(blockId: string): void {
    const block = this.blocks.get(blockId);
    if (!block || block.displayOnly) return;
    const unit = this.documents.get(block.noteId)?.documentFor(blockId);
    if (unit) this.checkDocument(unit.id);
  }

  private checkDocument(documentId: string): void {
    if (this.stopped || this.restarting) return;
    const session = this.sessions.get(documentId);
    if (!session) return;
    session.touch();
    if (session.processing && session.sentVersion === session.unit.version) return;
    if (session.opened && session.currentVersionChecked) {
      void this.pumpGoals();
      return;
    }
    this.enqueue(documentId, true);
    this.publish();
    void this.pump();
  }

  checkNote(noteId: string): void {
    if (this.stopped || !this.catalogs.has(noteId)) return;
    this.noteChecks.set(noteId, 0);
    this.fillQueue();
    this.publish();
    void this.pump();
  }

  subscribe(listener: (snapshot: WorkspaceSnapshot) => void): Unsubscribe {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot(): WorkspaceSnapshot {
    return {
      service: { ...this.service },
      blocks: [...this.catalogs.values()].flatMap((catalog) =>
        catalog.blocks.map((block) => {
          if (block.displayOnly) return DocumentSession.displaySnapshot(block);
          const unit = this.documents.get(catalog.noteId)!.documentFor(block.id)!;
          return this.sessions.get(unit.id)!.snapshot(block);
        }),
      ),
      goal: this.goal ? { ...this.goal, goals: [...this.goal.goals] } : null,
    };
  }

  closeNote(noteId: string): void {
    const catalog = this.catalogs.get(noteId);
    if (!catalog) return;
    for (const document of this.documents.get(noteId)?.documents ?? []) this.removeSession(document.id);
    for (const block of catalog.blocks) {
      this.blocks.delete(block.id);
      if (block.id === this.activeBlockId) this.activeBlockId = undefined;
    }
    this.catalogs.delete(noteId);
    this.documents.delete(noteId);
    this.noteChecks.delete(noteId);
    if (this.desiredGoal?.noteId === noteId || this.goal?.noteId === noteId) this.cancelGoal();
    this.publish();
  }

  async restart(options: WorkspaceRestartOptions = {}): Promise<void> {
    if (this.stopped || this.restarting) return;
    this.restarting = true;
    this.lifecycle += 1;
    this.queue.length = 0;
    this.queuedByNote.clear();
    this.noteChecks.clear();
    this.cancelGoal();
    this.clearAllWatchdogs();
    for (const [id, session] of this.sessions) {
      this.clearWatchdog(id);
      session.reset();
    }
    this.publish();
    try {
      await this.gateway.restart();
    } finally {
      this.restarting = false;
      if (options.resumeActive !== false && this.activeBlockId && !this.stopped) this.checkBlock(this.activeBlockId);
      this.publish();
    }
  }

  async dispose(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.lifecycle += 1;
    clearInterval(this.idleTimer);
    this.clearAllWatchdogs();
    for (const subscription of this.subscriptions) subscription();
    for (const [id, session] of this.sessions) {
      this.clearWatchdog(id);
      session.reset();
    }
    this.listeners.clear();
    this.queue.length = 0;
    this.queuedByNote.clear();
    this.noteChecks.clear();
    this.cancelGoal();
    await this.gateway.dispose();
    this.sessions.clear();
    this.catalogs.clear();
    this.documents.clear();
    this.blocks.clear();
  }

  private enqueue(blockId: string, priority: boolean): boolean {
    const existingIndex = this.queue.indexOf(blockId);
    if (existingIndex >= 0) {
      if (priority && existingIndex > 0) {
        this.queue.splice(existingIndex, 1);
        this.queue.unshift(blockId);
      }
      return true;
    }
    if (this.queue.length >= this.options.maxQueuedBlocks) {
      if (!priority) return false;
      const displaced = this.queue.pop();
      if (displaced) {
        const session = this.sessions.get(displaced);
        if (session && this.queuedByNote.delete(displaced)) {
          const noteId = session.unit.noteId;
          const ordinal = this.documents.get(noteId)!.documents.indexOf(session.unit);
          this.noteChecks.set(noteId, Math.min(this.noteChecks.get(noteId) ?? ordinal, ordinal));
        } else {
          session?.fail("检查队列已满；请稍后重试。");
        }
      }
    }
    if (priority) this.queue.unshift(blockId);
    else this.queue.push(blockId);
    this.sessions.get(blockId)?.enqueue();
    return true;
  }

  private fillQueue(): void {
    for (const [noteId, initialIndex] of this.noteChecks) {
      const documents = this.documents.get(noteId)?.documents ?? [];
      let index = initialIndex;
      while (index < documents.length && this.queue.length < this.options.maxQueuedBlocks) {
        const document = documents[index++]!;
        const session = this.sessions.get(document.id);
        if (!session || session.currentVersionChecked || session.processing && session.sentVersion === document.version) continue;
        if (this.enqueue(document.id, false)) this.queuedByNote.add(document.id);
      }
      if (index >= documents.length && documents.every((document) => this.sessions.get(document.id)?.attemptFinished)) {
        this.noteChecks.delete(noteId);
      } else {
        this.noteChecks.set(noteId, index);
      }
    }
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.stopped || this.restarting) return;
    this.pumping = true;
    const lifecycle = this.lifecycle;
    try {
      this.fillQueue();
      while (this.queue.length > 0 && !this.stopped && !this.restarting && lifecycle === this.lifecycle) {
        const id = this.queue[0]!;
        const session = this.sessions.get(id);
        if (!session) {
          this.queue.shift();
          this.queuedByNote.delete(id);
          this.fillQueue();
          continue;
        }
        if (session.opened && session.sentVersion === session.unit.version) {
          if (session.currentVersionChecked || session.processing) {
            this.queue.shift();
            this.queuedByNote.delete(id);
            this.fillQueue();
            continue;
          }
          await this.closeSession(session);
          if (!this.canSynchronize(id, session, lifecycle)) continue;
        }
        if (!session.opened) {
          const open = [...this.sessions.values()].filter((candidate) => candidate.opened);
          if (open.length >= this.options.maxOpenBlocks) {
            const victim = open
              .filter((candidate) => !candidate.processing && !candidate.unit.members.some((block) => block.id === this.activeBlockId))
              .sort((left, right) => left.lastUsed - right.lastUsed)[0]
              ?? open.filter((candidate) => !candidate.processing).sort((left, right) => left.lastUsed - right.lastUsed)[0];
            if (!victim) break;
            await this.closeSession(victim);
            if (!this.canSynchronize(id, session, lifecycle)) continue;
          }
        }
        if (!this.canSynchronize(id, session, lifecycle)) continue;
        this.removeQueued(id);
        this.fillQueue();
        const sync = session.beginSync();
        this.publish();
        this.startWatchdog(session);
        try {
          if (sync.opening) await this.gateway.open(sync.document);
          else await this.gateway.change(sync.document);
          if (this.sessions.get(id) !== session || this.stopped || lifecycle !== this.lifecycle || sync.epoch !== session.epoch) continue;
          session.synchronized(sync.document.version, sync.epoch);
          void this.pumpGoals();
        } catch (error) {
          if (this.sessions.get(id) === session && lifecycle === this.lifecycle && sync.epoch === session.epoch) {
            session.closed();
            session.fail(this.errorMessage(error));
            this.clearWatchdog(id);
            this.fillQueue();
            this.publish();
          }
        }
      }
    } finally {
      this.pumping = false;
      if (lifecycle !== this.lifecycle && !this.stopped && !this.restarting && this.queue.length > 0) {
        void this.pump();
      }
    }
  }

  private canSynchronize(id: string, session: DocumentSession, lifecycle: number): boolean {
    return !this.stopped && !this.restarting && lifecycle === this.lifecycle
      && this.sessions.get(id) === session && this.queue.includes(id);
  }

  private async pumpGoals(): Promise<void> {
    if (this.goalRunning || this.stopped || this.restarting) return;
    const request = this.desiredGoal;
    if (!request || this.goal?.state !== "loading") return;
    const session = this.sessions.get(request.documentId);
    if (!session?.opened || session.readyVersion !== request.version || session.unit.version !== request.version
      || session.unit.mappingEpoch !== request.mappingEpoch) return;
    const epoch = session.epoch;
    this.goalRunning = true;
    const cancellation = new AbortController();
    this.goalCancellation = cancellation;
    try {
      const result = await this.gateway.goals(request.documentId, request.position, cancellation.signal);
      if (this.isCurrentGoal(request, session, epoch)) {
        this.goal = {
          noteId: request.noteId,
          blockId: request.blockId,
          offset: this.desiredGoal!.offset,
          state: "ready",
          goals: [...result.goals],
        };
        this.publish();
      }
    } catch (error) {
      if (this.isCurrentGoal(request, session, epoch)) {
        this.goal = {
          noteId: request.noteId,
          blockId: request.blockId,
          offset: this.desiredGoal!.offset,
          state: "error",
          goals: [],
          message: this.errorMessage(error),
        };
        this.publish();
      }
    } finally {
      if (this.goalCancellation === cancellation) this.goalCancellation = undefined;
      this.goalRunning = false;
      if (this.desiredGoal?.serial !== request.serial) void this.pumpGoals();
    }
  }

  private isCurrentGoal(request: GoalRequest, session: DocumentSession, epoch: number): boolean {
    return !this.stopped && !this.restarting
      && this.desiredGoal?.serial === request.serial
      && this.sessions.get(request.documentId) === session
      && session.opened && session.epoch === epoch && session.unit.version === request.version
      && session.unit.mappingEpoch === request.mappingEpoch;
  }

  private cancelGoal(message?: string): void {
    this.goalCancellation?.abort();
    this.goalSerial += 1;
    this.desiredGoal = null;
    this.goal = message && this.goal
      ? { ...this.goal, state: "unavailable", goals: [], message }
      : null;
  }

  private removeSession(blockId: string): void {
    const session = this.sessions.get(blockId);
    if (!session) return;
    this.removeQueued(blockId);
    this.clearWatchdog(blockId);
    if (this.desiredGoal?.documentId === blockId) this.cancelGoal();
    this.sessions.delete(blockId);
    void this.closeSession(session).then(() => this.pump());
  }

  private removeQueued(blockId: string): void {
    this.queuedByNote.delete(blockId);
    const index = this.queue.indexOf(blockId);
    if (index >= 0) this.queue.splice(index, 1);
  }

  private async closeSession(session: DocumentSession): Promise<void> {
    const wasOpen = session.opened;
    session.closed();
    this.clearWatchdog(session.unit.id);
    if (wasOpen && this.desiredGoal?.documentId === session.unit.id) {
      this.cancelGoal("此块的 Lean 会话已回收；移动光标可重新检查。");
    }
    if (!wasOpen) return;
    try {
      await this.gateway.close(session.unit.id);
    } catch {
      // Closing is best effort; gateway disposal still owns transport cleanup.
    } finally {
      void this.pump();
    }
  }

  private async retireIdle(): Promise<void> {
    if (this.stopped || this.restarting) return;
    const threshold = Date.now() - this.options.idleTimeoutMs;
    for (const session of this.sessions.values()) {
      if (session.opened && !session.processing
        && !session.unit.members.some((block) => block.id === this.activeBlockId) && session.lastUsed < threshold) {
        await this.closeSession(session);
      }
    }
  }

  private startWatchdog(session: DocumentSession): void {
    this.clearWatchdog(session.unit.id);
    const version = session.unit.version;
    const epoch = session.epoch;
    this.syncWatchdogs.set(session.unit.id, setTimeout(() => {
      this.syncWatchdogs.delete(session.unit.id);
      if (!this.stopped && this.sessions.get(session.unit.id) === session
        && session.epoch === epoch && session.unit.version === version && session.processing) {
        session.fail("Lean 检查超过 60 秒；可重试检查或重启服务。");
        void this.closeSession(session).then(() => {
          this.publish();
          void this.pump();
        });
      }
    }, 60_000));
  }

  private clearWatchdog(blockId: string): void {
    const timer = this.syncWatchdogs.get(blockId);
    if (timer) clearTimeout(timer);
    this.syncWatchdogs.delete(blockId);
  }

  private clearAllWatchdogs(): void {
    for (const timer of this.syncWatchdogs.values()) clearTimeout(timer);
    this.syncWatchdogs.clear();
  }

  private publish(): void {
    if (this.stopped || this.listeners.size === 0) return;
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
