import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { EnvironmentCommand } from "./EnvironmentCommand";

export interface ElanInstallation {
  readonly executable: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface LeanEnvironmentRuntime {
  readonly projectRoot: string;
  readonly lakeExecutable: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** Finds a pinned local toolchain without executing a shim which might download implicitly. */
export class LeanToolchainDiscovery {
  static readonly toolchain = "leanprover/lean4:v4.35.0";

  constructor(private readonly command = new EnvironmentCommand()) {}

  async managers(cacheRoot: string, signal?: AbortSignal): Promise<readonly ElanInstallation[]> {
    const suffix = process.platform === "win32" ? ".exe" : "";
    const privateHome = join(cacheRoot, "elan");
    const userHome = process.env.ELAN_HOME || join(homedir(), ".elan");
    const candidates: ElanInstallation[] = [
      { executable: join(privateHome, "bin", `elan${suffix}`), env: { ...process.env, ELAN_HOME: privateHome } },
      { executable: join(userHome, "bin", `elan${suffix}`), env: { ...process.env } },
      ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => ({
        executable: join(directory.replace(/^"|"$/g, ""), `elan${suffix}`),
        env: { ...process.env },
      })),
    ];
    const result: ElanInstallation[] = [];
    const visited = new Set<string>();
    for (const candidate of candidates) {
      if (signal?.aborted) throw new Error("Lean environment preparation cancelled.");
      const key = process.platform === "win32" ? resolve(candidate.executable).toLowerCase() : resolve(candidate.executable);
      if (visited.has(key)) continue;
      visited.add(key);
      try {
        await access(candidate.executable);
        const version = await this.command.run(candidate.executable, ["--version"], { env: candidate.env, signal, timeoutMs: 5_000 });
        if (/\belan \d/.test(version)) result.push(candidate);
      } catch (error) {
        if (signal?.aborted) throw error;
        // A desktop launch often has a smaller PATH; try the next known location.
      }
    }
    return result;
  }

  async installed(cacheRoot: string, projectRoot: string, signal?: AbortSignal): Promise<LeanEnvironmentRuntime | undefined> {
    for (const manager of await this.managers(cacheRoot, signal)) {
      try {
        const installed = await this.command.run(manager.executable, ["toolchain", "list"], { env: manager.env, signal });
        if (!installed.split(/\r?\n/).some((line) => line.trim().split(/\s/)[0] === LeanToolchainDiscovery.toolchain)) continue;
        const env = {
          ...manager.env,
          ELAN_TOOLCHAIN: LeanToolchainDiscovery.toolchain,
          PATH: `${dirname(manager.executable)}${delimiter}${manager.env.PATH ?? ""}`,
        };
        const lake = (await this.command.run(manager.executable, ["which", "lake"], { cwd: projectRoot, env, signal })).trim();
        await access(lake);
        return { projectRoot, lakeExecutable: lake, env };
      } catch (error) {
        if (signal?.aborted) throw error;
      }
    }
    // A standalone installation can be used too. Do not invoke neighboring elan shims:
    // their toolchain availability was checked above, without any network activity.
    const suffix = process.platform === "win32" ? ".exe" : "";
    for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
      if (signal?.aborted) throw new Error("Lean environment preparation cancelled.");
      const bin = directory.replace(/^"|"$/g, "");
      try { await access(join(bin, `elan${suffix}`)); continue; } catch { /* Standalone candidate. */ }
      const lake = join(bin, `lake${suffix}`);
      try {
        await access(lake);
        const version = await this.command.run(lake, ["--version"], { cwd: projectRoot, signal });
        if (/\bLean version 4\.35\.0\b/.test(version)) return { projectRoot, lakeExecutable: lake };
      } catch (error) {
        if (signal?.aborted) throw error;
      }
    }
    return undefined;
  }
}
