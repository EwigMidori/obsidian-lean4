import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ProofWorkspace } from "../../src/application/ProofWorkspace";
import type { WorkspaceSnapshot } from "../../src/application/contracts";
import { LeanLanguageServerGateway } from "../../src/infrastructure/LeanLanguageServerGateway";

class WorkspaceObservation {
  readonly gateway = new LeanLanguageServerGateway({ projectRoot: resolve("tests/fixtures/lean project") });
  readonly workspace = new ProofWorkspace(this.gateway, { maxOpenBlocks: 2, maxQueuedBlocks: 2, debounceMs: 10 });

  async until(predicate: (snapshot: WorkspaceSnapshot) => boolean): Promise<WorkspaceSnapshot> {
    const started = Date.now();
    while (Date.now() - started < 30_000) {
      const snapshot = this.workspace.snapshot();
      if (predicate(snapshot)) return snapshot;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
    throw new Error(`Workspace condition timed out: ${JSON.stringify(this.workspace.snapshot())}\n${this.gateway.recentLog()}`);
  }
}

describe.skipIf(process.env.LEAN_SMOKE !== "1")("real Lean workspace", () => {
  it("checks an entire note with bounded sessions, preserves warnings, and inspects the current goal", async () => {
    const observation = new WorkspaceObservation();
    const proof = "```lean\nexample (n : Nat) : n = n := by\n  rfl\n```\n";
    const text = [
      proof,
      "```lean\ndef shared : Nat := 1\n```\n",
      "```lean\ndef shared : Nat := 2\n```\n",
      "```lean\nexample : True := by\n  sorry\n```\n",
      "```lean\n#check shared\n```\n",
      "```lean-example\nexample : incomplete\n```\n",
    ].join("\n");
    try {
      observation.workspace.updateNote("Proof.md", text);
      observation.workspace.checkNote("Proof.md");
      const checked = await observation.until((snapshot) =>
        snapshot.blocks.every((block) => block.state === "checked" || block.state === "display-only"),
      );
      expect(checked.blocks[1]!.diagnostics.some((diagnostic) => diagnostic.severity === "error")).toBe(false);
      expect(checked.blocks[2]!.diagnostics.some((diagnostic) => diagnostic.severity === "error")).toBe(false);
      expect(checked.blocks[3]!.diagnostics.some((diagnostic) => diagnostic.message.includes("sorry"))).toBe(true);
      expect(checked.blocks[4]!.diagnostics.some((diagnostic) => diagnostic.severity === "error")).toBe(true);
      expect(checked.blocks[5]!.state).toBe("display-only");
      observation.workspace.inspectAt("Proof.md", text.indexOf("rfl"));
      const goal = await observation.until((snapshot) => snapshot.goal?.state === "ready");
      expect(goal.goal!.goals.join("\n")).toContain("n = n");

      const moved = "Added prose.\n" + text;
      observation.workspace.updateNote("Proof.md", moved);
      observation.workspace.inspectAt("Proof.md", moved.indexOf("rfl"));
      const remapped = observation.workspace.snapshot();
      expect(remapped.blocks.map((block) => block.id)).toEqual(checked.blocks.map((block) => block.id));
      expect(remapped.blocks[4]!.diagnostics[0]!.from).toBe(checked.blocks[4]!.diagnostics[0]!.from + "Added prose.\n".length);

      await observation.workspace.restart();
      await observation.until((snapshot) => snapshot.blocks[0]!.state === "checked");
      observation.workspace.closeNote("Proof.md");
      expect(observation.workspace.snapshot().blocks).toEqual([]);

      const draft = "```lean\nexample : True := by\n  trivial";
      observation.workspace.updateNote("Draft.md", draft);
      observation.workspace.inspectAt("Draft.md", draft.length);
      await observation.until((snapshot) => snapshot.blocks[0]?.state === "checked" && snapshot.goal?.state === "ready");
      observation.workspace.updateNote("Draft.md", draft + "\n");
      observation.workspace.inspectAt("Draft.md", draft.length + 1);
      const atEof = await observation.until((snapshot) =>
        snapshot.blocks[0]?.version === 2 && snapshot.blocks[0]?.state === "checked" && snapshot.goal?.state === "ready",
      );
      expect(atEof.blocks[0]!.includesEnd).toBe(true);
      expect(atEof.blocks[0]!.diagnostics.some((diagnostic) => diagnostic.severity === "error")).toBe(false);
    } finally {
      await observation.workspace.dispose();
    }
  }, 90_000);
});
