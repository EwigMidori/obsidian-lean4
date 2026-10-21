import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LeanDiagnosticsEvent, LeanProgressEvent } from "../../src/application/contracts";
import { EnvironmentCommand } from "../../src/infrastructure/EnvironmentCommand";
import { LeanLanguageServerGateway } from "../../src/infrastructure/LeanLanguageServerGateway";
import { ManagedLeanEnvironment } from "../../src/infrastructure/ManagedLeanEnvironment";
import { OfficialElanInstaller } from "../../src/infrastructure/OfficialElanInstaller";

class ManagedSmokeObservation {
  readonly diagnostics: LeanDiagnosticsEvent[] = [];
  readonly progress: LeanProgressEvent[] = [];

  constructor(readonly gateway: LeanLanguageServerGateway) {
    gateway.onDiagnostics((event) => this.diagnostics.push(event));
    gateway.onProgress((event) => this.progress.push(event));
  }

  async finished(documentId: string): Promise<void> {
    const started = Date.now();
    while (!this.progress.some((event) => event.documentId === documentId && !event.processing)) {
      if (Date.now() - started > 30_000) throw new Error(`Managed block did not complete: ${JSON.stringify(this.diagnostics)} ${this.gateway.recentLog()}`);
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));
    }
  }
}

describe.skipIf(process.env.LEAN_SMOKE !== "1")("real managed Lean environment", () => {
  it("checks independent blocks from an empty cache without any user Lake project or global changes", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "obsidian-lean-managed-smoke-"));
    const settingsPath = join(process.env.ELAN_HOME || join(homedir(), ".elan"), "settings.toml");
    const previousSettings = await readFile(settingsPath, "utf8").catch(() => undefined);
    const environment = new ManagedLeanEnvironment({ cacheRoot });
    const gateway = new LeanLanguageServerGateway({ environment });
    const observation = new ManagedSmokeObservation(gateway);
    try {
      expect(await readdir(cacheRoot)).toEqual([]);
      const proof = "import Std\ndef shared : Nat := 7\nexample (n : Nat) : n = n := by\n  rfl\n";
      await gateway.open({ documentId: "one", version: 1, code: proof });
      await gateway.open({ documentId: "two", version: 1, code: proof });
      await Promise.all([observation.finished("one"), observation.finished("two")]);
      expect(observation.diagnostics.flatMap((event) => event.diagnostics).some((item) => item.severity === "error")).toBe(false);
      expect((await gateway.goals("one", { line: 3, character: 2 })).goals.join("\n")).toContain("n = n");
      expect(environment.snapshot().state).toBe("ready");
      expect(await readFile(join(cacheRoot, "basic-v4.35.0", "lean-toolchain"), "utf8")).toBe("leanprover/lean4:v4.35.0\n");
      expect(await readFile(settingsPath, "utf8").catch(() => undefined)).toBe(previousSettings);
    } finally {
      await gateway.dispose();
      await rm(cacheRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }, 60_000);
});

describe.skipIf(process.env.LEAN_BOOTSTRAP_SMOKE !== "1")("official private elan bootstrap", () => {
  it("downloads, verifies, and installs elan without modifying global configuration", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "obsidian-elan-bootstrap-smoke-"));
    const settingsPath = join(process.env.ELAN_HOME || join(homedir(), ".elan"), "settings.toml");
    const previousSettings = await readFile(settingsPath, "utf8").catch(() => undefined);
    try {
      const manager = await new OfficialElanInstaller().install(cacheRoot);
      const version = await new EnvironmentCommand().run(manager.executable, ["--version"], { env: manager.env });
      expect(version).toContain("elan 4.2.4");
      const toolchains = await new EnvironmentCommand().run(manager.executable, ["toolchain", "list"], { env: manager.env });
      expect(toolchains).not.toContain("leanprover/lean4");
      expect(await readFile(settingsPath, "utf8").catch(() => undefined)).toBe(previousSettings);
      expect(await readdir(cacheRoot)).not.toContain("elan.zip");
    } finally {
      await rm(cacheRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }, 180_000);
});
