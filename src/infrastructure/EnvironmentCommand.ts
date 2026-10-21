import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { BoundedLog } from "./BoundedLog";

export interface EnvironmentCommandOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly onOutput?: (text: string) => void;
}

/** Owns cancellable discovery and installation commands, outside the LSP startup timeout. */
export class EnvironmentCommand {
  async run(executable: string, args: readonly string[], options: EnvironmentCommandOptions = {}): Promise<string> {
    if (options.signal?.aborted) throw new Error("Lean environment preparation cancelled.");
    const log = new BoundedLog();
    return new Promise<string>((resolvePromise, reject) => {
      const child = spawn(executable, [...args], {
        cwd: options.cwd,
        env: options.env,
        stdio: "pipe",
        windowsHide: true,
        detached: process.platform !== "win32",
      });
      let settled = false;
      let stopping = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", aborted);
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        if (error) reject(error);
        else resolvePromise(log.read());
      };
      const stop = (message: string): void => {
        if (stopping || settled) return;
        stopping = true;
        void this.stop(child).finally(() => finish(new Error(message)));
      };
      const aborted = (): void => stop("Lean environment preparation cancelled.");
      const timer = setTimeout(
        () => stop(`Lean environment command timed out. ${log.read().trim()}`),
        options.timeoutMs ?? 10_000,
      );
      const output = (data: Buffer): void => {
        const text = data.toString("utf8");
        log.append(text);
        options.onOutput?.(text);
      };
      child.stdout.on("data", output);
      child.stderr.on("data", output);
      child.once("error", (error) => finish(new Error(`Cannot run ${executable}: ${error.message}`)));
      child.once("close", (code, signal) => {
        if (stopping) return;
        finish(code === 0 ? undefined : new Error(`${executable} exited (${signal ?? code}). ${log.read().trim()}`));
      });
      options.signal?.addEventListener("abort", aborted, { once: true });
      if (options.signal?.aborted) aborted();
    });
  }

  private async stop(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (!child.pid) return;
    if (process.platform === "win32") {
      await new Promise<void>((resolvePromise) => {
        const killer = spawn(
          join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
          ["/PID", String(child.pid), "/T", "/F"],
          { stdio: "ignore", windowsHide: true },
        );
        const timer = setTimeout(() => { killer.kill(); child.kill(); resolvePromise(); }, 3_000);
        killer.once("error", () => { clearTimeout(timer); child.kill(); resolvePromise(); });
        killer.once("exit", () => { clearTimeout(timer); resolvePromise(); });
      });
    } else {
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }
  }
}
