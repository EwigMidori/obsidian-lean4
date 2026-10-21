import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

/** Measures real domain code without booting Obsidian or a Lean subprocess. */
class NotebookBenchmark {
  constructor() {
    this.root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    this.warmup = 8;
    this.samples = 40;
  }

  async run() {
    const domain = await this.loadDomain();
    const results = [];
    for (const blockCount of [100, 1000, 5000]) {
      const markdown = this.notebook(blockCount);
      const parser = new domain.MarkdownBlockParser();
      results.push(
        this.measure("parse", blockCount, markdown, () => {
          const blocks = parser.parse(markdown);
          if (blocks.length !== blockCount) throw new Error("Parser lost blocks");
        }),
      );

      const catalog = new domain.BlockCatalog("benchmark.md");
      catalog.update(markdown);
      const proseVariants = [`说明 A\n\n${markdown}`, `说明 B\n\n${markdown}`];
      let proseIndex = 0;
      results.push(
        this.measure("prose-update", blockCount, markdown, () => {
          const next = proseVariants[proseIndex++ % 2];
          const changes = catalog.update(next);
          if (changes.changed.length !== 0 || changes.added.length !== 0 || changes.removed.length !== 0) {
            throw new Error("A prose-only edit changed code identities");
          }
        }),
      );

      const codeVariants = [
        markdown,
        markdown.replace("def sample_0 : Nat := 0", "def sample_0 : Nat := 1"),
      ];
      catalog.update(codeVariants[0]);
      let codeIndex = 1;
      results.push(
        this.measure("one-block-edit", blockCount, markdown, () => {
          const next = codeVariants[codeIndex++ % 2];
          const changes = catalog.update(next);
          if (changes.changed.length !== 1 || changes.added.length !== 0 || changes.removed.length !== 0) {
            throw new Error("A single block edit did not preserve the catalog");
          }
        }),
      );
    }
    results.push(...this.measureSharedDocuments(domain, 1000, 100));
    const report = {
      measuredAt: new Date().toISOString(),
      environment: {
        platform: process.platform,
        architecture: process.arch,
        node: process.version,
        cpu: os.cpus()[0]?.model ?? "unknown",
        logicalCpus: os.cpus().length,
        memoryGiB: Math.round(os.totalmem() / 1024 ** 3),
      },
      methodology: {
        warmupPerScenario: this.warmup,
        samplesPerScenario: this.samples,
        durationUnit: "milliseconds",
        included: "Production MarkdownBlockParser and BlockCatalog; shared scenarios additionally include DocumentCatalog/ProofDocument; invariant checks, allocations and normal GC",
        excluded: "Module loading, Obsidian/CodeMirror UI, IPC, Lean process startup, elaboration and Mathlib imports",
        note: "Synthetic deterministic notes; elapsed times depend on host load and are not a UI latency guarantee",
      },
      results,
    };
    const outputIndex = process.argv.indexOf("--output");
    if (outputIndex >= 0) {
      const outputArgument = process.argv[outputIndex + 1];
      if (!outputArgument) throw new Error("--output requires a destination");
      const outputPath = path.resolve(this.root, outputArgument);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }
    console.log(JSON.stringify(report, null, 2));
  }

  async loadDomain() {
    const result = await esbuild.build({
      stdin: {
        contents: [
          'export { MarkdownBlockParser } from "./domain/MarkdownBlockParser.ts";',
          'export { BlockCatalog } from "./domain/BlockCatalog.ts";',
          'export { DocumentCatalog } from "./domain/DocumentCatalog.ts";',
        ].join("\n"),
        resolveDir: path.join(this.root, "src"),
        sourcefile: "benchmark-entry.ts",
        loader: "ts",
      },
      bundle: true,
      platform: "node",
      format: "esm",
      target: "es2022",
      write: false,
      logLevel: "silent",
    });
    const output = result.outputFiles[0];
    if (!output) throw new Error("Benchmark module failed to build");
    return import(`data:text/javascript;base64,${Buffer.from(output.contents).toString("base64")}`);
  }

  notebook(blockCount) {
    const sections = ["# 性能示范笔记\n\n"];
    for (let index = 0; index < blockCount; index += 1) {
      sections.push(
        `## 独立示例 ${index}\n\n`,
        "这是一段说明文字。代码块互相独立，编辑说明文字不应重新检查 Lean 内容。\n",
        "同一个笔记中可以包含定义、证明和语法示例；每个块自行声明需要的环境。\n\n",
        "```lean\n",
        `def sample_${index} : Nat := ${index}\n`,
        `example : sample_${index} = ${index} := by\n`,
        "  rfl\n",
        "example (P : Prop) : P → P := by\n",
        "  intro h\n",
        "  exact h\n",
        "```\n\n",
      );
    }
    return sections.join("");
  }

