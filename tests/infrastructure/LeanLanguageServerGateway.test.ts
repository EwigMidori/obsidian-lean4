import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LeanLanguageServerGateway } from "../../src/infrastructure/LeanLanguageServerGateway";
import { LeanProjectSession } from "../../src/infrastructure/LeanProjectSession";
import { ManagedLeanEnvironment } from "../../src/infrastructure/ManagedLeanEnvironment";
import type { LeanEnvironmentRuntime } from "../../src/infrastructure/LeanToolchainDiscovery";

class Pending<T> {
  readonly promise: Promise<T>;
  private complete!: (value: T) => void;

  constructor() {
    this.promise = new Promise((resolvePromise) => { this.complete = resolvePromise; });
  }

  resolve(value: T): void {
    this.complete(value);
  }
}

describe("LeanLanguageServerGateway lifecycle", () => {
  it("does not open a worker after its block was closed during server initialization", async () => {
    const startup = new Pending<void>();
    vi.spyOn(LeanProjectSession.prototype, "start").mockReturnValue(startup.promise);
    const notify = vi.spyOn(LeanProjectSession.prototype, "notify").mockResolvedValue();
    const gateway = new LeanLanguageServerGateway({ projectRoot: resolve("tests/fixtures/lean project") });
    const opening = gateway.open({ documentId: "one", version: 1, code: "#check Nat" });
    const closing = gateway.close("one");
    startup.resolve();
    await Promise.all([opening, closing]);
    expect(notify).not.toHaveBeenCalled();
    await gateway.dispose();
  });

  it("rejects an old goal after an edit even when a server ignores cancellation", async () => {
    vi.spyOn(LeanProjectSession.prototype, "start").mockResolvedValue();
    vi.spyOn(LeanProjectSession.prototype, "notify").mockResolvedValue();
    const response = new Pending<unknown>();
    vi.spyOn(LeanProjectSession.prototype, "request").mockReturnValue(response.promise);
    const gateway = new LeanLanguageServerGateway({ projectRoot: resolve("tests/fixtures/lean project") });
    await gateway.open({ documentId: "one", version: 1, code: "example : True := by trivial" });
    const goal = gateway.goals("one", { line: 0, character: 22 });
    const rejected = expect(goal).rejects.toThrow("stale");
    await gateway.change({ documentId: "one", version: 2, code: "example : False := by sorry" });
    response.resolve({ goals: ["⊢ True"] });
    await rejected;
    await gateway.dispose();
  });

  it("assigns a different URI when the same block is reopened", async () => {
    vi.spyOn(LeanProjectSession.prototype, "start").mockResolvedValue();
    const notify = vi.spyOn(LeanProjectSession.prototype, "notify").mockResolvedValue();
    const gateway = new LeanLanguageServerGateway({ projectRoot: resolve("tests/fixtures/lean project") });
    const document = { documentId: "one", version: 1, code: "#check Nat" };
    await gateway.open(document);
    await gateway.close("one");
    await gateway.open(document);
    const opens = notify.mock.calls.filter((call) => call[0] === "textDocument/didOpen");
    const first = opens[0]?.[1] as { textDocument: { uri: string } };
    const second = opens[1]?.[1] as { textDocument: { uri: string } };
    expect(first.textDocument.uri).not.toBe(second.textDocument.uri);
    expect(first.textDocument.uri).toContain("lean%20project");
    await gateway.dispose();
  });

  it("immediately aborts a goal even when the server ignores cancellation", async () => {
    vi.spyOn(LeanProjectSession.prototype, "start").mockResolvedValue();
    vi.spyOn(LeanProjectSession.prototype, "notify").mockResolvedValue();
    const request = vi.spyOn(LeanProjectSession.prototype, "request").mockReturnValue(new Promise(() => {}));
    const gateway = new LeanLanguageServerGateway({ projectRoot: resolve("tests/fixtures/lean project") });
    await gateway.open({ documentId: "one", version: 1, code: "example : True := by trivial" });
    const cancellation = new AbortController();
    const goal = gateway.goals("one", { line: 0, character: 22 }, cancellation.signal);
    const rejected = expect(goal).rejects.toThrow("cancelled");
    await Promise.resolve();
    await Promise.resolve();
    expect(request).toHaveBeenCalled();
    cancellation.abort();
    await rejected;
    await gateway.dispose();
  });

  it("does not send a goal request whose caller has already aborted", async () => {
    vi.spyOn(LeanProjectSession.prototype, "start").mockResolvedValue();
    vi.spyOn(LeanProjectSession.prototype, "notify").mockResolvedValue();
    const request = vi.spyOn(LeanProjectSession.prototype, "request");
    const gateway = new LeanLanguageServerGateway({ projectRoot: resolve("tests/fixtures/lean project") });
    await gateway.open({ documentId: "one", version: 1, code: "#check Nat" });
    const cancellation = new AbortController();
    cancellation.abort();
    await expect(gateway.goals("one", { line: 0, character: 0 }, cancellation.signal)).rejects.toThrow("cancelled");
    expect(request).not.toHaveBeenCalled();
    await gateway.dispose();
  });

  it("immediately aborts a term-goal fallback that never returns", async () => {
    vi.spyOn(LeanProjectSession.prototype, "start").mockResolvedValue();
    vi.spyOn(LeanProjectSession.prototype, "notify").mockResolvedValue();
    const enteredFallback = new Pending<void>();
    vi.spyOn(LeanProjectSession.prototype, "request").mockImplementation((method) => {
      if (method === "$/lean/plainGoal") return Promise.resolve(null);
      enteredFallback.resolve();
      return new Promise(() => {});
    });
    const gateway = new LeanLanguageServerGateway({ projectRoot: resolve("tests/fixtures/lean project") });
    await gateway.open({ documentId: "one", version: 1, code: "def answer : Nat := 42" });
    const cancellation = new AbortController();
    const goal = gateway.goals("one", { line: 0, character: 20 }, cancellation.signal);
    const rejected = expect(goal).rejects.toThrow("cancelled");
    await enteredFallback.promise;
    cancellation.abort();
    await rejected;
    await gateway.dispose();
  });

  it.each(["close", "restart"] as const)("allows %s immediately after aborting a goal that is waiting for document opening", async (action) => {
    const startup = new Pending<void>();
    const enteredStartup = new Pending<void>();
    vi.spyOn(LeanProjectSession.prototype, "start").mockImplementationOnce(() => {
      enteredStartup.resolve();
      return startup.promise;
    }).mockResolvedValue();
    vi.spyOn(LeanProjectSession.prototype, "notify").mockResolvedValue();
    const request = vi.spyOn(LeanProjectSession.prototype, "request");
    const gateway = new LeanLanguageServerGateway({ projectRoot: resolve("tests/fixtures/lean project") });
    const opening = gateway.open({ documentId: "one", version: 1, code: "#check Nat" });
    await enteredStartup.promise;
    const cancellation = new AbortController();
    const goal = gateway.goals("one", { line: 0, character: 7 }, cancellation.signal);
    const rejected = expect(goal).rejects.toThrow("cancelled");
    cancellation.abort();
    // This deliberately precedes the cancelled goal's finally block, forcing a second cancel.
    const lifecycle = action === "close" ? gateway.close("one") : gateway.restart();
    startup.resolve();
    await expect(lifecycle).resolves.toBeUndefined();
    await opening;
    await rejected;
    expect(request).not.toHaveBeenCalled();
    await gateway.dispose();
  });

  it("does not revive a block closed while its managed environment is still resolving", async () => {
    const resolution = new Pending<LeanEnvironmentRuntime>();
    vi.spyOn(ManagedLeanEnvironment.prototype, "resolve").mockReturnValue(resolution.promise);
    const start = vi.spyOn(LeanProjectSession.prototype, "start").mockResolvedValue();
    const notify = vi.spyOn(LeanProjectSession.prototype, "notify").mockResolvedValue();
    const gateway = new LeanLanguageServerGateway();
    const opening = gateway.open({ documentId: "one", version: 1, code: "#check Nat" });
    await gateway.close("one");
    resolution.resolve({ projectRoot: resolve("tests/fixtures/lean project"), lakeExecutable: "lake" });
    await opening;
    expect(start).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    await gateway.dispose();
  });

  it("aborts environment resolution on disposal and never starts a late server", async () => {
    const resolution = new Pending<LeanEnvironmentRuntime>();
    const resolver = vi.spyOn(ManagedLeanEnvironment.prototype, "resolve").mockReturnValue(resolution.promise);
    const start = vi.spyOn(LeanProjectSession.prototype, "start").mockResolvedValue();
    const gateway = new LeanLanguageServerGateway();
    const opening = gateway.open({ documentId: "one", version: 1, code: "#check Nat" });
    const rejected = expect(opening).rejects.toThrow("cancelled");
    await gateway.dispose();
    expect(resolver.mock.calls[0]?.[0]?.aborted).toBe(true);
    resolution.resolve({ projectRoot: resolve("tests/fixtures/lean project"), lakeExecutable: "lake" });
    await rejected;
    expect(start).not.toHaveBeenCalled();
  });

  it("rejects pre-restart resolution and opens only the new environment generation", async () => {
    const oldResolution = new Pending<LeanEnvironmentRuntime>();
    const newResolution = new Pending<LeanEnvironmentRuntime>();
    vi.spyOn(ManagedLeanEnvironment.prototype, "resolve")
      .mockReturnValueOnce(oldResolution.promise).mockReturnValueOnce(newResolution.promise);
    const start = vi.spyOn(LeanProjectSession.prototype, "start").mockResolvedValue();
    const notify = vi.spyOn(LeanProjectSession.prototype, "notify").mockResolvedValue();
    const gateway = new LeanLanguageServerGateway();
    const oldOpening = gateway.open({ documentId: "one", version: 1, code: "#check Nat" });
    const rejected = expect(oldOpening).rejects.toThrow("cancelled");
    const restarting = gateway.restart();
    oldResolution.resolve({ projectRoot: "old project", lakeExecutable: "old lake" });
    await rejected;
    newResolution.resolve({ projectRoot: resolve("tests/fixtures/lean project"), lakeExecutable: "lake" });
    await restarting;
    await gateway.open({ documentId: "one", version: 2, code: "#check Nat" });
    expect(start).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls.filter((call) => call[0] === "textDocument/didOpen")).toHaveLength(1);
    await gateway.dispose();
  });
});
