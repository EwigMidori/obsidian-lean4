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
  failOpen = false;
  private readonly diagnosticsListeners = new Set<(event: LeanDiagnosticsEvent) => void>();
  private readonly progressListeners = new Set<(event: LeanProgressEvent) => void>();
  private readonly statusListeners = new Set<(event: LeanServiceStatus) => void>();

  async open(document: LeanDocument): Promise<void> {
    this.opened.push(document);
    if (this.failOpen) throw new Error("Cannot open Lean document");
  }
  async change(document: LeanDocument): Promise<void> { this.changed.push(document); }
  async close(documentId: string): Promise<void> { this.closed.push(documentId); }
  async goals(_documentId: string, _position: TextPosition): Promise<LeanGoals> { return { goals: [] }; }
  async restart(): Promise<void> {}
  async dispose(): Promise<void> {}
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
  complete(document: LeanDocument): void {
    for (const listener of this.progressListeners) {
      listener({ documentId: document.documentId, version: document.version, processing: false });
    }
  }
  report(document: LeanDocument, token: string, message: string): void {
    const offset = document.code.indexOf(token);
    if (offset < 0) throw new Error(`Missing diagnostic token: ${token}`);
    const lines = document.code.slice(0, offset).split("\n");
    const start = { line: lines.length - 1, character: lines.at(-1)!.length };
    const event: LeanDiagnosticsEvent = {
      documentId: document.documentId,
      version: document.version,
      diagnostics: [{
        severity: "error",
        message,
        range: { start, end: { ...start, character: start.character + token.length } },
      }],
    };
    for (const listener of this.diagnosticsListeners) listener(event);
  }
}

class SharedScenario {
  readonly gateway = new SessionGateway();
  readonly workspace: ProofWorkspace;

  constructor(options: WorkspaceOptions = {}) {
    this.workspace = new ProofWorkspace(this.gateway, { maxOpenBlocks: 8, ...options });
  }

  block(code: string, info = "lean session=demo"): string {
    return `\`\`\`${info}\n${code}\n\`\`\`\n`;
  }

  blocks(noteId = "Proof.md"): readonly ProofBlockSnapshot[] {
    return this.workspace.snapshot().blocks.filter((block) => block.noteId === noteId);
  }

  async settle(delay = 0): Promise<void> {
    await vi.advanceTimersByTimeAsync(delay);
  }
}

