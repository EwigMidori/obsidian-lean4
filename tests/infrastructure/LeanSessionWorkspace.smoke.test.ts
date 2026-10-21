import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ProofWorkspace } from "../../src/application/ProofWorkspace";
import type { ProofBlockSnapshot, WorkspaceSnapshot } from "../../src/application/contracts";
import { LeanLanguageServerGateway } from "../../src/infrastructure/LeanLanguageServerGateway";

class SessionWorkspaceObservation {
  readonly gateway = new LeanLanguageServerGateway({ projectRoot: resolve("tests/fixtures/lean project") });
  readonly workspace = new ProofWorkspace(this.gateway, {
    maxOpenBlocks: 4,
    maxQueuedBlocks: 4,
    debounceMs: 10,
    maxWaitMs: 40,
  });

  async until(predicate: (snapshot: WorkspaceSnapshot) => boolean): Promise<WorkspaceSnapshot> {
    const started = Date.now();
    while (Date.now() - started < 30_000) {
      const snapshot = this.workspace.snapshot();
      if (predicate(snapshot)) return snapshot;
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 20));
    }
    throw new Error(`Session workspace condition timed out: ${JSON.stringify(this.workspace.snapshot())}\n${this.gateway.recentLog()}`);
  }

  block(noteId: string, title: string): ProofBlockSnapshot {
    const block = this.workspace.snapshot().blocks.find((candidate) => candidate.noteId === noteId && candidate.title === title);
    if (!block) throw new Error(`Missing block ${noteId}/${title}.`);
    return block;
  }

  hasErrors(block: ProofBlockSnapshot): boolean {
    return block.diagnostics.some((diagnostic) => diagnostic.severity === "error");
  }

  allChecked(snapshot: WorkspaceSnapshot): boolean {
    return snapshot.blocks.length > 0 && snapshot.blocks.every((block) => block.state === "checked" || block.state === "display-only");
  }
}

describe.skipIf(process.env.LEAN_SMOKE !== "1")("real Lean named sessions through the workspace", () => {
  it("shares definitions in note order, maps goals and errors, rechecks downstream edits, and isolates other documents", async () => {
    const observation = new SessionWorkspaceObservation();
    let text = [
      "# 同一笔记中的证明 😀",
      '```lean session=lesson title="definitions"',
      "import Std",
      "def double (n : Nat) : Nat := n + n",
      "```",
      "不同 session 可以复用相同名字。",
      '```lean session=other title="other session"',
      "def double (n : Nat) : Nat := n + 100",
      "example : double 2 = 102 := by rfl",
      "```",
      '```lean session=lesson check=off title="excluded"',
      "def hidden : Nat := 99",
      "def double (n : Nat) : Nat := 123",
      "```",
      '```lean session=lesson title="dependent proof"',
      "example : double 2 = 4 := by",
      "  rfl",
      "```",
      '```lean title="independent"',
      "#check double",
      "```",
      '```lean session=lesson title="excluded lookup"',
      "#check hidden",
      "```",
      "",
    ].join("\n");
    const otherNote = [
      '```lean session=lesson title="other note definitions"',
      "def double (n : Nat) : Nat := n * 3",
      "```",
      '```lean session=lesson title="other note proof"',
      "example : double 2 = 6 := by",
      "  rfl",
      "```",
      "",
    ].join("\n");
    try {
      observation.workspace.updateNote("Session A.md", text);
      observation.workspace.updateNote("Session B.md", otherNote);

      // Checking a later member first must use current source order, not click history.
      observation.workspace.checkBlock(observation.block("Session A.md", "dependent proof").id);
      await observation.until(() => observation.block("Session A.md", "dependent proof").state === "checked");
      expect(observation.hasErrors(observation.block("Session A.md", "definitions"))).toBe(false);
      expect(observation.hasErrors(observation.block("Session A.md", "dependent proof"))).toBe(false);

      observation.workspace.checkNote("Session B.md");
      observation.workspace.checkNote("Session A.md");
      await observation.until((snapshot) => observation.allChecked(snapshot));
      expect(observation.hasErrors(observation.block("Session A.md", "other session"))).toBe(false);
      expect(observation.hasErrors(observation.block("Session B.md", "other note proof"))).toBe(false);
      expect(observation.block("Session A.md", "excluded").state).toBe("display-only");

      const independent = observation.block("Session A.md", "independent");
      const unknownBase = independent.diagnostics.find((diagnostic) => diagnostic.severity === "error");
      expect(unknownBase).toBeDefined();
      expect(text.slice(unknownBase!.from, unknownBase!.to)).toBe("double");
      const excludedLookup = observation.block("Session A.md", "excluded lookup");
      const unknownHidden = excludedLookup.diagnostics.find((diagnostic) => diagnostic.severity === "error");
      expect(unknownHidden).toBeDefined();
      expect(text.slice(unknownHidden!.from, unknownHidden!.to)).toBe("hidden");

      const proofBefore = observation.block("Session A.md", "dependent proof");
      const proofOffset = text.indexOf("  rfl", text.indexOf('title="dependent proof"')) + 2;
      observation.workspace.inspectAt("Session A.md", proofOffset);
      const goals = await observation.until((snapshot) => snapshot.goal?.blockId === proofBefore.id && snapshot.goal.state === "ready");
      expect(goals.goal!.goals.join("\n")).toContain("double 2 = 4");
      expect(goals.goal!.offset).toBe(proofOffset);

      text = text.replace("def double (n : Nat) : Nat := n + n", "def double (n : Nat) : Nat := n + n + 1");
      observation.workspace.updateNote("Session A.md", text);
      await observation.until(() => observation.block("Session A.md", "dependent proof").state === "checked"
        && observation.hasErrors(observation.block("Session A.md", "dependent proof")));
      const proofAfter = observation.block("Session A.md", "dependent proof");
      expect(proofAfter.id).toBe(proofBefore.id);
      expect(proofAfter.version).toBe(proofBefore.version);
      expect(proofAfter.documentVersion).toBeGreaterThan(proofBefore.documentVersion!);
      const failedProof = proofAfter.diagnostics.find((diagnostic) => diagnostic.severity === "error");
      expect(text.slice(failedProof!.from, failedProof!.to)).toContain("rfl");
      expect(observation.hasErrors(observation.block("Session A.md", "other session"))).toBe(false);
      expect(observation.hasErrors(observation.block("Session B.md", "other note proof"))).toBe(false);

      text = text.replace("example : double 2 = 4 := by", "example : double 2 = 5 := by");
      observation.workspace.updateNote("Session A.md", text);
      await observation.until(() => observation.block("Session A.md", "dependent proof").state === "checked"
        && !observation.hasErrors(observation.block("Session A.md", "dependent proof")));

      const lateImport = [
        '```lean session=imports title="before import"',
        "def earlier : Nat := 1",
        "```",
        '```lean session=imports title="late import"',
        "import Std",
        "```",
        "",
      ].join("\n");
      observation.workspace.updateNote("Imports.md", lateImport);
      observation.workspace.checkNote("Imports.md");
      await observation.until(() => observation.block("Imports.md", "late import").state === "checked"
        && observation.hasErrors(observation.block("Imports.md", "late import")));
      const importError = observation.block("Imports.md", "late import").diagnostics.find((diagnostic) => diagnostic.severity === "error");
      expect(lateImport.slice(importError!.from, importError!.to)).toContain("import");
    } finally {
      await observation.workspace.dispose();
    }
  }, 90_000);
});
