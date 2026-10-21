import { afterEach, describe, expect, it, vi } from "vitest";
import { LeanI18n, type LeanTextKey } from "../../src/obsidian/LeanI18n";
import { ObsidianLocale } from "./fixtures/ObsidianApiStub";

class TranslationContract {
  static parameters(text: string): readonly string[] {
    return [...new Set([...text.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/gu)].map((match) => match[1]!))].sort();
  }
}

describe("Lean UI localization", () => {
  afterEach(() => { ObsidianLocale.set("en"); });

  it("keeps every translated key and interpolation parameter complete", () => {
    const english = LeanI18n.catalog("en");
    const chinese = LeanI18n.catalog("zh-CN");
    expect(Object.keys(chinese).sort()).toEqual(Object.keys(english).sort());
    for (const key of Object.keys(english) as LeanTextKey[]) {
      expect(chinese[key].trim(), key).not.toBe("");
      expect(TranslationContract.parameters(chinese[key]), key)
        .toEqual(TranslationContract.parameters(english[key]));
    }
  });

  it.each(["zh", "zh-CN", "zh_Hans", "zh-Hans", "zh-Hans-CN", "ZH-cn"])(
    "uses Simplified Chinese for Obsidian locale %s",
    (language) => {
      ObsidianLocale.set(language);
      expect(LeanI18n.locale()).toBe("zh-CN");
      expect(LeanI18n.text("block.check")).toBe("检查代码块");
    },
  );

  it.each(["en", "en-US", "fr", "de", "zh-TW", ""])(
    "falls back to English for unsupported Obsidian locale %s",
    (language) => {
      ObsidianLocale.set(language);
      expect(LeanI18n.locale()).toBe("en");
      expect(LeanI18n.text("block.check")).toBe("Check block");
    },
  );

  it("follows the current host language without a separate plugin setting", () => {
    ObsidianLocale.set("en");
    expect(LeanI18n.text("view.messages")).toBe("Messages");
    ObsidianLocale.set("zh");
    expect(LeanI18n.text("view.messages")).toBe("消息");
    ObsidianLocale.set("en");
    expect(LeanI18n.text("view.messages")).toBe("Messages");
  });

  it("interpolates counts and user labels literally without reprocessing their contents", () => {
    ObsidianLocale.set("zh");
    expect(LeanI18n.text("count.errors", { count: 3 })).toBe("3 个错误");
    expect(LeanI18n.text("diagnostic.position", { line: 2, column: 7 })).toBe("行 2 · 列 7");
    const name = '自然数 <b>$&{count}</b>';
    expect(LeanI18n.text("session.label", { name })).toBe(`会话：${name}`);
    ObsidianLocale.set("en");
    expect(LeanI18n.text("block.checkSessionDescription", { name })).toContain(`“${name}”`);
  });

  it("supports older Obsidian versions without the public language API", async () => {
    vi.resetModules();
    vi.doMock("obsidian", () => ({ getLanguage: undefined }));
    try {
      const { LeanI18n: legacy } = await import("../../src/obsidian/LeanI18n");
      expect(legacy.locale()).toBe("en");
      expect(legacy.text("block.check")).toBe("Check block");
    } finally {
      vi.doUnmock("obsidian");
      vi.resetModules();
    }
  });
});
