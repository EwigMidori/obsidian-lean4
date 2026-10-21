import { App, TFile } from "obsidian";
import { ProofWorkspace } from "../application/ProofWorkspace";
import type { ProofBlockSnapshot, Unsubscribe, WorkspaceSnapshot } from "../application/contracts";
import { LeanLanguageServerGateway } from "../infrastructure/LeanLanguageServerGateway";
import { ManagedLeanEnvironment, type ManagedEnvironmentSnapshot } from "../infrastructure/ManagedLeanEnvironment";
import { LeanSettings } from "./LeanSettings";

interface NoteLease {
  readonly noteId: string;
  readonly editing: boolean;
}

interface OpenNote {
  text: string | null;
  revision: number;
  lineOffsets: number[] | null;
  readonly owners: Set<object>;
}

type ProofIntent =
  | { kind: "inspect"; noteId: string; offset: number }
  | { kind: "block"; blockId: string }
  | { kind: "note"; noteId: string };

/** Owns the Obsidian-to-application lifetime boundary, including split-view leases. */
export class ObsidianProofHost {
  private workspace: ProofWorkspace;
  private workspaceSubscription: Unsubscribe;
  private readonly listeners = new Set<(snapshot: WorkspaceSnapshot) => void>();
  private readonly leases = new Map<object, NoteLease>();
  private readonly notes = new Map<string, OpenNote>();
  private latestSnapshot: WorkspaceSnapshot | null = null;
  private readonly blocksById = new Map<string, ProofBlockSnapshot>();
  private readonly blocksByNote = new Map<string, ProofBlockSnapshot[]>();
  private disposed = false;
  private epoch = 0;
  private configurationTail: Promise<void> = Promise.resolve();
  private reconfiguring = false;
  private readonly environment: ManagedLeanEnvironment;
  private readonly environmentSubscription: Unsubscribe;
  private preparation: Promise<void> | null = null;
  private preparationController: AbortController | null = null;
  private lastIntent: ProofIntent | null = null;

  constructor(private readonly app: App, private settings: LeanSettings) {
    this.settings = LeanSettings.from(settings);
    this.environment = new ManagedLeanEnvironment();
    this.workspace = this.createWorkspace();
    this.workspaceSubscription = this.workspace.subscribe(snapshot => this.publish(snapshot));
    this.environmentSubscription = this.environment.subscribe(() => this.publish(this.snapshot()));
  }

  get usesBasicEnvironment(): boolean {
    return this.settings.environmentMode === "basic";
  }

  get preparingEnvironment(): boolean {
    return this.preparationController !== null;
  }

  environmentSnapshot(): ManagedEnvironmentSnapshot {
    return this.environment.snapshot();
  }

  prepareEnvironment(): Promise<void> {
    if (this.disposed || !this.usesBasicEnvironment) return Promise.resolve();
    if (this.reconfiguring) return this.configurationTail.then(() => this.prepareEnvironment());
    if (this.preparation) return this.preparation;
    const controller = new AbortController();
    this.preparationController = controller;
    const epoch = this.epoch;
    const operation = this.runPreparation(controller, epoch);
    this.preparation = operation.finally(() => {
      if (this.preparationController === controller) {
        this.preparation = null;
        this.preparationController = null;
        this.publish(this.snapshot());
      }
    });
    this.publish(this.snapshot());
    return this.preparation;
  }

  cancelPreparation(): void {
    this.preparationController?.abort();
  }

  snapshot(): WorkspaceSnapshot {
    return this.latestSnapshot ?? this.workspace.snapshot();
  }

  block(blockId: string): ProofBlockSnapshot | undefined {
    return this.blocksById.get(blockId);
  }

  blocksForNote(noteId: string): readonly ProofBlockSnapshot[] {
    return this.blocksByNote.get(noteId) ?? [];
  }

