import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Unsubscribe } from "../application/contracts";
import { BoundedLog } from "./BoundedLog";
import { EnvironmentCommand } from "./EnvironmentCommand";
import { LeanProtocol } from "./LeanProtocol";
import { LeanToolchainDiscovery, type LeanEnvironmentRuntime } from "./LeanToolchainDiscovery";
import { OfficialElanInstaller } from "./OfficialElanInstaller";

export interface ManagedEnvironmentSnapshot {
  readonly state: "idle" | "discovering" | "needs-install" | "downloading" | "installing" | "ready" | "error" | "cancelled";
  readonly message: string;
  readonly toolchain: string;
  readonly cacheRoot: string;
  readonly progress?: number;
  readonly downloadedBytes?: number;
  readonly totalBytes?: number;
}

export interface ManagedLeanEnvironmentOptions {
  readonly cacheRoot?: string;
}

interface Preparation {
  readonly allowInstall: boolean;
  readonly promise: Promise<LeanEnvironmentRuntime>;
}

/** Owns the plugin's basic project and explicit, cancellable toolchain preparation. */
export class ManagedLeanEnvironment {
  private static readonly preparations = new Map<string, Preparation>();
  readonly cacheRoot: string;
  private readonly listeners = new Set<(snapshot: ManagedEnvironmentSnapshot) => void>();
  private readonly log = new BoundedLog();
  private current: ManagedEnvironmentSnapshot;
  private runtime: LeanEnvironmentRuntime | undefined;

  constructor(options: ManagedLeanEnvironmentOptions = {}) {
    this.cacheRoot = resolve(options.cacheRoot ?? ManagedLeanEnvironment.defaultCacheRoot());
    this.current = {
      state: "idle",
      message: "The basic Lean environment will be detected when you check a block.",
      toolchain: LeanToolchainDiscovery.toolchain,
      cacheRoot: this.cacheRoot,
    };
  }

  static defaultCacheRoot(): string {
    const parent = process.platform === "win32"
      ? process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
      : process.platform === "darwin"
        ? join(homedir(), "Library", "Caches")
        : process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
    return join(parent, "lean4-obsidian-plugin");
  }

  snapshot(): ManagedEnvironmentSnapshot {
    return this.current;
  }

  subscribe(listener: (snapshot: ManagedEnvironmentSnapshot) => void): Unsubscribe {
    this.listeners.add(listener);
    listener(this.current);
    return () => this.listeners.delete(listener);
  }

  resolve(signal?: AbortSignal): Promise<LeanEnvironmentRuntime> {
    return this.ensure(false, signal);
  }

  prepare(signal?: AbortSignal): Promise<LeanEnvironmentRuntime> {
    return this.ensure(true, signal);
  }

  recentLog(): string {
    return this.log.read();
  }

  private async ensure(allowInstall: boolean, signal?: AbortSignal): Promise<LeanEnvironmentRuntime> {
    if (signal?.aborted) {
      this.update({ state: "cancelled", message: "Lean environment preparation cancelled. You can retry when ready." });
      throw new Error("Lean environment preparation cancelled.");
    }
    if (this.runtime) return this.runtime;
    const key = process.platform === "win32" ? this.cacheRoot.toLowerCase() : this.cacheRoot;
    const existing = ManagedLeanEnvironment.preparations.get(key);
    if (existing) {
      this.update({ state: "discovering", message: "Waiting for the current basic Lean environment preparation…" });
      try {
        this.runtime = await this.wait(existing.promise, signal);
        this.update({ state: "ready", message: "Basic Lean environment is ready." });
        return this.runtime;
      } catch (error) {
        if (!allowInstall || existing.allowInstall || signal?.aborted) {
          this.update({ state: signal?.aborted ? "cancelled" : "error", message: LeanProtocol.message(error) });
          throw error;
        }
        return this.ensure(allowInstall, signal);
      }
    }
    const promise = this.prepareEnvironment(allowInstall, signal);
    ManagedLeanEnvironment.preparations.set(key, { allowInstall, promise });
    try {
      this.runtime = await promise;
      return this.runtime;
    } finally {
      if (ManagedLeanEnvironment.preparations.get(key)?.promise === promise) {
        ManagedLeanEnvironment.preparations.delete(key);
      }
    }
  }

