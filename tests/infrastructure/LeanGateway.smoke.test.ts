import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  LeanDiagnosticsEvent,
  LeanProgressEvent,
  LeanServiceStatus,
} from "../../src/application/contracts";
import { LeanLanguageServerGateway } from "../../src/infrastructure/LeanLanguageServerGateway";

class SmokeObservation {
  readonly diagnostics: LeanDiagnosticsEvent[] = [];
  readonly progress: LeanProgressEvent[] = [];
  readonly status: LeanServiceStatus[] = [];
  readonly root = resolve("tests/fixtures/lean project");
  readonly gateway = new LeanLanguageServerGateway({
    projectRoot: this.root,
    startupTimeoutMs: 30_000,
    requestTimeoutMs: 30_000,
  });

  constructor() {
    this.gateway.onDiagnostics((event) => this.diagnostics.push(event));
    this.gateway.onProgress((event) => this.progress.push(event));
    this.gateway.onStatus((event) => this.status.push(event));
  }

  async finished(documentId: string, version: number): Promise<void> {
    const started = Date.now();
    while (!this.progress.some((event) => event.documentId === documentId && event.version === version && !event.processing)) {
      if (Date.now() - started > 30_000) {
        throw new Error(`No completed progress for ${documentId} v${version}: ${JSON.stringify({ progress: this.progress, diagnostics: this.diagnostics, status: this.status, log: this.gateway.recentLog() })}`);
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
  }

  latest(documentId: string, version: number): LeanDiagnosticsEvent | undefined {
    return [...this.diagnostics].reverse().find((event) => event.documentId === documentId && event.version === version);
  }
}

describe.skipIf(process.env.LEAN_SMOKE !== "1")("real Lean 4 gateway smoke", () => {
  it("isolates blocks, maps diagnostics, reads goals, updates, restarts, and exits without writing source files", async () => {
    const observation = new SmokeObservation();
    const originalFiles = await readdir(observation.root);
    const proof = "import FixtureSupport\ndef shared : Nat := fromFixture\nexample (n : Nat) : n = n := by\n  rfl\n#check shared\n";
    try {
      await observation.gateway.open({ documentId: "one", version: 1, code: proof });
      await observation.gateway.open({ documentId: "two", version: 1, code: proof });
      await Promise.all([observation.finished("one", 1), observation.finished("two", 1)]);
      expect(observation.latest("one", 1)?.diagnostics.some((item) => item.severity === "error")).toBe(false);
      expect(observation.latest("two", 1)?.diagnostics.some((item) => item.severity === "error")).toBe(false);
      const goals = await observation.gateway.goals("one", { line: 3, character: 2 });
      expect(goals.goals.join("\n")).toContain("n : Nat");
      expect(goals.goals.join("\n")).toContain("n = n");
      const termGoals = await observation.gateway.goals("one", { line: 1, character: 21 });
      expect(termGoals.goals.join("\n")).toContain("Nat");

      await observation.gateway.change({ documentId: "two", version: 2, code: "def shared : Nat := \"错误 😀\"\n" });
      await observation.finished("two", 2);
      expect(observation.latest("two", 2)?.diagnostics.some((item) => item.severity === "error")).toBe(true);
      expect(observation.diagnostics.filter((event) => event.documentId === "one").flatMap((event) => event.diagnostics).some((item) => item.severity === "error")).toBe(false);

      await observation.gateway.change({ documentId: "two", version: 3, code: proof });
      await observation.finished("two", 3);
      expect(observation.latest("two", 3)?.diagnostics.some((item) => item.severity === "error")).toBe(false);
      // Deliberately terminate only this code block's Lean worker.
      await observation.gateway.open({ documentId: "crashed", version: 1, code: "#eval (IO.Process.exit 1 : IO Unit)\n" });
      await observation.finished("crashed", 1);
      expect(observation.latest("crashed", 1)?.diagnostics.some((item) => item.message.includes("fatal worker"))).toBe(true);
      expect((await observation.gateway.goals("one", { line: 3, character: 2 })).goals.join("\n")).toContain("n = n");
      await observation.gateway.close("crashed");
      await observation.gateway.close("two");
      await expect(observation.gateway.goals("two", { line: 0, character: 0 })).rejects.toThrow("not open");
      await observation.gateway.restart();
      await observation.gateway.open({ documentId: "one", version: 2, code: proof });
      await observation.finished("one", 2);
      expect(observation.latest("one", 2)?.diagnostics.some((item) => item.severity === "error")).toBe(false);
    } finally {
      await observation.gateway.dispose();
    }
    expect(observation.status.at(-1)?.state).toBe("stopped");
    const remainingFiles = await readdir(observation.root);
    expect(remainingFiles.filter((file) => file.startsWith("ObsidianBlock_"))).toEqual(
      originalFiles.filter((file) => file.startsWith("ObsidianBlock_")),
    );
  }, 90_000);
});
