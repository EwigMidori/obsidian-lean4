import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LeanDiagnosticsEvent,
  LeanDocument,
  LeanGateway,
  LeanGoals,
  LeanProgressEvent,
  LeanServiceStatus,
  ProofBlockSnapshot,
  TextPosition,
  Unsubscribe,
  WorkspaceOptions,
} from "../../src/application/contracts";
import { ProofWorkspace } from "../../src/application/ProofWorkspace";

class SessionGateway implements LeanGateway {
  readonly opened: LeanDocument[] = [];
  readonly changed: LeanDocument[] = [];
  readonly closed: string[] = [];
  readonly goalCalls: { documentId: string; position: TextPosition; signal?: AbortSignal }[] = [];
  readonly goalResolvers: ((goals: LeanGoals) => void)[] = [];
  readonly closeResolvers: (() => void)[] = [];
  private readonly diagnosticListeners = new Set<(event: LeanDiagnosticsEvent) => void>();
  private readonly progressListeners = new Set<(event: LeanProgressEvent) => void>();
  private readonly statusListeners = new Set<(status: LeanServiceStatus) => void>();
  deferGoals = false;
  holdClose = false;

  async open(document: LeanDocument): Promise<void> { this.opened.push(document); }
  async change(document: LeanDocument): Promise<void> { this.changed.push(document); }
  async close(documentId: string): Promise<void> {
    this.closed.push(documentId);
    if (this.holdClose) await new Promise<void>((resolve) => this.closeResolvers.push(resolve));
  }
  async goals(documentId: string, position: TextPosition, signal?: AbortSignal): Promise<LeanGoals> {
    this.goalCalls.push({ documentId, position, signal });
    // Deliberately ignore cancellation: the workspace must reject late replies itself.
    if (this.deferGoals) return new Promise((resolve) => this.goalResolvers.push(resolve));
    return { goals: ["⊢ True"] };
  }
  onDiagnostics(listener: (event: LeanDiagnosticsEvent) => void): Unsubscribe {
    this.diagnosticListeners.add(listener);
    return () => this.diagnosticListeners.delete(listener);
  }
  onProgress(listener: (event: LeanProgressEvent) => void): Unsubscribe {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }
  onStatus(listener: (status: LeanServiceStatus) => void): Unsubscribe {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }
  async restart(): Promise<void> {}
  async dispose(): Promise<void> {}
  diagnostics(event: LeanDiagnosticsEvent): void {
    for (const listener of this.diagnosticListeners) listener(event);
  }
  complete(document: LeanDocument): void {
    for (const listener of this.progressListeners) {
      listener({ documentId: document.documentId, version: document.version, processing: false });
    }
  }
  releaseClosures(): void {
    this.holdClose = false;
    for (const resolve of this.closeResolvers.splice(0)) resolve();
  }
}

class SessionScenario {
  static readonly all: SessionScenario[] = [];
  readonly gateway = new SessionGateway();
  readonly workspace: ProofWorkspace;
  readonly noteId = "Session.md";
  text: string;

  constructor(text: string, options: WorkspaceOptions = {}) {
    this.text = text;
    this.workspace = new ProofWorkspace(this.gateway, options);
    this.workspace.updateNote(this.noteId, text);
    SessionScenario.all.push(this);
  }
  get blocks(): readonly ProofBlockSnapshot[] { return this.workspace.snapshot().blocks; }
  get document(): LeanDocument { return this.gateway.changed.at(-1) ?? this.gateway.opened.at(-1)!; }
  update(text: string): void {
    this.text = text;
    this.workspace.updateNote(this.noteId, text);
  }
  async check(ordinal = 0): Promise<void> {
    this.workspace.checkBlock(this.blocks[ordinal]!.id);
    await this.settle();
  }
  async settle(milliseconds = 0): Promise<void> {
    await vi.advanceTimersByTimeAsync(milliseconds);
  }
  emit(from: number, to: number, message = "test diagnostic"): void {
    const document = this.document;
    this.gateway.diagnostics({
      documentId: document.documentId,
      version: document.version,
      diagnostics: [{
        severity: "error",
        message,
        range: {
          start: SessionScenario.position(document.code, from),
          end: SessionScenario.position(document.code, to),
        },
      }],
    });
  }
  static position(code: string, offset: number): TextPosition {
    const preceding = code.slice(0, offset).split("\n");
    return { line: preceding.length - 1, character: preceding.at(-1)!.length };
  }
  static fence(code: string, info = "lean session=demo"): string {
    return `\`\`\`${info}\n${code}\n\`\`\`\n`;
  }
  static async disposeAll(): Promise<void> {
    for (const scenario of this.all.splice(0)) {
      scenario.gateway.releaseClosures();
      for (const resolve of scenario.gateway.goalResolvers) resolve({ goals: [] });
      await scenario.workspace.dispose();
    }
  }
}

