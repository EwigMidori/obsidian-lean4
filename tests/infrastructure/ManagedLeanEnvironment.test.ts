import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EnvironmentCommand } from "../../src/infrastructure/EnvironmentCommand";
import { LeanToolchainDiscovery, type LeanEnvironmentRuntime } from "../../src/infrastructure/LeanToolchainDiscovery";
import { ManagedLeanEnvironment } from "../../src/infrastructure/ManagedLeanEnvironment";
import { OfficialElanInstaller } from "../../src/infrastructure/OfficialElanInstaller";

class EnvironmentFixture {
  static async create(): Promise<EnvironmentFixture> {
    return new EnvironmentFixture(await mkdtemp(join(tmpdir(), "obsidian-lean-env-test-")));
  }

  private constructor(readonly root: string) {}

  runtime(): LeanEnvironmentRuntime {
    return { projectRoot: join(this.root, "basic-v4.35.0"), lakeExecutable: "already-installed-lake" };
  }

  async dispose(): Promise<void> {
    await rm(this.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

describe("ManagedLeanEnvironment", () => {
  it("creates a pinned basic project automatically and reuses an installed toolchain without installation", async () => {
    const fixture = await EnvironmentFixture.create();
    vi.spyOn(LeanToolchainDiscovery.prototype, "installed").mockResolvedValue(fixture.runtime());
    const installer = vi.spyOn(OfficialElanInstaller.prototype, "install");
    try {
      const environment = new ManagedLeanEnvironment({ cacheRoot: fixture.root });
      await expect(environment.resolve()).resolves.toEqual(fixture.runtime());
      expect(await readFile(join(fixture.runtime().projectRoot, "lean-toolchain"), "utf8")).toBe("leanprover/lean4:v4.35.0\n");
      expect(await readFile(join(fixture.runtime().projectRoot, "lakefile.toml"), "utf8")).toContain('name = "obsidianBasic"');
      expect(environment.snapshot().state).toBe("ready");
      expect(installer).not.toHaveBeenCalled();
    } finally { await fixture.dispose(); }
  });

  it("reports missing tools without starting a download and can later prepare the pinned toolchain", async () => {
    const fixture = await EnvironmentFixture.create();
    vi.spyOn(LeanToolchainDiscovery.prototype, "installed")
      .mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockResolvedValue(fixture.runtime());
    vi.spyOn(LeanToolchainDiscovery.prototype, "managers").mockResolvedValue([{ executable: "existing-elan", env: { USER_DATA: "preserved" } }]);
    const command = vi.spyOn(EnvironmentCommand.prototype, "run").mockResolvedValue("");
    const installer = vi.spyOn(OfficialElanInstaller.prototype, "install");
    try {
      const environment = new ManagedLeanEnvironment({ cacheRoot: fixture.root });
      await expect(environment.resolve()).rejects.toThrow("Prepare basic Lean");
      expect(environment.snapshot().state).toBe("needs-install");
      expect(command).not.toHaveBeenCalled();
      expect(installer).not.toHaveBeenCalled();
      await environment.prepare();
      expect(command).toHaveBeenCalledWith("existing-elan", ["toolchain", "install", "leanprover/lean4:v4.35.0"], expect.objectContaining({
        env: { USER_DATA: "preserved" },
        timeoutMs: 1_800_000,
      }));
      expect(environment.snapshot().state).toBe("ready");
    } finally { await fixture.dispose(); }
  });

  it("shares concurrent preparations across instances using the same cache", async () => {
    const fixture = await EnvironmentFixture.create();
    const discovery = vi.spyOn(LeanToolchainDiscovery.prototype, "installed").mockResolvedValue(fixture.runtime());
    try {
      const first = new ManagedLeanEnvironment({ cacheRoot: fixture.root });
      const second = new ManagedLeanEnvironment({ cacheRoot: fixture.root });
      const results = await Promise.all([first.prepare(), second.prepare(), first.prepare()]);
      expect(results).toEqual([fixture.runtime(), fixture.runtime(), fixture.runtime()]);
      expect(discovery).toHaveBeenCalledTimes(1);
      expect(first.snapshot().state).toBe("ready");
      expect(second.snapshot().state).toBe("ready");
    } finally { await fixture.dispose(); }
  });

  it("cancels installation and permits a later retry", async () => {
    const fixture = await EnvironmentFixture.create();
    vi.spyOn(LeanToolchainDiscovery.prototype, "installed").mockResolvedValue(undefined);
    vi.spyOn(LeanToolchainDiscovery.prototype, "managers").mockResolvedValue([{ executable: "existing-elan", env: {} }]);
    let entered!: () => void;
    const installing = new Promise<void>((resolvePromise) => { entered = resolvePromise; });
    const command = vi.spyOn(EnvironmentCommand.prototype, "run").mockImplementation((_executable, _args, options) => new Promise((_resolve, reject) => {
      entered();
      options?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    }));
    try {
      const environment = new ManagedLeanEnvironment({ cacheRoot: fixture.root });
      const controller = new AbortController();
      const pending = environment.prepare(controller.signal);
      const rejected = expect(pending).rejects.toThrow("cancelled");
      await installing;
      controller.abort();
      await rejected;
      expect(environment.snapshot().state).toBe("cancelled");
      command.mockResolvedValue("");
      vi.mocked(LeanToolchainDiscovery.prototype.installed).mockResolvedValue(fixture.runtime());
      await environment.prepare();
      expect(environment.snapshot().state).toBe("ready");
    } finally { await fixture.dispose(); }
  });

  it("uses a private verified installer only when no existing elan is available", async () => {
    const fixture = await EnvironmentFixture.create();
    vi.spyOn(LeanToolchainDiscovery.prototype, "installed").mockResolvedValueOnce(undefined).mockResolvedValue(fixture.runtime());
    vi.spyOn(LeanToolchainDiscovery.prototype, "managers").mockResolvedValue([]);
    const installer = vi.spyOn(OfficialElanInstaller.prototype, "install").mockResolvedValue({
      executable: "private-elan", env: { ELAN_HOME: join(fixture.root, "elan") },
    });
    const command = vi.spyOn(EnvironmentCommand.prototype, "run").mockResolvedValue("");
    try {
      const environment = new ManagedLeanEnvironment({ cacheRoot: fixture.root });
      await environment.prepare();
      expect(installer).toHaveBeenCalledOnce();
      expect(command).toHaveBeenCalledWith("private-elan", ["toolchain", "install", "leanprover/lean4:v4.35.0"], expect.objectContaining({
        env: { ELAN_HOME: join(fixture.root, "elan") },
      }));
    } finally { await fixture.dispose(); }
  });

  it("lets followers retry after the preparation owner cancels", async () => {
    const fixture = await EnvironmentFixture.create();
    const discovery = vi.spyOn(LeanToolchainDiscovery.prototype, "installed").mockResolvedValue(undefined);
    vi.spyOn(LeanToolchainDiscovery.prototype, "managers").mockResolvedValue([{ executable: "existing-elan", env: {} }]);
    let entered!: () => void;
    const installing = new Promise<void>((resolvePromise) => { entered = resolvePromise; });
    vi.spyOn(EnvironmentCommand.prototype, "run").mockImplementation((_executable, _args, options) => new Promise((_resolve, reject) => {
      entered();
      options?.signal?.addEventListener("abort", () => reject(new Error("owner cancelled")), { once: true });
    }));
    try {
      const owner = new ManagedLeanEnvironment({ cacheRoot: fixture.root });
      const follower = new ManagedLeanEnvironment({ cacheRoot: fixture.root });
      const controller = new AbortController();
      const ownerResult = owner.prepare(controller.signal);
      const followerResult = follower.prepare();
      const ownerRejected = expect(ownerResult).rejects.toThrow("owner cancelled");
      const followerRejected = expect(followerResult).rejects.toThrow("owner cancelled");
      await installing;
      controller.abort();
      await Promise.all([ownerRejected, followerRejected]);
      expect(owner.snapshot().state).toBe("cancelled");
      expect(follower.snapshot().state).toBe("error");
      discovery.mockResolvedValue(fixture.runtime());
      await follower.prepare();
      expect(follower.snapshot().state).toBe("ready");
    } finally { await fixture.dispose(); }
  });
});

describe("EnvironmentCommand", () => {
  it("drains output written immediately before process exit", async () => {
    const output = await new EnvironmentCommand().run(process.execPath, [
      "-e", "process.stdout.write('x'.repeat(100000) + '\\nfinal executable path\\n')",
    ]);
    expect(output).toMatch(/final executable path\n$/);
    expect(output.length).toBeLessThanOrEqual(16_384);
  });

  it("cancels a running installer independently of the language server timeout", async () => {
    const controller = new AbortController();
    let entered!: () => void;
    const started = new Promise<void>((resolvePromise) => { entered = resolvePromise; });
    const pending = new EnvironmentCommand().run(process.execPath, ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"], {
      signal: controller.signal,
      timeoutMs: 60_000,
      onOutput: () => entered(),
    });
    const rejected = expect(pending).rejects.toThrow("cancelled");
    await started;
    controller.abort();
    await rejected;
  });
});

describe("OfficialElanInstaller manifest", () => {
  it("pins all supported platform archives to official URLs and SHA256 digests", () => {
    const installer = new OfficialElanInstaller();
    for (const platform of ["win32", "darwin", "linux"] as const) {
      for (const arch of platform === "win32" ? ["x64"] as const : ["x64", "arm64"] as const) {
        const artifact = installer.distribution(platform, arch);
        expect(artifact.url).toMatch(/^https:\/\/github\.com\/leanprover\/elan\/releases\/download\/v4\.2\.4\/elan-/);
        expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
    }
    expect(() => installer.distribution("win32", "arm64")).toThrow("unavailable");
  });
});