describe("ProofWorkspace named sessions", () => {
  const scenarios: SharedScenario[] = [];
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(async () => {
    for (const scenario of scenarios.splice(0)) await scenario.workspace.dispose();
    vi.useRealTimers();
  });

  it("checks any member and the whole note through one ordered Lean document", async () => {
    const scenario = new SharedScenario();
    scenarios.push(scenario);
    const text = scenario.block("def double (n : Nat) := n + n")
      + "\nThis explanation is ordinary Markdown.\n\n"
      + scenario.block("example : double 3 = 6 := by rfl");
    scenario.workspace.updateNote("Proof.md", text);
    const second = scenario.blocks()[1]!;
    scenario.workspace.checkBlock(second.id);
    await scenario.settle();
    scenario.workspace.checkNote("Proof.md");
    await scenario.settle();

    expect(scenario.gateway.opened).toHaveLength(1);
    const document = scenario.gateway.opened[0]!;
    expect(document.code).toContain("def double (n : Nat) := n + n");
    expect(document.code).toContain("example : double 3 = 6 := by rfl");
    expect(document.code.indexOf("def double")).toBeLessThan(document.code.indexOf("example"));
    expect(document.code).not.toContain("ordinary Markdown");
    expect(scenario.blocks().map((block) => block.documentId)).toEqual([document.documentId, document.documentId]);
    expect(scenario.blocks().every((block) => block.documentBlockCount === 2)).toBe(true);
    scenario.gateway.complete(document);
    expect(scenario.blocks().every((block) => block.state === "checked")).toBe(true);
  });

  it("keeps named sessions local to a note and untagged blocks independent", async () => {
    const scenario = new SharedScenario();
    scenarios.push(scenario);
    const shared = scenario.block("def value := 1") + scenario.block("#check value");
    scenario.workspace.updateNote("Proof.md", shared
      + scenario.block("def value := 2", "lean")
      + scenario.block("def value := 3", "lean"));
    scenario.workspace.updateNote("Other.md", shared);
    scenario.workspace.checkNote("Proof.md");
    scenario.workspace.checkNote("Other.md");
    await scenario.settle();

    const firstNote = scenario.blocks();
    const otherNote = scenario.blocks("Other.md");
    expect(firstNote[0]!.documentId).toBe(firstNote[1]!.documentId);
    expect(otherNote[0]!.documentId).toBe(otherNote[1]!.documentId);
    expect(otherNote[0]!.documentId).not.toBe(firstNote[0]!.documentId);
    expect(new Set([firstNote[0]!.documentId, firstNote[2]!.documentId, firstNote[3]!.documentId]).size).toBe(3);
    expect(new Set(scenario.gateway.opened.map((document) => document.documentId)).size).toBe(4);
  });

  it("clears downstream results and automatically rechecks the group after an upstream edit", async () => {
    const scenario = new SharedScenario();
    scenarios.push(scenario);
    const text = scenario.block("def value := 1") + scenario.block("example : value = 1 := by rfl");
    scenario.workspace.updateNote("Proof.md", text);
    scenario.workspace.checkBlock(scenario.blocks()[1]!.id);
    await scenario.settle();
    const previous = scenario.gateway.opened[0]!;
    scenario.gateway.report(previous, "rfl", "Previous result");
    scenario.gateway.complete(previous);
    expect(scenario.blocks()[1]!.diagnostics).toHaveLength(1);

    scenario.workspace.updateNote("Proof.md", text.replace("def value := 1", "def value := 2"));
    expect(scenario.blocks().every((block) => block.diagnostics.length === 0 && block.state !== "checked")).toBe(true);
    await scenario.settle(200);
    expect(scenario.gateway.changed).toHaveLength(1);
    const current = scenario.gateway.changed[0]!;
    expect(current.documentId).toBe(previous.documentId);
    expect(current.version).toBeGreaterThan(previous.version);
    expect(current.code).toContain("def value := 2");
    scenario.gateway.report(previous, "rfl", "Obsolete result");
    scenario.gateway.complete(previous);
    expect(scenario.blocks().every((block) => block.diagnostics.length === 0 && block.state === "checking")).toBe(true);
    scenario.gateway.complete(current);
    expect(scenario.blocks().every((block) => block.state === "checked")).toBe(true);
  });

  it("excludes disabled or malformed members from the shared context", async () => {
    const scenario = new SharedScenario();
    scenarios.push(scenario);
    scenario.workspace.updateNote("Proof.md",
      scenario.block("def included := 1")
      + scenario.block("def demonstration := 2", "lean session=demo check=off")
      + scenario.block("def malformed := 3", "lean session=demo check=perhaps")
      + scenario.block("#check included"));
    scenario.workspace.checkNote("Proof.md");
    await scenario.settle();
    expect(scenario.gateway.opened).toHaveLength(1);
    expect(scenario.gateway.opened[0]!.code).toContain("def included := 1");
    expect(scenario.gateway.opened[0]!.code).not.toContain("demonstration");
    expect(scenario.gateway.opened[0]!.code).not.toContain("malformed");
    expect(scenario.blocks()[0]!.documentBlockCount).toBe(2);
    expect(scenario.blocks().slice(1, 3).every((block) => block.state === "display-only" && !block.documentId)).toBe(true);
  });

  it("updates both groups when a member moves and closes a group after its last member is removed", async () => {
    const scenario = new SharedScenario();
    scenarios.push(scenario);
    const first = scenario.block("def first := 1", "lean session=alpha");
    const moving = scenario.block("def moving := 2", "lean session=alpha");
    const second = scenario.block("def second := 3", "lean session=beta");
    scenario.workspace.updateNote("Proof.md", first + moving + second);
    scenario.workspace.checkNote("Proof.md");
    await scenario.settle();
    const alphaId = scenario.blocks()[0]!.documentId!;
    const betaId = scenario.blocks()[2]!.documentId!;
    for (const document of scenario.gateway.opened) scenario.gateway.complete(document);

    scenario.workspace.updateNote("Proof.md", first + moving.replace("session=alpha", "session=beta") + second);
    await scenario.settle(200);
    const moved = scenario.blocks();
    expect(moved[0]!.documentId).toBe(alphaId);
    expect(moved[1]!.documentId).toBe(betaId);
    expect(moved[2]!.documentId).toBe(betaId);
    const alphaChange = [...scenario.gateway.changed].reverse().find((document) => document.documentId === alphaId)!;
    const betaChange = [...scenario.gateway.changed].reverse().find((document) => document.documentId === betaId)!;
    expect(alphaChange.code).not.toContain("def moving");
    expect(betaChange.code.indexOf("def moving")).toBeLessThan(betaChange.code.indexOf("def second"));

    scenario.workspace.updateNote("Proof.md", moving.replace("session=alpha", "session=beta") + second);
    await scenario.settle();
    expect(scenario.gateway.closed).toContain(alphaId);
    expect(scenario.blocks().every((block) => block.documentId === betaId)).toBe(true);
  });

  it("removes a newly disabled member and checks it separately when reenabled under another name", async () => {
    const scenario = new SharedScenario();
    scenarios.push(scenario);
    const first = scenario.block("def first := 1");
    const second = scenario.block("def second := 2");
    scenario.workspace.updateNote("Proof.md", first + second);
    scenario.workspace.checkNote("Proof.md");
    await scenario.settle();
    const original = scenario.gateway.opened[0]!;
    scenario.gateway.complete(original);

    scenario.workspace.updateNote("Proof.md", first + second.replace("session=demo", "session=demo check=off"));
    await scenario.settle(200);
    expect(scenario.blocks()[0]!.documentId).toBe(original.documentId);
    expect(scenario.blocks()[0]!.documentBlockCount).toBe(1);
    expect(scenario.blocks()[1]!.state).toBe("display-only");
    expect(scenario.blocks()[1]!.documentId).toBeUndefined();
    expect(scenario.gateway.changed.at(-1)!.code).not.toContain("def second");
    scenario.gateway.report(original, "def second", "Disabled member's obsolete result");
    expect(scenario.blocks().every((block) => block.diagnostics.length === 0)).toBe(true);

    scenario.workspace.updateNote("Proof.md", first + second.replace("session=demo", "session=renamed"));
    scenario.workspace.checkBlock(scenario.blocks()[1]!.id);
    await scenario.settle();
    const separate = scenario.gateway.opened.at(-1)!;
    expect(separate.documentId).not.toBe(original.documentId);
    expect(separate.code).toContain("def second");
    expect(separate.code).not.toContain("def first");
    expect(scenario.blocks()[1]!.session).toBe("renamed");
  });

  it("remaps existing results after prose or title edits without synchronizing Lean again", async () => {
    const scenario = new SharedScenario();
    scenarios.push(scenario);
    const text = scenario.block("def value := 1", 'lean session=demo title="Definition"')
      + "\nExplanation.\n\n"
      + scenario.block("example : value = 1 := by rfl");
    scenario.workspace.updateNote("Proof.md", text);
    scenario.workspace.checkNote("Proof.md");
    await scenario.settle();
    const document = scenario.gateway.opened[0]!;
    scenario.gateway.report(document, "rfl", "Existing result");
    scenario.gateway.complete(document);
    const oldSecond = scenario.blocks()[1]!;

    const edited = "A new introduction.\n\n" + text.replace('title="Definition"', 'title="A longer title"');
    scenario.workspace.updateNote("Proof.md", edited);
    await scenario.settle(1_500);
    const newSecond = scenario.blocks()[1]!;
    expect(scenario.gateway.opened).toHaveLength(1);
    expect(scenario.gateway.changed).toHaveLength(0);
    expect(scenario.gateway.closed).toHaveLength(0);
    expect(newSecond.documentVersion).toBe(oldSecond.documentVersion);
    expect(newSecond.mappingEpoch).toBeGreaterThan(oldSecond.mappingEpoch!);
    expect(newSecond.state).toBe("checked");
    expect(newSecond.diagnostics[0]!.from).toBe(edited.indexOf("rfl"));
    expect(newSecond.diagnostics[0]!.from).toBeGreaterThan(oldSecond.diagnostics[0]!.from);
  });

  it("spends worker and queue capacity per session instead of per member", async () => {
    const scenario = new SharedScenario({ maxOpenBlocks: 1, maxQueuedBlocks: 1 });
    scenarios.push(scenario);
    const text = Array.from({ length: 4 }, (_, group) =>
      Array.from({ length: 5 }, (_, member) =>
        scenario.block(`def member${member} := ${group + member}`, `lean session=group${group}`),
      ).join("\n"),
    ).join("\n");
    scenario.workspace.updateNote("Proof.md", text);
    scenario.workspace.checkNote("Proof.md");
    await scenario.settle();
    expect(scenario.gateway.opened).toHaveLength(1);
    for (let index = 0; index < 4; index += 1) {
      const document = scenario.gateway.opened[index]!;
      expect(document).toBeDefined();
      expect(document.code.match(/def member/g)).toHaveLength(5);
      scenario.gateway.complete(document);
      await scenario.settle();
      expect(scenario.gateway.opened.length - scenario.gateway.closed.length).toBeLessThanOrEqual(1);
    }
    expect(scenario.gateway.opened).toHaveLength(4);
    expect(scenario.blocks()).toHaveLength(20);
    expect(scenario.blocks().every((block) => block.state === "checked")).toBe(true);
  });

  it("keeps a whole-note check pending when a queued session changes before its turn", async () => {
    const scenario = new SharedScenario({ maxOpenBlocks: 1, maxQueuedBlocks: 8 });
    scenarios.push(scenario);
    const first = scenario.block("def first := 1", "lean session=first");
    const second = scenario.block("def pending := 2", "lean session=pending");
    scenario.workspace.updateNote("Proof.md", first + second);
    scenario.workspace.checkNote("Proof.md");
    await scenario.settle();
    expect(scenario.gateway.opened).toHaveLength(1);
    expect(scenario.blocks()[1]!.state).toBe("queued");

    scenario.workspace.updateNote("Proof.md", first + second.replace("pending := 2", "pending := 3"));
    scenario.gateway.complete(scenario.gateway.opened[0]!);
    await scenario.settle(200);
    expect(scenario.gateway.opened).toHaveLength(2);
    const latest = scenario.gateway.opened[1]!;
    expect(latest.code).toContain("def pending := 3");
    expect(latest.code).not.toContain("def pending := 2");
    scenario.gateway.complete(latest);
    expect(scenario.blocks().every((block) => block.state === "checked")).toBe(true);
  });

  it("keeps a queued member's check intent when its session is renamed", async () => {
    const scenario = new SharedScenario({ maxOpenBlocks: 1, maxQueuedBlocks: 8 });
    scenarios.push(scenario);
    const first = scenario.block("def first := 1", "lean session=first");
    const second = scenario.block("def pending := 2", "lean session=pending");
    scenario.workspace.updateNote("Proof.md", first + second);
    scenario.workspace.checkNote("Proof.md");
    await scenario.settle();
    expect(scenario.blocks()[1]!.state).toBe("queued");
    const oldDocumentId = scenario.blocks()[1]!.documentId;

    scenario.workspace.updateNote("Proof.md", first + second.replace("session=pending", "session=renamed"));
    scenario.gateway.complete(scenario.gateway.opened[0]!);
    await scenario.settle(200);
    expect(scenario.gateway.opened).toHaveLength(2);
    const renamed = scenario.gateway.opened[1]!;
    expect(renamed.documentId).not.toBe(oldDocumentId);
    expect(renamed.code).toContain("def pending := 2");
    expect(scenario.blocks()[1]!.session).toBe("renamed");
    scenario.gateway.complete(renamed);
    expect(scenario.blocks().every((block) => block.state === "checked")).toBe(true);
  });

  it("retains every whole-note session when an unqueued final group moves to the front", async () => {
    const scenario = new SharedScenario({ maxOpenBlocks: 1, maxQueuedBlocks: 1 });
    scenarios.push(scenario);
    const groups = Array.from({ length: 5 }, (_, index) =>
      scenario.block(`def group${index + 1} := ${index + 1}`, `lean session=g${index + 1}`),
    );
    scenario.workspace.updateNote("Proof.md", groups.join("\n"));
    scenario.workspace.checkNote("Proof.md");
    await scenario.settle();
    expect(scenario.gateway.opened).toHaveLength(1);
    expect(scenario.blocks()[0]!.state).toBe("checking");
    expect(scenario.blocks()[1]!.state).toBe("queued");
    expect(scenario.blocks()[4]!.state).toBe("idle");

    scenario.workspace.updateNote("Proof.md", [groups[4]!, ...groups.slice(0, 4)].join("\n"));
    for (let index = 0; index < 5; index += 1) {
      const document = scenario.gateway.opened[index];
      expect(document).toBeDefined();
      scenario.gateway.complete(document!);
      await scenario.settle(200);
    }
    expect(scenario.gateway.opened).toHaveLength(5);
    expect(new Set(scenario.gateway.opened.map((document) => document.documentId)).size).toBe(5);
    expect(scenario.blocks().every((block) => block.state === "checked")).toBe(true);
  });

  it("settles a whole-note check after individual open failures without retrying on prose edits", async () => {
    const scenario = new SharedScenario();
    scenarios.push(scenario);
    scenario.gateway.failOpen = true;
    const text = scenario.block("def first := 1", "lean session=first")
      + scenario.block("def second := 2", "lean session=second");
    scenario.workspace.updateNote("Proof.md", text);
    scenario.workspace.checkNote("Proof.md");
    await scenario.settle();
    expect(scenario.gateway.opened).toHaveLength(2);
    expect(scenario.blocks().map((block) => block.state)).toEqual(["error", "error"]);

    scenario.workspace.updateNote("Proof.md", "An added explanation.\n\n" + text);
    await scenario.settle(1_500);
    expect(scenario.gateway.opened).toHaveLength(2);
    expect(scenario.blocks().map((block) => block.state)).toEqual(["error", "error"]);
  });
});
