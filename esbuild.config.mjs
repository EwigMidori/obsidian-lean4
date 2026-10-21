import esbuild from "esbuild";
import { readFileSync } from "node:fs";

class PluginBuild {
  async run() {
    const production = process.argv.includes("production");
    const context = await esbuild.context({
      entryPoints: ["src/main.ts"],
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "es2022",
      external: [
        "obsidian",
        "electron",
        "@codemirror/state",
        "@codemirror/view",
        "@codemirror/language",
        "@lezer/common",
        "@lezer/highlight"
      ],
      outfile: "main.js",
      sourcemap: production ? false : "inline",
      minify: production,
      logLevel: "info",
      banner: { js: `/* Lean4 — generated file.\n${readFileSync(new URL("./THIRD_PARTY_NOTICES.txt", import.meta.url), "utf8")}\n*/` }
    });
    if (production) {
      await context.rebuild();
      await context.dispose();
    } else {
      await context.watch();
    }
  }
}

await new PluginBuild().run();
