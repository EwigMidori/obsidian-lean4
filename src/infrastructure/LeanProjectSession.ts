import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CancellationTokenSource,
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type CancellationToken,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import type { LeanServiceStatus } from "../application/contracts";
import { BoundedLog } from "./BoundedLog";
import { LeanProtocol } from "./LeanProtocol";
import { WindowsProcessTree } from "./WindowsProcessTree";

export interface LeanProjectSessionOptions {
  readonly projectRoot: string;
  readonly executable: string;
  readonly arguments?: readonly string[];
  readonly startupTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}

export interface LeanProjectSessionObserver {
  notification(method: string, params: unknown): void;
  status(status: LeanServiceStatus): void;
}

/** Owns one Lake/Lean process tree, byte-safe JSON-RPC, and bounded request lifetime. */
export class LeanProjectSession {
  private process: ChildProcessWithoutNullStreams | undefined;
  private connection: MessageConnection | undefined;
  private starting: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
  private terminating: Promise<void> | undefined;
  private processStartedAt = new Date();
  private processExitedAt: Date | undefined;
  private closed = false;
  private ready = false;
  private failed = false;
  private readonly pending = new Set<CancellationTokenSource>();
  // JSON-RPC retains a promise until the peer answers, even after cancellation.
  private readonly wireRequests = new Set<Promise<unknown>>();
  private readonly log = new BoundedLog();

