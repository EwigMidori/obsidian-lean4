import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { get } from "node:https";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { EnvironmentCommand } from "./EnvironmentCommand";
import type { ElanInstallation } from "./LeanToolchainDiscovery";

export interface ElanDownloadProgress {
  readonly downloadedBytes: number;
  readonly totalBytes?: number;
}

export interface ElanDistribution {
  readonly url: string;
  readonly sha256: string;
}

/** Downloads only a pinned official binary, checks its digest, and installs in private ELAN_HOME. */
export class OfficialElanInstaller {
  static readonly release = "v4.2.4";

  distribution(platform = process.platform, architecture = process.arch): ElanDistribution {
    const distributions: Record<string, readonly [string, string]> = {
      "win32-x64": ["x86_64-pc-windows-msvc.zip", "fad2e980a191c15884cc1d80d170ffc5fa84f3774541020145b66d1a644c6111"],
      "darwin-arm64": ["aarch64-apple-darwin.tar.gz", "7ad829861392c718dfebde3a83b5c8508df47be02af68894b094b0b3952616e5"],
      "darwin-x64": ["x86_64-apple-darwin.tar.gz", "8a340b309d8ed2e96f930761fa223b3af57a38f5d253b53ac90293c9516f8cd4"],
      "linux-arm64": ["aarch64-unknown-linux-gnu.tar.gz", "05febd124d84ebf994b2e7479922a5650b1e950c17ae3bd1ddd776b65bb72bf9"],
      "linux-x64": ["x86_64-unknown-linux-gnu.tar.gz", "42b94d4244e8353142c456ec0e4ca6528fd898a6c604d4059f494e706e431f63"],
    };
    const asset = distributions[`${platform}-${architecture}`];
    if (!asset) throw new Error(`Automatic Lean installation is unavailable for ${platform}/${architecture}. Choose an existing Lean project.`);
    return {
      url: `https://github.com/leanprover/elan/releases/download/${OfficialElanInstaller.release}/elan-${asset[0]}`,
      sha256: asset[1],
    };
  }

  async install(
    cacheRoot: string,
    signal?: AbortSignal,
    progress?: (progress: ElanDownloadProgress) => void,
    output?: (text: string) => void,
  ): Promise<ElanInstallation> {
    const distribution = this.distribution();
    await mkdir(cacheRoot, { recursive: true });
    const staging = await mkdtemp(join(cacheRoot, "elan-install-"));
    try {
      const archive = join(staging, distribution.url.endsWith(".zip") ? "elan.zip" : "elan.tar.gz");
      await this.download(distribution, archive, signal, progress);
      const command = new EnvironmentCommand();
      const entries = await command.run("tar", ["-tf", archive], { signal });
      const executableName = process.platform === "win32" ? "elan-init.exe" : "elan-init";
      if (!entries.split(/\r?\n/).filter(Boolean).every((entry) => entry === executableName || entry === `./${executableName}`)) {
        throw new Error("The verified elan archive has an unexpected layout.");
      }
      await command.run("tar", ["-xf", archive, "-C", staging], { signal });
      const installer = join(staging, executableName);
      if (process.platform !== "win32") await chmod(installer, 0o755);
      const privateHome = join(cacheRoot, "elan");
      const env = { ...process.env, ELAN_HOME: privateHome };
      await command.run(installer, ["-y", "--no-modify-path", "--default-toolchain", "none"], {
        env, signal, timeoutMs: 120_000, onOutput: output,
      });
      return { executable: join(privateHome, "bin", process.platform === "win32" ? "elan.exe" : "elan"), env };
    } finally {
      // staging is created by mkdtemp immediately beneath the caller's cache root.
      await rm(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }

  private async download(
    distribution: ElanDistribution,
    destination: string,
    signal?: AbortSignal,
    progress?: (progress: ElanDownloadProgress) => void,
  ): Promise<void> {
    const response = await this.open(distribution.url, signal);
    const total = Number(response.headers["content-length"]);
    const totalBytes = Number.isFinite(total) && total > 0 ? total : undefined;
    const hash = createHash("sha256");
    let downloadedBytes = 0;
    let lastProgress = 0;
    response.on("data", (chunk: Buffer) => {
      downloadedBytes += chunk.length;
      hash.update(chunk);
      if (downloadedBytes > 32 * 1024 * 1024) response.destroy(new Error("Elan download exceeds its expected size."));
      if (Date.now() - lastProgress >= 100) {
        progress?.({ downloadedBytes, totalBytes });
        lastProgress = Date.now();
      }
    });
    await pipeline(response, createWriteStream(destination, { flags: "wx" }), { signal });
    progress?.({ downloadedBytes, totalBytes });
    if (hash.digest("hex") !== distribution.sha256) throw new Error("Elan download checksum did not match the official release. Retry preparation.");
  }

  private open(url: string, signal?: AbortSignal, redirects = 0): Promise<import("node:http").IncomingMessage> {
    if (signal?.aborted) return Promise.reject(new Error("Lean environment preparation cancelled."));
    if (redirects > 5) return Promise.reject(new Error("Too many redirects while downloading elan."));
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return Promise.reject(new Error("Elan downloads require HTTPS."));
    return new Promise((resolvePromise, reject) => {
      const request = get(parsed, { signal, headers: { "User-Agent": "lean4-obsidian-plugin" } }, (response) => {
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
          response.resume();
          void this.open(new URL(response.headers.location, parsed).href, signal, redirects + 1).then(resolvePromise, reject);
        } else if (status === 200) {
          resolvePromise(response);
        } else {
          response.resume();
          reject(new Error(`Cannot download elan (HTTP ${status}). Check your connection and retry.`));
        }
      });
      request.setTimeout(30_000, () => request.destroy(new Error("Elan download stalled. Retry preparation.")));
      request.once("error", reject);
    });
  }
}