  measureSharedDocuments(domain, blockCount, sessionCount) {
    const markdown = this.sharedNotebook(blockCount, sessionCount);
    const results = [];
    results.push(this.measure("session-initial-build", blockCount, markdown, () => {
      const blocks = new domain.BlockCatalog("shared-benchmark.md");
      const documents = new domain.DocumentCatalog("shared-benchmark.md");
      blocks.update(markdown);
      const change = documents.update(blocks.blocks);
      if (blocks.blocks.length !== blockCount || change.added.length !== sessionCount) {
        throw new Error("Shared document construction lost blocks or groups");
      }
    }, sessionCount));

    for (const [scenario, variants] of [
      ["session-prose-update", [`说明 A\n\n${markdown}`, `说明文字 B\n\n${markdown}`]],
      ["session-title-update", [markdown, markdown.replace('title="步骤 0"', 'title="第一步的新标题"')]],
      ["session-predecessor-edit", [markdown, markdown.replace("def base_0 : Nat := 0", "def base_0 : Nat := 1")]],
    ]) {
      const blocks = new domain.BlockCatalog("shared-benchmark.md");
      const documents = new domain.DocumentCatalog("shared-benchmark.md");
      blocks.update(variants[0]);
      documents.update(blocks.blocks);
      const baseline = new Map(documents.documents.map((document) => [document.id, document.version]));
      const affected = documents.documentFor(blocks.blocks[0].id);
      if (!affected || affected.members.length !== blockCount / sessionCount) {
        throw new Error("Shared benchmark groups are malformed");
      }
      let index = 1;
      results.push(this.measure(scenario, blockCount, markdown, () => {
        const previousVersion = affected.version;
        const blockChanges = blocks.update(variants[index++ % 2]);
        const changes = documents.update(blocks.blocks);
        if (blockChanges.added.length !== 0 || blockChanges.removed.length !== 0
          || changes.added.length !== 0 || changes.removed.length !== 0) {
          throw new Error("An edit lost existing block or document identities");
        }
        if (scenario === "session-predecessor-edit") {
          if (blockChanges.changed.length !== 1 || changes.changed.length !== 1
            || changes.changed[0] !== affected || affected.version !== previousVersion + 1) {
            throw new Error("A predecessor edit did not affect exactly its own session");
          }
          for (const document of documents.documents) {
            if (document !== affected && document.version !== baseline.get(document.id)) {
              throw new Error("A predecessor edit changed an unrelated session");
            }
          }
        } else {
          if (blockChanges.changed.length !== 0 || changes.changed.length !== 0
            || changes.mappingChanged.length !== sessionCount) {
            throw new Error("A presentation edit changed code or failed to move source mappings");
          }
          for (const document of documents.documents) {
            if (document.version !== baseline.get(document.id)) {
              throw new Error("A presentation edit advanced a Lean document version");
            }
          }
        }
      }, sessionCount));
    }
    return results;
  }

  sharedNotebook(blockCount, sessionCount) {
    const sections = ["# 共享 session 性能笔记\n\n"];
    for (let index = 0; index < blockCount; index += 1) {
      const session = index % sessionCount;
      sections.push(
        `## 步骤 ${index}\n\n`,
        "同名 session 的代码按笔记位置共享；这里穿插其他 session 和中文说明。\n\n",
        `\`\`\`lean session=group_${session} title="步骤 ${index}"\n`,
        index < sessionCount
          ? `def base_${session} : Nat := ${session}\n`
          : `example : base_${session} = ${session} := by\n  rfl\n`,
        "```\n\n",
      );
    }
    return sections.join("");
  }

  measure(scenario, blocks, markdown, action, sessions) {
    for (let index = 0; index < this.warmup; index += 1) action();
    const durations = [];
    for (let index = 0; index < this.samples; index += 1) {
      const start = performance.now();
      action();
      durations.push(performance.now() - start);
    }
    durations.sort((left, right) => left - right);
    return {
      scenario,
      blocks,
      ...(sessions === undefined ? {} : { sessions }),
      utf16CodeUnits: markdown.length,
      utf8Bytes: Buffer.byteLength(markdown, "utf8"),
      p50Ms: this.round(durations[Math.ceil(durations.length * 0.5) - 1]),
      p95Ms: this.round(durations[Math.ceil(durations.length * 0.95) - 1]),
      minMs: this.round(durations[0]),
      maxMs: this.round(durations[durations.length - 1]),
    };
  }

  round(value) {
    return Math.round(value * 1000) / 1000;
  }
}

await new NotebookBenchmark().run();