  constructor(
    private readonly options: LeanProjectSessionOptions,
    private readonly observer: LeanProjectSessionObserver,
  ) {}

  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Lean session has been closed."));
    if (this.failed) return Promise.reject(new Error("Lean session failed. Restart the Lean service."));
    if (this.ready) return Promise.resolve();
    if (!this.starting) this.starting = this.initialize();
    return this.starting;
  }

  async notify(method: string, params: unknown): Promise<void> {
    await this.start();
    if (!this.connection || this.closed) throw new Error("Lean session is not running.");
    await this.connection.sendNotification(method, params);
  }

  async request<T>(
    method: string,
    params: unknown,
    cancellation?: CancellationToken,
  ): Promise<T> {
    await this.start();
    return this.sendRequest<T>(
      method,
      params,
      this.options.requestTimeoutMs ?? 15_000,
      cancellation,
    );
  }

  close(): Promise<void> {
    if (!this.stopping) this.stopping = this.shutdown();
    return this.stopping;
  }

  recentLog(): string {
    return this.log.read();
  }

  private async initialize(): Promise<void> {
    this.observer.status({ state: "starting", message: "Starting Lean language server…" });
    try {
      this.processStartedAt = new Date();
      const child = spawn(this.options.executable, [...(this.options.arguments ?? ["serve"])], {
        cwd: resolve(this.options.projectRoot),
        env: this.options.env,
        stdio: "pipe",
        windowsHide: true,
        // On Unix, a process group gives the same cleanup guarantee as taskkill /T.
        detached: process.platform !== "win32",
      });
      this.process = child;
      child.stderr.on("data", (data: Buffer) => this.log.append(data.toString("utf8")));
      child.on("error", (error) => this.fail(`Unable to start Lean: ${error.message}`));
      child.on("exit", (code, signal) => {
        this.processExitedAt = new Date();
        if (!this.closed) {
          this.fail(`Lean exited (${signal ?? code ?? "unknown"}). ${this.log.read().trim()}`);
        }
      });
      // Do not enqueue an initialize write before Node has confirmed that the executable exists.
      await new Promise<void>((resolvePromise, reject) => {
        child.once("spawn", resolvePromise);
        child.once("error", reject);
      });
      if (this.closed || this.failed) throw new Error("Lean startup was interrupted.");

      const connection = createMessageConnection(
        new StreamMessageReader(child.stdout),
        new StreamMessageWriter(child.stdin),
        {
          error: (message) => this.log.append(`${message}\n`),
          warn: (message) => this.log.append(`${message}\n`),
          info: (message) => this.log.append(`${message}\n`),
          log: (message) => this.log.append(`${message}\n`),
        },
      );
      this.connection = connection;
      connection.onNotification((method, params) => {
        if (!this.closed && !this.failed) this.observer.notification(method, params);
      });
      connection.onRequest("workspace/configuration", (params: unknown) => {
        const items = LeanProtocol.record(params)?.items;
        return Array.isArray(items) ? items.map(() => null) : [];
      });
      connection.onRequest("window/workDoneProgress/create", () => null);
      connection.onRequest("client/registerCapability", () => null);
      connection.onRequest("client/unregisterCapability", () => null);
      connection.onRequest("window/showMessageRequest", () => null);
      connection.onError((error) => this.fail(`Lean protocol error: ${error[0].message}`));
      connection.onClose(() => {
        if (!this.closed) this.fail("Lean language server connection closed.");
      });
      connection.listen();

      const rootUri = pathToFileURL(resolve(this.options.projectRoot)).href;
      await this.sendRequest("initialize", {
        processId: process.pid,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: "Obsidian Lean project" }],
        clientInfo: { name: "lean4-obsidian-plugin", version: "0.1.0" },
        capabilities: {
          general: { positionEncodings: ["utf-16"] },
          textDocument: {
            synchronization: { didSave: false },
            publishDiagnostics: { versionSupport: true },
          },
          workspace: { configuration: true, workspaceFolders: true },
        },
        initializationOptions: { hasWidgets: false },
      }, this.options.startupTimeoutMs ?? 30_000);
      if (this.closed || this.failed) throw new Error("Lean startup was interrupted.");
      await connection.sendNotification("initialized", {});
      this.ready = true;
      this.observer.status({ state: "ready" });
    } catch (error) {
      this.fail(`Lean startup failed: ${LeanProtocol.message(error)}`);
      await this.terminateProcessTree();
      this.connection?.dispose();
      throw new Error(`Lean startup failed: ${LeanProtocol.message(error)}${this.log.read().trim() ? `\n${this.log.read().trim()}` : ""}`);
    }
  }

  private async sendRequest<T>(
    method: string,
    params: unknown,
    timeoutMs: number,
    cancellation?: CancellationToken,
  ): Promise<T> {
    const connection = this.connection;
    if (!connection) throw new Error("Lean language server is unavailable.");
    if (this.wireRequests.size >= 32) {
      this.fail("Lean is not answering cancelled requests. Restart the Lean service.");
      connection.dispose();
      throw new Error("Too many unanswered Lean requests. Restart the Lean service.");
    }
    if (cancellation?.isCancellationRequested) throw new Error("Lean request cancelled.");
    const token = new CancellationTokenSource();
    this.pending.add(token);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelSubscription: { dispose(): void } | undefined;
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Lean request ${method} timed out after ${timeoutMs} ms.`));
          token.cancel();
        }, timeoutMs);
        cancelSubscription = cancellation?.onCancellationRequested(() => {
          token.cancel();
          reject(new Error("Lean request cancelled."));
        });
        // Shutdown must reject immediately even when the server ignores $/cancelRequest.
        token.token.onCancellationRequested(() => reject(new Error("Lean request cancelled.")));
      });
      const response = connection.sendRequest<T>(method, params, token.token);
      this.wireRequests.add(response);
      void response.then(
        () => this.wireRequests.delete(response),
        () => this.wireRequests.delete(response),
      );
      return await Promise.race([response, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
      cancelSubscription?.dispose();
      this.pending.delete(token);
      token.dispose();
    }
  }

  private fail(message: string): void {
    if (this.closed || this.failed) return;
    this.failed = true;
    this.ready = false;
    this.log.append(`${message}\n`);
    for (const pending of this.pending) pending.cancel();
    this.observer.status({ state: "error", message: message.slice(-4_096) });
    // A protocol failure may leave the watchdog alive. Reap it as well.
    void this.terminateProcessTree();
  }

  private async shutdown(): Promise<void> {
    const wasReady = this.ready && !this.failed;
    this.closed = true;
    this.ready = false;
    for (const pending of this.pending) pending.cancel();
    if (wasReady && this.connection) {
      try {
        await this.sendRequest("shutdown", null, this.options.shutdownTimeoutMs ?? 1_500);
        // Keep the parent alive until tree cleanup. On Windows, sending exit first loses
        // taskkill's ancestry anchor if an evaluated command has spawned child processes.
      } catch {
        // An unresponsive worker still has to be reclaimed when the plugin unloads.
      }
    }
    await this.terminateProcessTree();
    this.connection?.dispose();
    this.connection = undefined;
    this.process?.stdin.destroy();
    this.process?.stdout.destroy();
    this.process?.stderr.destroy();
    this.observer.status({ state: "stopped" });
  }

  private async waitForExit(timeoutMs: number): Promise<void> {
    const child = this.process;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolvePromise) => {
      const timer = setTimeout(() => {
        child.removeListener("exit", exited);
        resolvePromise();
      }, timeoutMs);
      const exited = (): void => {
        clearTimeout(timer);
        resolvePromise();
      };
      child.once("exit", exited);
    });
  }

  private terminateProcessTree(): Promise<void> {
    if (!this.terminating) this.terminating = this.terminateOwnedTree();
    return this.terminating;
  }

  private async terminateOwnedTree(): Promise<void> {
    const child = this.process;
    if (!child?.pid) return;
    if (process.platform === "win32") {
      if (child.exitCode === null && child.signalCode === null) await new Promise<void>((resolvePromise) => {
        const killer = spawn(
          join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
          ["/PID", String(child.pid), "/T", "/F"],
          { stdio: "ignore", windowsHide: true },
        );
        const timer = setTimeout(() => {
          killer.kill();
          child.kill();
          resolvePromise();
        }, 3_000);
        killer.once("error", () => {
          clearTimeout(timer);
          child.kill();
          resolvePromise();
        });
        killer.once("exit", () => {
          clearTimeout(timer);
          resolvePromise();
        });
      });
      // If the root crashed before taskkill could act, recover only identity-checked
      // descendants whose ancestry still exists in the OS process snapshot.
      if (this.failed) {
        try {
          await new WindowsProcessTree().reapOrphans(
            child.pid,
            this.processStartedAt,
            this.processExitedAt ?? new Date(),
          );
        } catch (error) {
          this.log.append(`${LeanProtocol.message(error)}\n`);
        }
      }
    } else {
      // A process group survives its leader: always try the group, even after parent exit.
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
    await this.waitForExit(1_000);
  }
}
