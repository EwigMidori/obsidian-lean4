import type { ManagedEnvironmentSnapshot } from "../../../src/infrastructure/ManagedLeanEnvironment";
import type { Unsubscribe } from "../../../src/application/contracts";
import { Deferred } from "./FakeLeanGateway";

export class FakeManagedEnvironment {
  static readonly instances: FakeManagedEnvironment[] = [];
  readonly prepareGate = new Deferred();
  pausePreparation = false;
  installed = true;
  prepareCalls = 0;
  resolveCalls = 0;
  cancelled = false;
  private current: ManagedEnvironmentSnapshot = {
    state: "idle", message: "Detect Lean on first check.", toolchain: "test-toolchain", cacheRoot: "/test/cache"
  };
  private readonly listeners = new Set<(state: ManagedEnvironmentSnapshot) => void>();

  constructor() { FakeManagedEnvironment.instances.push(this); }
  snapshot(): ManagedEnvironmentSnapshot { return this.current; }
  subscribe(listener: (state: ManagedEnvironmentSnapshot) => void): Unsubscribe {
    this.listeners.add(listener);
    listener(this.current);
    return () => { this.listeners.delete(listener); };
  }
  async resolve(): Promise<void> {
    this.resolveCalls++;
    if (!this.installed) {
      this.update({ state: "needs-install", message: "Lean is missing. Prepare it to continue." });
      throw new Error("Lean is missing");
    }
    this.update({ state: "ready", message: "Lean ready." });
  }
  async prepare(signal?: AbortSignal): Promise<void> {
    this.prepareCalls++;
    this.update({ state: "downloading", message: "Downloading Lean…", downloadedBytes: 1_024, totalBytes: 4_096 });
    if (this.pausePreparation) {
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          this.cancelled = true;
          this.update({ state: "cancelled", message: "Preparation cancelled." });
          reject(new Error("Cancelled"));
        };
        signal?.addEventListener("abort", abort, { once: true });
        void this.prepareGate.promise.then(() => {
          signal?.removeEventListener("abort", abort);
          resolve();
        });
      });
    }
    if (signal?.aborted) return;
    this.installed = true;
    this.update({ state: "ready", message: "Lean ready." });
  }
  update(change: Partial<ManagedEnvironmentSnapshot>): void {
    this.current = { ...this.current, ...change };
    for (const listener of this.listeners) listener(this.current);
  }
}