  private async prepareEnvironment(allowInstall: boolean, signal?: AbortSignal): Promise<LeanEnvironmentRuntime> {
    this.update({ state: "discovering", message: "Looking for Lean 4.35.0 on this computer…" });
    try {
      const projectRoot = join(this.cacheRoot, "basic-v4.35.0");
      await mkdir(projectRoot, { recursive: true });
      await this.writeManagedFile(join(projectRoot, "lean-toolchain"), `${LeanToolchainDiscovery.toolchain}\n`);
      await this.writeManagedFile(join(projectRoot, "lakefile.toml"), 'name = "obsidianBasic"\nversion = "0.1.0"\ndefaultTargets = []\n');
      const discovery = new LeanToolchainDiscovery();
      let runtime = await discovery.installed(this.cacheRoot, projectRoot, signal);
      if (!runtime && !allowInstall) {
        this.update({ state: "needs-install", message: "Lean 4.35.0 is not installed. Choose Prepare basic Lean environment to download it." });
        throw new Error(this.current.message);
      }
      if (!runtime) {
        let manager = (await discovery.managers(this.cacheRoot, signal))[0];
        if (!manager) {
          this.update({ state: "downloading", message: "Downloading the verified official elan installer…" });
          manager = await new OfficialElanInstaller().install(this.cacheRoot, signal, (progress) => {
            this.update({
              state: "downloading", message: "Downloading the verified official elan installer…",
              ...progress,
              progress: progress.totalBytes ? progress.downloadedBytes / progress.totalBytes : undefined,
            });
          }, (text) => this.log.append(text));
        }
        this.update({ state: "installing", message: "Installing Lean 4.35.0. The toolchain download can take several minutes…" });
        await new EnvironmentCommand().run(manager.executable, ["toolchain", "install", LeanToolchainDiscovery.toolchain], {
          cwd: projectRoot,
          env: manager.env,
          signal,
          timeoutMs: 30 * 60_000,
          onOutput: (text) => {
            this.log.append(text);
            const line = text.trim().split(/\r?\n/).filter(Boolean).at(-1);
            if (line) this.update({ state: "installing", message: line.slice(-500) });
          },
        });
        runtime = await discovery.installed(this.cacheRoot, projectRoot, signal);
      }
      if (!runtime) throw new Error("Lean installation finished but the pinned Lake executable could not be found. Retry preparation.");
      if (signal?.aborted) throw new Error("Lean environment preparation cancelled.");
      this.update({ state: "ready", message: "Basic Lean 4.35.0 environment is ready." });
      return runtime;
    } catch (error) {
      if (signal?.aborted) this.update({ state: "cancelled", message: "Lean environment preparation cancelled. You can retry when ready." });
      else if (this.current.state !== "needs-install") this.update({ state: "error", message: LeanProtocol.message(error) });
      throw error;
    }
  }

  private async writeManagedFile(path: string, expected: string): Promise<void> {
    try { if (await readFile(path, "utf8") === expected) return; } catch { /* First preparation. */ }
    await writeFile(path, expected, "utf8");
  }

  private update(update: Pick<ManagedEnvironmentSnapshot, "state" | "message"> & Partial<ManagedEnvironmentSnapshot>): void {
    this.current = { toolchain: LeanToolchainDiscovery.toolchain, cacheRoot: this.cacheRoot, ...update };
    for (const listener of this.listeners) listener(this.current);
  }

  private async wait<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error("Lean environment preparation cancelled."));
    });
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) abort();
      return await Promise.race([promise, cancelled]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
}