describe("ProofWorkspace session source ownership", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(async () => {
    await SessionScenario.disposeAll();
    vi.useRealTimers();
  });

  it("maps a later member's UTF-16 diagnostic into its own indented CRLF source", async () => {
    const text = [
      "说明",
      "  ```lean session=demo",
      "  def seed := 1",
      "  ```",
      "prose between members",
      "  ```lean session=demo",
      '  #check "😀"; missing',
      "  ```",
    ].join("\r\n");
    const scenario = new SessionScenario(text);
    await scenario.check(1);
    const from = scenario.document.code.indexOf("missing");
    scenario.emit(from, from + "missing".length);
    const [first, second] = scenario.blocks;
    const localStart = second!.code.indexOf("missing");

    expect(first!.diagnostics).toEqual([]);
    expect(second!.diagnostics).toEqual([expect.objectContaining({
      range: {
        start: { line: 0, character: localStart },
        end: { line: 0, character: localStart + 7 },
      },
      from: text.indexOf("missing"),
      to: text.indexOf("missing") + 7,
    })]);
    expect(first!.documentErrorCount).toBe(1);
    expect(second!.documentErrorCount).toBe(1);
    expect(first!.message).toContain("其他代码块");
  });

  it("clips a diagnostic spanning members without assigning Markdown fences or unrelated blocks", async () => {
    const scenario = new SessionScenario(
      SessionScenario.fence("def seed := 1\n#check seed")
      + "Intervening explanation.\n"
      + SessionScenario.fence("#check missing")
      + SessionScenario.fence("#check 0"),
    );
    await scenario.check();
    const from = scenario.document.code.indexOf("#check seed") + 2;
    const to = scenario.document.code.indexOf("#check missing") + 6;
    scenario.emit(from, to, "spanning");
    const [first, second, third] = scenario.blocks;

    expect(first!.diagnostics).toEqual([expect.objectContaining({
      range: {
        start: { line: 1, character: 2 },
        end: { line: 2, character: 0 },
      },
      from: scenario.text.indexOf("#check seed") + 2,
      to: first!.codeTo,
    })]);
    expect(second!.diagnostics).toEqual([expect.objectContaining({
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 6 },
      },
      from: second!.codeFrom,
      to: second!.codeFrom + 6,
    })]);
    expect(third!.diagnostics).toEqual([]);
    expect(scenario.blocks.every((block) => block.documentErrorCount === 1)).toBe(true);
    for (const block of [first!, second!]) {
      const diagnostic = block.diagnostics[0]!;
      expect(scenario.text.slice(diagnostic.from, diagnostic.to)).not.toContain("```");
      expect(scenario.text.slice(diagnostic.from, diagnostic.to)).not.toContain("Intervening");
    }
  });

  it("keeps a half-open range ending at the next member's start in the preceding member", async () => {
    const scenario = new SessionScenario(
      SessionScenario.fence("#check seed") + SessionScenario.fence("#check next"),
    );
    await scenario.check();
    scenario.emit(0, scenario.document.code.indexOf("#check next"));

    expect(scenario.blocks[0]!.diagnostics).toHaveLength(1);
    expect(scenario.blocks[1]!.diagnostics).toEqual([]);
  });

  it("assigns a zero-width diagnostic at a shared boundary only to the following member", async () => {
    const scenario = new SessionScenario(
      SessionScenario.fence("#check seed") + SessionScenario.fence("#check next"),
    );
    await scenario.check();
    const boundary = scenario.document.code.indexOf("#check next");
    scenario.emit(boundary, boundary);
    const [first, second] = scenario.blocks;

    expect(first!.diagnostics).toEqual([]);
    expect(second!.diagnostics).toEqual([expect.objectContaining({
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      from: second!.codeFrom,
      to: second!.codeFrom,
    })]);
  });

  it.each(["", "\n", "\r\n"])("maps an unfinished final member's EOF with suffix %j", async (ending) => {
    const scenario = new SessionScenario(
      SessionScenario.fence("def seed := 1")
      + "```lean session=demo\nexample : True := by\n  trivial"
      + ending,
    );
    scenario.workspace.inspectAt(scenario.noteId, scenario.text.length);
    await scenario.settle(200);
    const final = scenario.blocks[1]!;
    const document = scenario.document;

    expect(final.includesEnd).toBe(true);
    expect(scenario.gateway.goalCalls.at(-1)).toEqual(expect.objectContaining({
      documentId: document.documentId,
      position: SessionScenario.position(document.code, document.code.length),
    }));
    expect(scenario.workspace.snapshot().goal?.blockId).toBe(final.id);
    scenario.emit(document.code.length, document.code.length, "EOF");
    expect(scenario.blocks[0]!.diagnostics).toEqual([]);
    expect(scenario.blocks[1]!.diagnostics).toEqual([expect.objectContaining({
      range: {
        start: SessionScenario.position(final.code, final.code.length),
        end: SessionScenario.position(final.code, final.code.length),
      },
      from: scenario.text.length,
      to: scenario.text.length,
    })]);
  });

  it("keeps diagnostics outside all member ranges at document level", async () => {
    const scenario = new SessionScenario(
      SessionScenario.fence("#check seed") + SessionScenario.fence("#check next"),
    );
    await scenario.check();
    scenario.gateway.diagnostics({
      documentId: scenario.document.documentId,
      version: scenario.document.version,
      diagnostics: [{
        severity: "error",
        message: "document-level failure",
        range: { start: { line: 100, character: 0 }, end: { line: 100, character: 1 } },
      }],
    });

    for (const block of scenario.blocks) {
      expect(block.diagnostics).toEqual([]);
      expect(block.documentDiagnostics?.map((diagnostic) => diagnostic.message)).toEqual(["document-level failure"]);
      expect(block.documentErrorCount).toBe(1);
    }
  });

  it("remaps accepted diagnostics after prose and title edits without synchronizing Lean", async () => {
    const scenario = new SessionScenario(
      SessionScenario.fence("def seed := 1") + SessionScenario.fence("#check missing", 'lean session=demo title="Before"'),
    );
    await scenario.check();
    const from = scenario.document.code.indexOf("missing");
    scenario.emit(from, from + 7);
    scenario.gateway.complete(scenario.document);
    const previous = scenario.blocks[1]!;
    scenario.update("New explanation 😀.\n" + scenario.text.replace('title="Before"', 'title="Longer title"'));
    await scenario.settle(1_500);
    const current = scenario.blocks[1]!;

    expect(current.id).toBe(previous.id);
    expect(current.version).toBe(previous.version);
    expect(current.documentVersion).toBe(previous.documentVersion);
    expect(current.mappingEpoch).toBeGreaterThan(previous.mappingEpoch!);
    expect(current.diagnostics[0]!.from).toBe(scenario.text.indexOf("missing"));
    expect(current.diagnostics[0]!.to).toBe(scenario.text.indexOf("missing") + 7);
    expect(current.state).toBe("checked");
    expect(scenario.gateway.opened).toHaveLength(1);
    expect(scenario.gateway.changed).toEqual([]);
  });

  it("rejects a late goal when identical code moves between named documents", async () => {
    const code = "example : True := by\n  trivial";
    const scenario = new SessionScenario(
      SessionScenario.fence(code, 'lean session=alpha title="First"')
      + SessionScenario.fence(code, 'lean session=beta title="Second"'),
    );
    scenario.gateway.deferGoals = true;
    scenario.workspace.inspectAt(scenario.noteId, scenario.text.indexOf("trivial"));
    await scenario.settle(200);
    const oldAlpha = scenario.blocks.find((block) => block.session === "alpha")!;
    const oldCode = scenario.document.code;
    expect(scenario.gateway.goalCalls).toHaveLength(1);

    scenario.update(
      SessionScenario.fence(code, 'lean session=beta title="First"')
      + SessionScenario.fence(code, 'lean session=alpha title="Second"'),
    );
    const newAlpha = scenario.blocks.find((block) => block.session === "alpha")!;
    expect(newAlpha.documentId).toBe(oldAlpha.documentId);
    expect(newAlpha.documentVersion).toBe(oldAlpha.documentVersion);
    expect(newAlpha.mappingEpoch).toBeGreaterThan(oldAlpha.mappingEpoch!);
    expect(scenario.gateway.goalCalls[0]!.signal?.aborted).toBe(true);
    scenario.workspace.inspectAt(scenario.noteId, scenario.text.lastIndexOf("trivial"));
    scenario.gateway.goalResolvers[0]!({ goals: ["obsolete owner"] });
    await scenario.settle(200);

    expect(scenario.document.code).toBe(oldCode);
    expect(scenario.gateway.changed).toEqual([]);
    expect(scenario.workspace.snapshot().goal?.goals).not.toContain("obsolete owner");
    expect(scenario.gateway.goalCalls).toHaveLength(2);
    scenario.gateway.goalResolvers[1]!({ goals: ["current owner"] });
    await scenario.settle();
    expect(scenario.workspace.snapshot().goal?.blockId).toBe(newAlpha.id);
    expect(scenario.workspace.snapshot().goal?.offset).toBe(scenario.text.lastIndexOf("trivial"));
    expect(scenario.workspace.snapshot().goal?.goals).toEqual(["current owner"]);
  });

  it("rejects a late goal after members reorder even when the generated document is byte-for-byte identical", async () => {
    const short = SessionScenario.fence("#check Nat");
    const long = SessionScenario.fence("#check Nat\n#check Nat");
    const scenario = new SessionScenario(short + long);
    scenario.gateway.deferGoals = true;
    const original = scenario.blocks[0]!;
    scenario.workspace.inspectAt(scenario.noteId, original.codeFrom);
    await scenario.settle(200);
    const document = scenario.document;
    expect(scenario.gateway.goalCalls[0]!.position).toEqual({ line: 0, character: 0 });

    scenario.update(long + short);
    const moved = scenario.blocks[1]!;
    expect(moved.id).toBe(original.id);
    expect(moved.version).toBe(original.version);
    expect(moved.documentId).toBe(original.documentId);
    expect(moved.documentVersion).toBe(original.documentVersion);
    expect(moved.mappingEpoch).toBeGreaterThan(original.mappingEpoch!);
    expect(scenario.blocks.map((block) => block.code).join("")).toBe(document.code);
    scenario.workspace.inspectAt(scenario.noteId, moved.codeFrom);
    scenario.gateway.goalResolvers[0]!({ goals: ["before reorder"] });
    await scenario.settle(200);

    expect(scenario.gateway.goalCalls[0]!.signal?.aborted).toBe(true);
    expect(scenario.gateway.changed).toEqual([]);
    expect(scenario.gateway.goalCalls).toHaveLength(2);
    expect(scenario.gateway.goalCalls[1]!.position).toEqual({ line: 2, character: 0 });
    expect(scenario.workspace.snapshot().goal?.goals).not.toContain("before reorder");
    scenario.gateway.goalResolvers[1]!({ goals: ["after reorder"] });
    await scenario.settle();
    expect(scenario.workspace.snapshot().goal?.blockId).toBe(original.id);
    expect(scenario.workspace.snapshot().goal?.offset).toBe(moved.codeFrom);
    expect(scenario.workspace.snapshot().goal?.goals).toEqual(["after reorder"]);
  });

  it.each(["delete", "disable", "restart"] as const)(
    "does not reopen a queued shared document after %s during an awaited eviction",
    async (action) => {
      const alpha = SessionScenario.fence("def a := 1", "lean session=alpha")
        + SessionScenario.fence("#check a", "lean session=alpha");
      const beta = SessionScenario.fence("def b := 2", "lean session=beta")
        + SessionScenario.fence("#check b", "lean session=beta");
      const scenario = new SessionScenario(alpha + beta, { maxOpenBlocks: 1 });
      await scenario.check();
      scenario.gateway.complete(scenario.document);
      scenario.gateway.holdClose = true;
      scenario.workspace.checkBlock(scenario.blocks[3]!.id);
      await scenario.settle();
      expect(scenario.gateway.closeResolvers).toHaveLength(1);

      if (action === "delete") scenario.update(alpha);
      else if (action === "disable") scenario.update(alpha + beta.replaceAll("session=beta", "session=beta check=off"));
      else await scenario.workspace.restart({ resumeActive: false });
      scenario.gateway.releaseClosures();
      await scenario.settle(1_500);

      expect(scenario.gateway.opened).toHaveLength(1);
      expect(scenario.gateway.changed).toEqual([]);
      if (action === "delete") expect(scenario.blocks).toHaveLength(2);
      if (action === "disable") expect(scenario.blocks.slice(2).every((block) => block.state === "display-only")).toBe(true);
      await scenario.workspace.dispose();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("retires one shared document once and reopens it from either member", async () => {
    const scenario = new SessionScenario(
      SessionScenario.fence("def seed := 1") + SessionScenario.fence("#check seed"),
      { idleTimeoutMs: 1_000 },
    );
    await scenario.check();
    const firstDocument = scenario.document;
    scenario.gateway.complete(firstDocument);
    await scenario.settle(2_001);
    expect(scenario.gateway.closed).toEqual([firstDocument.documentId]);

    scenario.workspace.inspectAt(scenario.noteId, scenario.text.lastIndexOf("#check seed"));
    await scenario.settle(200);
    expect(scenario.gateway.opened).toHaveLength(2);
    expect(scenario.gateway.opened[1]).toEqual(firstDocument);
    expect(scenario.gateway.goalCalls.at(-1)?.documentId).toBe(firstDocument.documentId);
    expect(scenario.blocks[0]!.documentId).toBe(scenario.blocks[1]!.documentId);
  });
});
