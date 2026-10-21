import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LeanDiagnosticsEvent,
  LeanDocument,
  LeanGateway,
  LeanGoals,
  LeanProgressEvent,
  LeanServiceStatus,
  TextPosition,
  Unsubscribe,
} from "../../src/application/contracts";
import { ProofWorkspace } from "../../src/application/ProofWorkspace";

class TestGateway implements LeanGateway {
  readonly opened: LeanDocument[] = [];
  readonly changed: LeanDocument[] = [];
  readonly closed: string[] = [];
  readonly goalCalls: { blockId: string; position: TextPosition }[] = [];
  readonly goalResolvers: ((value: LeanGoals) => void)[] = [];
  readonly closeResolvers: (() => void)[] = [];
  readonly diagnosticsListeners = new Set<(event: LeanDiagnosticsEvent) => void>();
  readonly progressListeners = new Set<(event: LeanProgressEvent) => void>();
  readonly statusListeners = new Set<(event: LeanServiceStatus) => void>();
  deferGoals = false;
  honorGoalCancellation = false;
  holdClose = false;
  disposed = false;

  async open(document: LeanDocument): Promise<void> { this.opened.push(document); }
  async change(document: LeanDocument): Promise<void> { this.changed.push(document); }
  async close(blockId: string): Promise<void> {
    this.closed.push(blockId);
    if (this.holdClose) await new Promise<void>((resolve) => this.closeResolvers.push(resolve));
  }
  async goals(blockId: string, position: TextPosition, signal?: AbortSignal): Promise<LeanGoals> {
    this.goalCalls.push({ blockId, position });
    if (this.deferGoals) return new Promise((resolve, reject) => {
      this.goalResolvers.push(resolve);
      if (this.honorGoalCancellation) {
        if (signal?.aborted) reject(new Error("Goal cancelled"));
        else signal?.addEventListener("abort", () => reject(new Error("Goal cancelled")), { once: true });
      }
    });
    return { goals: ["⊢ True"] };
  }
  onDiagnostics(listener: (event: LeanDiagnosticsEvent) => void): Unsubscribe {
    this.diagnosticsListeners.add(listener);
    return () => this.diagnosticsListeners.delete(listener);
  }
  onProgress(listener: (event: LeanProgressEvent) => void): Unsubscribe {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }
  onStatus(listener: (event: LeanServiceStatus) => void): Unsubscribe {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }
  async restart(): Promise<void> {}
  async dispose(): Promise<void> { this.disposed = true; }
  diagnostics(event: LeanDiagnosticsEvent): void {
    for (const listener of this.diagnosticsListeners) listener(event);
  }
  progress(blockId: string, version: number | null, processing = false): void {
    for (const listener of this.progressListeners) listener({ documentId: blockId, version, processing });
  }
  status(state: LeanServiceStatus["state"]): void {
    for (const listener of this.statusListeners) listener({ state });
  }
}

class TestScenario {
  readonly gateway = new TestGateway();
  readonly workspace: ProofWorkspace;
  text = "```lean\nexample : True := by\n  trivial\n```\n";
  constructor(options: ConstructorParameters<typeof ProofWorkspace>[1] = {}) {
    this.workspace = new ProofWorkspace(this.gateway, options);
    this.workspace.updateNote("Proof.md", this.text);
  }
  get id(): string { return this.workspace.snapshot().blocks[0]!.id; }
  activate(): void { this.workspace.inspectAt("Proof.md", this.text.indexOf("trivial")); }
  edit(value: string): void {
    this.text = this.text.replace(/trivial[0-9]*/, value);
    this.workspace.updateNote("Proof.md", this.text);
  }
  async settle(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
  }
}

