import { resolve } from "node:path";
import { CancellationTokenSource } from "vscode-jsonrpc";
import { describe, expect, it } from "vitest";
import type { LeanServiceStatus } from "../../src/application/contracts";
import { BoundedLog } from "../../src/infrastructure/BoundedLog";
import { LeanProjectSession } from "../../src/infrastructure/LeanProjectSession";
import { LeanProtocol } from "../../src/infrastructure/LeanProtocol";

class SessionHarness {
  readonly statuses: LeanServiceStatus[] = [];
  readonly session = new LeanProjectSession({
    projectRoot: resolve("tests/fixtures/lean project"),
    executable: process.execPath,
    arguments: [resolve("tests/infrastructure/fixtures/MockLeanServer.cjs")],
    startupTimeoutMs: 5_000,
    requestTimeoutMs: 250,
    shutdownTimeoutMs: 250,
  }, {
    notification: () => {},
    status: (status) => this.statuses.push(status),
  });

  static cleanupDescendant(processId: number | undefined): void {
    if (!processId) return;
    try {
      process.kill(processId, "SIGKILL");
    } catch {
      // The cleanup assertion should normally have already proved this PID is gone.
    }
  }
}

describe("LeanProjectSession", () => {
  it("round trips UTF-8 payloads through a process and a project path containing spaces", async () => {
    const harness = new SessionHarness();
    try {
      const payload = { text: "∀ x : Nat, x = x -- 中文😀", line: 4 };
      await expect(harness.session.request("echo", payload)).resolves.toEqual(payload);
      expect(harness.statuses.at(-1)?.state).toBe("ready");
    } finally {
      await harness.session.close();
    }
    expect(harness.statuses.at(-1)?.state).toBe("stopped");
  });

  it("bounds requests even when the server ignores cancellation", async () => {
    const harness = new SessionHarness();
    try {
      await expect(harness.session.request("hold", {})).rejects.toThrow("timed out");
      await expect(harness.session.request("echo", { stillAlive: true })).resolves.toEqual({ stillAlive: true });
    } finally {
      await harness.session.close();
    }
  });

  it("cancels a request without waiting for a response", async () => {
    const harness = new SessionHarness();
    const cancellation = new CancellationTokenSource();
    try {
      await harness.session.start();
      const pending = harness.session.request("hold", {}, cancellation.token);
      const rejected = expect(pending).rejects.toThrow("cancelled");
      cancellation.cancel();
      await rejected;
    } finally {
      cancellation.dispose();
      await harness.session.close();
    }
  });

  it("rejects in-flight requests when the child process crashes", async () => {
    const harness = new SessionHarness();
    try {
      await harness.session.start();
      const pending = harness.session.request("hold", {});
      const rejected = expect(pending).rejects.toThrow();
      await harness.session.notify("test/crash", {});
      await rejected;
      expect(harness.statuses.at(-1)?.state).toBe("error");
      await expect(harness.session.start()).rejects.toThrow("Restart");
    } finally {
      await harness.session.close();
    }
  });

  it("bounds retained requests when a broken server never answers cancellations", async () => {
    const harness = new SessionHarness();
    try {
      await harness.session.start();
      for (let index = 0; index < 32; index++) {
        const cancellation = new CancellationTokenSource();
        const pending = harness.session.request("hold", {}, cancellation.token);
        const rejected = expect(pending).rejects.toThrow("cancelled");
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 1));
        cancellation.cancel();
        await rejected;
        cancellation.dispose();
      }
      await expect(harness.session.request("echo", {})).rejects.toThrow("Too many unanswered");
      expect(harness.statuses.at(-1)?.state).toBe("error");
    } finally {
      await harness.session.close();
    }
  });

  it("fails cleanly when the executable does not exist", async () => {
    const session = new LeanProjectSession({
      projectRoot: resolve("tests/fixtures/lean project"),
      executable: resolve("tests/fixtures/does-not-exist.exe"),
      startupTimeoutMs: 1_000,
    }, { notification: () => {}, status: () => {} });
    await expect(session.start()).rejects.toThrow("Lean startup failed");
    await session.close();
  });

  it("reclaims descendants when the server ignores shutdown", async () => {
    const session = new LeanProjectSession({
      projectRoot: resolve("tests/fixtures/lean project"),
      executable: process.execPath,
      arguments: [resolve("tests/infrastructure/fixtures/MockLeanServer.cjs"), "hang-shutdown"],
      startupTimeoutMs: 5_000,
      shutdownTimeoutMs: 100,
    }, { notification: () => {}, status: () => {} });
    let descendant: number | undefined;
    try {
      descendant = await session.request<number>("descendant", {});
      expect(() => process.kill(descendant as number, 0)).not.toThrow();
      await session.close();
      expect(() => process.kill(descendant as number, 0)).toThrow();
    } finally {
      await session.close();
      SessionHarness.cleanupDescendant(descendant);
    }
  });

  it("reclaims descendants after a cooperative shutdown response", async () => {
    const harness = new SessionHarness();
    let descendant: number | undefined;
    try {
      descendant = await harness.session.request<number>("descendant", {});
      await harness.session.close();
      expect(() => process.kill(descendant as number, 0)).toThrow();
    } finally {
      await harness.session.close();
      SessionHarness.cleanupDescendant(descendant);
    }
  });

  it("reclaims a surviving descendant after its server parent crashes", async () => {
    const harness = new SessionHarness();
    let descendant: number | undefined;
    try {
      descendant = await harness.session.request<number>("descendant", {});
      await harness.session.notify("test/crash", {});
      const startedAt = Date.now();
      while (!harness.statuses.some((status) => status.state === "error")) {
        if (Date.now() - startedAt > 2_000) throw new Error("Mock server did not crash.");
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
      }
      await harness.session.close();
      expect(harness.session.recentLog()).not.toContain("orphan-process cleanup exited");
      expect(() => process.kill(descendant as number, 0)).toThrow();
    } finally {
      await harness.session.close();
      SessionHarness.cleanupDescendant(descendant);
    }
  });
});

describe("Lean protocol boundary", () => {
  it("never fabricates a missing or invalid diagnostic version", () => {
    expect(LeanProtocol.version(undefined)).toBeNull();
    expect(LeanProtocol.version("2")).toBeNull();
    expect(LeanProtocol.version(-1)).toBeNull();
    expect(LeanProtocol.version(2)).toBe(2);
  });

  it("discards malformed diagnostics and preserves UTF-16 positions", () => {
    expect(LeanProtocol.diagnostics([
      { message: "bad range", range: {} },
      { message: "bad line", range: { start: { line: -1, character: 0 }, end: { line: 0, character: 1 } } },
      { message: "type mismatch", severity: 1, range: { start: { line: 0, character: 4 }, end: { line: 0, character: 6 } } },
    ])).toEqual([{
      message: "type mismatch",
      severity: "error",
      range: { start: { line: 0, character: 4 }, end: { line: 0, character: 6 } },
    }]);
  });

  it("bounds retained process output", () => {
    const log = new BoundedLog(8);
    log.append("1234567");
    log.append("890abc");
    expect(log.read()).toBe("67890abc");
  });
});