  blocksInSection(noteId: string, firstLine: number, lastLine: number): readonly ProofBlockSnapshot[] {
    const note = this.notes.get(noteId);
    if (!note || note.text === null) return [];
    if (!note.lineOffsets) {
      note.lineOffsets = [0];
      for (let offset = note.text.indexOf("\n"); offset >= 0; offset = note.text.indexOf("\n", offset + 1)) {
        note.lineOffsets.push(offset + 1);
      }
    }
    const from = note.lineOffsets[firstLine] ?? note.text.length;
    const to = note.lineOffsets[lastLine + 1] ?? note.text.length;
    const blocks = this.blocksForNote(noteId);
    let lower = 0;
    let upper = blocks.length;
    while (lower < upper) {
      const middle = (lower + upper) >>> 1;
      if (blocks[middle]!.from < from) lower = middle + 1;
      else upper = middle;
    }
    const matching: ProofBlockSnapshot[] = [];
    for (let index = lower; index < blocks.length && blocks[index]!.from < to; index++) matching.push(blocks[index]!);
    return matching;
  }

  noteText(noteId: string): string | null {
    return this.notes.get(noteId)?.text ?? null;
  }

  subscribe(listener: (snapshot: WorkspaceSnapshot) => void): Unsubscribe {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => { this.listeners.delete(listener); };
  }

  bindEditor(owner: object, noteId: string, text: string): void {
    if (this.disposed) return;
    const note = this.attach(owner, noteId, true);
    if (note.text === text) return;
    note.text = text;
    note.lineOffsets = null;
    note.revision++;
    this.workspace.updateNote(noteId, text);
  }

  async bindReader(owner: object, noteId: string): Promise<void> {
    if (this.disposed) return;
    const note = this.attach(owner, noteId, false);
    if (note.text !== null) return;
    await this.readNote(noteId, note);
  }

  release(owner: object): void {
    const lease = this.leases.get(owner);
    if (!lease) return;
    this.leases.delete(owner);
    const note = this.notes.get(lease.noteId);
    note?.owners.delete(owner);
    if (note && note.owners.size === 0) {
      const intent = this.lastIntent;
      if (intent && (intent.kind === "block"
        ? this.block(intent.blockId)?.noteId === lease.noteId
        : intent.noteId === lease.noteId)) this.lastIntent = null;
      this.notes.delete(lease.noteId);
      this.workspace.closeNote(lease.noteId);
    }
  }

  inspectAt(noteId: string, offset: number): void {
    if (this.disposed) return;
    this.lastIntent = { kind: "inspect", noteId, offset };
    const block = this.blocksForNote(noteId).find(candidate =>
      offset >= candidate.codeFrom && (offset < candidate.codeTo || candidate.includesEnd && offset === candidate.codeTo));
    if (!block || block.displayOnly || this.canCheck()) this.workspace.inspectAt(noteId, offset);
  }

  checkBlock(blockId: string): void {
    if (this.disposed) return;
    this.lastIntent = { kind: "block", blockId };
    if (this.canCheck()) this.workspace.checkBlock(blockId);
  }

  checkNote(noteId: string): void {
    if (this.disposed) return;
    this.lastIntent = { kind: "note", noteId };
    if (this.canCheck()) this.workspace.checkNote(noteId);
  }

  async restart(): Promise<void> {
    if (!this.disposed && this.canCheck()) await this.workspace.restart();
  }

  reconfigure(settings: LeanSettings): Promise<void> {
    const configuration = LeanSettings.from(settings);
    const operation = this.configurationTail.then(() => this.applyConfiguration(configuration));
    this.configurationTail = operation.catch(() => {});
    return operation;
  }

  private async applyConfiguration(settings: LeanSettings): Promise<void> {
    if (this.disposed) return;
    this.reconfiguring = true;
    try {
      this.epoch++;
      this.lastIntent = null;
      this.cancelPreparation();
      await this.preparation?.catch(() => {});
      this.workspaceSubscription();
      await this.workspace.dispose();
      if (this.disposed) return;
      this.settings = settings;
      this.workspace = this.createWorkspace();
      this.workspaceSubscription = this.workspace.subscribe(snapshot => this.publish(snapshot));
      for (const [noteId, note] of this.notes) {
        if (note.text !== null) this.workspace.updateNote(noteId, note.text);
      }
    } finally {
      this.reconfiguring = false;
      this.publish(this.snapshot());
    }
  }