describe("ProofWorkspace behavior", () => {
  const scenarios: TestScenario[] = [];
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(async () => {
    for (const scenario of scenarios.splice(0)) await scenario.workspace.dispose();
    vi.useRealTimers();
  });

  it("opens each code block independently and skips display-only examples", async () => {
    const scenario = new TestScenario();
    scenarios.push(scenario);
    scenario.workspace.updateNote("Proof.md", "```lean\ndef n := 1\n```\n```lean4\ndef n := 1\n```\n```lean-off\nbad\n```");
    scenario.workspace.checkNote("Proof.md");
    await scenario.settle();
    expect(scenario.gateway.opened.map((document) => document.code)).toEqual(["def n := 1\n", "def n := 1\n"]);
    expect(new Set(scenario.gateway.opened.map((document) => document.documentId)).size).toBe(2);
  });

  it("does not synchronize Lean again for a prose-only Markdown edit", async () => {
    const scenario = new TestScenario();
    scenarios.push(scenario);
    scenario.activate();
    await vi.advanceTimersByTimeAsync(200);
    scenario.gateway.progress(scenario.id, 1);
    scenario.workspace.updateNote("Proof.md", `Some prose.\n${scenario.text}`);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(scenario.gateway.opened).toHaveLength(1);
    expect(scenario.gateway.changed).toHaveLength(0);
    expect(scenario.workspace.snapshot().blocks[0]!.state).toBe("checked");
  });

  it("updates a fence title without reopening or changing its Lean document", async () => {
    const scenario = new TestScenario();
    scenarios.push(scenario);
    scenario.workspace.checkBlock(scenario.id);
    await scenario.settle();
    scenario.gateway.progress(scenario.id, 1);
    scenario.workspace.updateNote("Proof.md", scenario.text.replace("```lean", '```lean title="自然数 示例"'));
    await vi.advanceTimersByTimeAsync(1_500);
    const block = scenario.workspace.snapshot().blocks[0]!;
    expect(block.title).toBe("自然数 示例");
    expect(block.info).toBe('lean title="自然数 示例"');
    expect(block.version).toBe(1);
    expect(block.state).toBe("checked");
    expect(scenario.gateway.opened).toHaveLength(1);
    expect(scenario.gateway.changed).toHaveLength(0);
    expect(scenario.gateway.closed).toHaveLength(0);
  });

  it("closes a document when checking is disabled and opens a new version when reenabled", async () => {
    const scenario = new TestScenario();
    scenarios.push(scenario);
    const id = scenario.id;
    scenario.workspace.checkBlock(id);
    await scenario.settle();
    scenario.workspace.updateNote("Proof.md", scenario.text.replace("```lean", "```lean check=off"));
    await scenario.settle();
    scenario.gateway.progress(id, 1);
    expect(scenario.gateway.closed).toContain(id);
    expect(scenario.workspace.snapshot().blocks[0]!.state).toBe("display-only");
    expect(scenario.workspace.snapshot().blocks[0]!.version).toBe(2);
    scenario.workspace.updateNote("Proof.md", scenario.text.replace("```lean", "```lean check=on"));
    scenario.workspace.checkBlock(id);
    await scenario.settle();
    expect(scenario.gateway.opened).toHaveLength(2);
    expect(scenario.gateway.opened[1]!.version).toBe(3);
  });

  it("shows malformed metadata and never sends its code to Lean even for a whole-note check", async () => {
    const scenario = new TestScenario();
    scenarios.push(scenario);
    scenario.workspace.updateNote("Proof.md", scenario.text.replace("```lean", "```lean check=unknown"));
    scenario.workspace.checkNote("Proof.md");
    await scenario.settle();
    const block = scenario.workspace.snapshot().blocks[0]!;
    expect(block.state).toBe("display-only");
    expect(block.metadataError).toContain("check=on");
    expect(block.message).toBe(block.metadataError);
    expect(scenario.gateway.opened).toEqual([]);
  });

  it("associates a display-only explanation with its own block instead of the previous goal", async () => {
    const scenario = new TestScenario();
    scenarios.push(scenario);
    scenario.gateway.deferGoals = true;
    const text = scenario.text + "\n" + scenario.text.replace("```lean", '```lean check=off title="展示示例"');
    scenario.workspace.updateNote("Proof.md", text);
    scenario.workspace.inspectAt("Proof.md", text.indexOf("trivial"));
    await vi.advanceTimersByTimeAsync(200);
    const display = scenario.workspace.snapshot().blocks[1]!;
    scenario.workspace.inspectAt("Proof.md", text.lastIndexOf("trivial"));
    expect(scenario.workspace.snapshot().goal?.blockId).toBe(display.id);
    expect(scenario.workspace.snapshot().goal?.state).toBe("unavailable");
    scenario.gateway.goalResolvers[0]!({ goals: ["old goal"] });
    await scenario.settle();
    expect(scenario.workspace.snapshot().goal?.blockId).toBe(display.id);
    expect(scenario.workspace.snapshot().goal?.goals).toEqual([]);
  });

  it.each([true, false])("restarts with resumeActive=%s while respecting the caller's intent", async (resumeActive) => {
    const scenario = new TestScenario();
    scenarios.push(scenario);
    scenario.activate();
    await vi.advanceTimersByTimeAsync(200);
    expect(scenario.gateway.opened).toHaveLength(1);
    if (resumeActive) await scenario.workspace.restart();
    else await scenario.workspace.restart({ resumeActive: false });
    await scenario.settle();
    expect(scenario.gateway.opened).toHaveLength(resumeActive ? 2 : 1);
    if (!resumeActive) {
      scenario.workspace.inspectAt("Proof.md", scenario.text.indexOf("trivial"));
      await vi.advanceTimersByTimeAsync(200);
      expect(scenario.gateway.opened).toHaveLength(2);
    }
  });

  it("automatically checks and inspects the end of an unfinished fenced block", async () => {
    const scenario = new TestScenario();
    scenarios.push(scenario);
    const unfinished = "```lean\nexample : True := by\n  trivial";
    scenario.workspace.updateNote("Proof.md", unfinished);
    scenario.workspace.inspectAt("Proof.md", unfinished.length);
    await vi.advanceTimersByTimeAsync(200);
    expect(scenario.gateway.opened).toHaveLength(1);
    expect(scenario.gateway.goalCalls.at(-1)?.position).toEqual({ line: 1, character: 9 });
    expect(scenario.workspace.snapshot().blocks[0]!.includesEnd).toBe(true);
    scenario.workspace.updateNote("Proof.md", unfinished + "\n");
    scenario.workspace.inspectAt("Proof.md", unfinished.length + 1);
    await vi.advanceTimersByTimeAsync(200);
    expect(scenario.gateway.changed).toHaveLength(1);
    expect(scenario.gateway.goalCalls.at(-1)?.position).toEqual({ line: 2, character: 0 });
  });

  it("flushes continuous editing by maxWait and uses only the latest code", async () => {
    const scenario = new TestScenario({ debounceMs: 200, maxWaitMs: 1_000 });
    scenarios.push(scenario);
    scenario.activate();
    await vi.advanceTimersByTimeAsync(200);
    scenario.gateway.progress(scenario.id, 1);
    for (let index = 1; index <= 12; index += 1) {
      scenario.edit(`trivial${index}`);
      await vi.advanceTimersByTimeAsync(90);
    }
    expect(scenario.gateway.changed.length).toBeGreaterThanOrEqual(1);
    expect(scenario.gateway.changed[0]!.code).toContain("trivial12");
  });

  it("rejects diagnostics and completion from an earlier code version", async () => {
    const scenario = new TestScenario();
    scenarios.push(scenario);
    scenario.activate();
    await vi.advanceTimersByTimeAsync(200);
    const id = scenario.id;
    scenario.edit("trivial1");
    await vi.advanceTimersByTimeAsync(200);
    scenario.gateway.diagnostics({
      documentId: id, version: 1,
      diagnostics: [{ severity: "error", message: "obsolete", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } } }],
    });
    scenario.gateway.progress(id, 1);
    scenario.gateway.progress(id, null);
    expect(scenario.workspace.snapshot().blocks[0]!.diagnostics).toEqual([]);
    expect(scenario.workspace.snapshot().blocks[0]!.state).toBe("checking");
    scenario.gateway.progress(id, 2);
    expect(scenario.workspace.snapshot().blocks[0]!.state).toBe("checked");
  });

  it("does not treat an empty diagnostic notification or unversioned progress as proof completion", async () => {
    const scenario = new TestScenario();
    scenarios.push(scenario);
    scenario.workspace.checkBlock(scenario.id);
    await scenario.settle();
    scenario.gateway.diagnostics({ documentId: scenario.id, version: 1, diagnostics: [] });
    expect(scenario.workspace.snapshot().blocks[0]!.state).toBe("checking");
    scenario.gateway.progress(scenario.id, null);
    expect(scenario.workspace.snapshot().blocks[0]!.state).toBe("idle");
  });

  it("does not hang when checking an already checked unchanged block", async () => {
    const scenario = new TestScenario();
    scenarios.push(scenario);
    scenario.workspace.checkBlock(scenario.id);
    await scenario.settle();
    scenario.gateway.progress(scenario.id, 1);
    scenario.workspace.checkBlock(scenario.id);
    await scenario.settle();
    expect(scenario.workspace.snapshot().blocks[0]!.state).toBe("checked");
    expect(scenario.gateway.opened).toHaveLength(1);
    expect(scenario.gateway.changed).toHaveLength(0);
  });

  it("limits open documents and advances a whole-note check as processing completes", async () => {
    const scenario = new TestScenario({ maxOpenBlocks: 2, maxQueuedBlocks: 2 });
    scenarios.push(scenario);
    scenario.workspace.updateNote("Proof.md", Array.from({ length: 7 }, (_, index) => `\`\`\`lean\ndef n := ${index}\n\`\`\`\n`).join("\n"));
    scenario.workspace.checkNote("Proof.md");
    await scenario.settle();
    expect(scenario.gateway.opened).toHaveLength(2);
    for (let index = 0; index < 7; index += 1) {
      const document = scenario.gateway.opened[index]!;
      scenario.gateway.progress(document.documentId, document.version);
      await scenario.settle();
      expect(scenario.gateway.opened.length - scenario.gateway.closed.length).toBeLessThanOrEqual(2);
    }
    expect(scenario.gateway.opened).toHaveLength(7);
    expect(scenario.workspace.snapshot().blocks.every((block) => block.state === "checked")).toBe(true);
  });

  it("keeps at most one goal request in flight and drops obsolete cursor responses", async () => {
    const scenario = new TestScenario();
    scenarios.push(scenario);
    scenario.gateway.deferGoals = true;
    scenario.activate();
    await vi.advanceTimersByTimeAsync(200);
    const start = scenario.text.indexOf("trivial");
    scenario.workspace.inspectAt("Proof.md", start + 1);
    scenario.workspace.inspectAt("Proof.md", start + 2);
    scenario.workspace.inspectAt("Proof.md", start + 3);
    expect(scenario.gateway.goalCalls).toHaveLength(1);
    scenario.gateway.goalResolvers[0]!({ goals: ["old"] });
    await scenario.settle();
    expect(scenario.gateway.goalCalls).toHaveLength(2);
    expect(scenario.workspace.snapshot().goal?.goals).toEqual([]);
    scenario.gateway.goalResolvers[1]!({ goals: ["current"] });
    await scenario.settle();
    expect(scenario.workspace.snapshot().goal?.goals).toEqual(["current"]);
    expect(scenario.workspace.snapshot().goal?.offset).toBe(start + 3);
  });

  it("retains whole-note work when the active block takes priority in a full queue", async () => {
    const scenario = new TestScenario({ maxOpenBlocks: 1, maxQueuedBlocks: 2 });
    scenarios.push(scenario);
    scenario.workspace.updateNote("Proof.md", Array.from({ length: 6 }, (_, index) => `\`\`\`lean\ndef n := ${index}\n\`\`\`\n`).join("\n"));
    scenario.workspace.checkNote("Proof.md");
    await scenario.settle();
    const lastBlock = scenario.workspace.snapshot().blocks.at(-1)!;
    scenario.workspace.checkBlock(lastBlock.id);
    await scenario.settle();
    for (let index = 0; index < 6; index += 1) {
      const document = scenario.gateway.opened[index]!;
      scenario.gateway.progress(document.documentId, document.version);
      await scenario.settle();
    }
    expect(scenario.gateway.opened[1]!.documentId).toBe(lastBlock.id);
    expect(scenario.workspace.snapshot().blocks.every((block) => block.state === "checked")).toBe(true);
  });

  it("cancels a stalled goal when moving to another block so the new goal starts immediately", async () => {
    const scenario = new TestScenario();
    scenarios.push(scenario);
    scenario.gateway.deferGoals = true;
    scenario.gateway.honorGoalCancellation = true;
    const text = scenario.text + "\n" + scenario.text;
    scenario.workspace.updateNote("Proof.md", text);
    scenario.workspace.inspectAt("Proof.md", text.indexOf("trivial"));
    await vi.advanceTimersByTimeAsync(200);
    expect(scenario.gateway.goalCalls).toHaveLength(1);
    scenario.workspace.inspectAt("Proof.md", text.lastIndexOf("trivial"));
    await vi.advanceTimersByTimeAsync(200);
    expect(scenario.gateway.goalCalls).toHaveLength(2);
    scenario.gateway.goalResolvers[1]!({ goals: ["new block"] });
    await scenario.settle();
    scenario.gateway.goalResolvers[0]!({ goals: ["old block"] });
    await scenario.settle();
    expect(scenario.workspace.snapshot().goal?.goals).toEqual(["new block"]);
  });

  it.each(["close", "restart", "dispose", "disable"] as const)(
    "does not resurrect a queued block after %s while an eviction is waiting",
    async (action) => {
      const scenario = new TestScenario({ maxOpenBlocks: 1 });
      scenarios.push(scenario);
      scenario.workspace.updateNote("Proof.md", scenario.text + "\n" + scenario.text);
      const [first, second] = scenario.workspace.snapshot().blocks;
      scenario.workspace.checkBlock(first!.id);
      await scenario.settle();
      scenario.gateway.progress(first!.id, 1);
      scenario.gateway.holdClose = true;
      scenario.workspace.checkBlock(second!.id);
      await scenario.settle();
      expect(scenario.gateway.closeResolvers).toHaveLength(1);
      if (action === "close") scenario.workspace.closeNote("Proof.md");
      else if (action === "restart") await scenario.workspace.restart();
      else if (action === "disable") {
        scenario.workspace.updateNote("Proof.md", scenario.text + "\n" + scenario.text.replace("```lean", "```lean check=off"));
      }
      else await scenario.workspace.dispose();
      scenario.gateway.holdClose = false;
      scenario.gateway.closeResolvers[0]!();
      await scenario.settle();
      expect(scenario.gateway.opened).toHaveLength(1);
      await scenario.workspace.dispose();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("wakes queued work in another note when a processing note closes", async () => {
    const scenario = new TestScenario({ maxOpenBlocks: 1 });
    scenarios.push(scenario);
    scenario.workspace.updateNote("Other.md", scenario.text);
    const [first, second] = scenario.workspace.snapshot().blocks;
    scenario.workspace.checkBlock(first!.id);
    await scenario.settle();
    scenario.workspace.checkBlock(second!.id);
    await scenario.settle();
    expect(scenario.gateway.opened).toHaveLength(1);
    scenario.workspace.closeNote("Proof.md");
    await scenario.settle();
    expect(scenario.gateway.opened).toHaveLength(2);
    expect(scenario.gateway.opened[1]!.documentId).toBe(second!.id);
    expect(scenario.workspace.snapshot().blocks[0]!.state).toBe("checking");
  });

  it("removes diagnostics when a block is deleted and rejects its pending response", async () => {
    const scenario = new TestScenario();
    scenarios.push(scenario);
    scenario.workspace.checkBlock(scenario.id);
    await scenario.settle();
    const oldId = scenario.id;
    scenario.workspace.updateNote("Proof.md", "prose");
    scenario.gateway.progress(oldId, 1);
    await scenario.settle();
    expect(scenario.workspace.snapshot().blocks).toEqual([]);
    expect(scenario.gateway.closed).toContain(oldId);
  });

  it("settles queued and processing states after a service failure", async () => {
    const scenario = new TestScenario({ maxOpenBlocks: 1 });
    scenarios.push(scenario);
    scenario.workspace.updateNote("Proof.md", scenario.text + scenario.text);
    scenario.workspace.checkNote("Proof.md");
    await scenario.settle();
    scenario.gateway.status("error");
    expect(scenario.workspace.snapshot().blocks.every((block) => block.state === "error")).toBe(true);
  });
});