  async refreshFile(file: TFile): Promise<void> {
    const note = this.notes.get(file.path);
    if (!note || this.hasEditor(note)) return;
    await this.readNote(file.path, note);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch++;
    this.lastIntent = null;
    this.cancelPreparation();
    this.environmentSubscription();
    this.workspaceSubscription();
    this.listeners.clear();
    this.leases.clear();
    this.notes.clear();
    this.blocksById.clear();
    this.blocksByNote.clear();
    this.latestSnapshot = null;
    await this.configurationTail;
    await this.preparation?.catch(() => {});
    await this.workspace.dispose();
  }

  private createWorkspace(): ProofWorkspace {
    return new ProofWorkspace(new LeanLanguageServerGateway({
      projectRoot: this.usesBasicEnvironment ? undefined : this.settings.projectRoot,
      lakeExecutable: this.settings.lakeExecutable,
      environment: this.usesBasicEnvironment ? this.environment : undefined
    }), {
      debounceMs: this.settings.debounceMs,
      maxWaitMs: Math.max(this.settings.debounceMs * 4, 1_000),
      maxOpenBlocks: this.settings.maxOpenBlocks,
      idleTimeoutMs: this.settings.idleTimeoutMs
    });
  }

  private attach(owner: object, noteId: string, editing: boolean): OpenNote {
    if (this.leases.get(owner)?.noteId !== noteId) this.release(owner);
    this.leases.set(owner, { noteId, editing });
    let note = this.notes.get(noteId);
    if (!note) {
      note = { text: null, revision: 0, lineOffsets: null, owners: new Set() };
      this.notes.set(noteId, note);
    }
    note.owners.add(owner);
    return note;
  }

  private hasEditor(note: OpenNote): boolean {
    return [...note.owners].some(owner => this.leases.get(owner)?.editing);
  }

  private async readNote(noteId: string, note: OpenNote): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(noteId);
    if (!(file instanceof TFile)) return;
    const revision = note.revision;
    const epoch = this.epoch;
    const text = await this.app.vault.cachedRead(file);
    if (this.disposed || epoch !== this.epoch || this.notes.get(noteId) !== note || note.revision !== revision || this.hasEditor(note)) return;
    if (note.text !== text) {
      note.text = text;
      note.lineOffsets = null;
      note.revision++;
      this.workspace.updateNote(noteId, text);
    }
  }

  private canCheck(): boolean {
    if (this.reconfiguring) return false;
    if (!this.usesBasicEnvironment) return true;
    return !this.preparingEnvironment && !["needs-install", "downloading", "installing", "cancelled", "error"]
      .includes(this.environment.snapshot().state);
  }

  private async runPreparation(controller: AbortController, epoch: number): Promise<void> {
    try {
      await this.environment.prepare(controller.signal);
      if (controller.signal.aborted || this.disposed || epoch !== this.epoch) return;
      await this.workspace.restart({ resumeActive: false });
      if (controller.signal.aborted || this.disposed || epoch !== this.epoch) return;
      const intent = this.lastIntent;
      if (intent?.kind === "inspect") this.workspace.inspectAt(intent.noteId, intent.offset);
      else if (intent?.kind === "block") this.workspace.checkBlock(intent.blockId);
      else if (intent?.kind === "note") this.workspace.checkNote(intent.noteId);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  }

  private publish(snapshot: WorkspaceSnapshot): void {
    if (this.disposed) return;
    this.latestSnapshot = snapshot;
    this.blocksById.clear();
    this.blocksByNote.clear();
    for (const block of snapshot.blocks) {
      this.blocksById.set(block.id, block);
      let noteBlocks = this.blocksByNote.get(block.noteId);
      if (!noteBlocks) {
        noteBlocks = [];
        this.blocksByNote.set(block.noteId, noteBlocks);
      }
      noteBlocks.push(block);
    }
    for (const listener of this.listeners) listener(snapshot);
  }
}
