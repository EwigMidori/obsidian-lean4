// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App, MarkdownPostProcessorContext } from "obsidian";
import { LeanReadingBlock } from "../../src/obsidian/LeanReadingBlock";
import { LeanSettings } from "../../src/obsidian/LeanSettings";
import { ObsidianProofHost } from "../../src/obsidian/ObsidianProofHost";
import { FakeLeanGateway } from "./fixtures/FakeLeanGateway";
import { ObsidianDom, setLanguage, TFile } from "./fixtures/ObsidianApiStub";

vi.mock("../../src/infrastructure/LeanLanguageServerGateway", async () => ({
  LeanLanguageServerGateway: (await import("./fixtures/FakeLeanGateway")).FakeLeanGateway
}));
vi.mock("../../src/infrastructure/ManagedLeanEnvironment", async () => ({
  ManagedLeanEnvironment: (await import("./fixtures/FakeManagedEnvironment")).FakeManagedEnvironment
}));

class ReadingHarness {
  readonly file = new TFile("note.md");
  readonly read = vi.fn<() => Promise<string>>();
  readonly host = new ObsidianProofHost({
    vault: {
      getAbstractFileByPath: () => this.file,
      cachedRead: () => this.read()
    }
  } as unknown as App, LeanSettings.from({ projectRoot: "/test/project" }));
  readonly readers: LeanReadingBlock[] = [];

  mount(source: string, language = "lean", lineStart = 0, parent = document.body): HTMLElement {
    const container = document.createElement("div");
    parent.append(container);
    const context = {
      sourcePath: this.file.path,
      getSectionInfo: () => ({ lineStart, lineEnd: lineStart + 2, text: source })
    } as unknown as MarkdownPostProcessorContext;
    const reader = new LeanReadingBlock(container, source, language, context, this.host);
    this.readers.push(reader);
    reader.load();
    return container;
  }

  async settle(): Promise<void> {
    for (let iteration = 0; iteration < 8; iteration++) await Promise.resolve();
  }

  async dispose(): Promise<void> {
    for (const reader of this.readers) reader.unload();
    await this.host.dispose();
    document.body.replaceChildren();
  }
}

describe("LeanReadingBlock public renderer lifecycle", () => {
  let harness: ReadingHarness;
  beforeEach(() => {
    ObsidianDom.install();
    setLanguage("en");
    FakeLeanGateway.instances.length = 0;
    harness = new ReadingHarness();
  });
  afterEach(async () => { setLanguage("en"); await harness.dispose(); });

  it("renders localized icon labels and removes its docked button on real renderer unload", async () => {
    setLanguage("zh");
    harness.read.mockResolvedValue('```lean title="示例" session=proof\n#check Nat\n```');
    const embed = document.body.createDiv({ cls: "cm-embed-block" });
    const container = harness.mount("#check Nat", "lean", 0, embed);
    const toolbar = embed.createDiv({ cls: "embed-actions" });
    const source = toolbar.createEl("button", { cls: "embed-action edit-block-button" });
    await harness.settle();
    const check = toolbar.querySelector<HTMLButtonElement>(".lean4-check-action")!;
    expect(check.getAttribute("aria-label")).toBe("检查会话");
    expect(check.title).toContain("proof");
    expect(check.nextElementSibling).toBe(source);
    expect(container.querySelector(".lean4-status")?.textContent).toBe("未检查");
    expect(container.querySelector(".lean4-session-context")?.textContent).toBe("会话：proof");
    harness.readers[0]!.unload();
    await harness.settle();
    expect([...toolbar.children]).toEqual([source]);
  });

  it("renders source, checks explicitly, and releases a reading-only note on unload", async () => {
    harness.read.mockResolvedValue("```lean\n#check missing\n```");
    const container = harness.mount("#check missing");
    await harness.settle();
    expect(container.querySelector("code")?.textContent).toBe("#check missing");
    expect(container.querySelector(".lean4-status")?.textContent).toBe("Not checked");
    expect(FakeLeanGateway.instances[0]!.documents.size).toBe(0);

    container.querySelector("button")!.click();
    await harness.settle();
    const block = harness.host.blocksForNote("note.md")[0]!;
    const gateway = FakeLeanGateway.instances[0]!;
    gateway.diagnostics(gateway.documents.get(block.documentId!)!, [{
      range: { start: { line: 0, character: 7 }, end: { line: 0, character: 14 } },
      severity: "error",
      message: "Unknown identifier missing"
    }]);
    await harness.settle();
    expect(container.querySelector(".lean4-message-error")?.textContent).toContain("Unknown identifier missing");
    expect(container.querySelector(".lean4-status")?.classList.contains("lean4-status-error")).toBe(true);
    gateway.diagnostics(gateway.documents.get(block.documentId!)!, [{
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      severity: "warning",
      message: "declaration uses sorry"
    }]);
    await harness.settle();
    expect(container.querySelector(".lean4-status")?.classList.contains("lean4-status-warning")).toBe(true);
    gateway.diagnostics(gateway.documents.get(block.documentId!)!, []);
    gateway.progress(gateway.documents.get(block.documentId!)!, false);
    await harness.settle();
    expect(container.querySelector(".lean4-status")?.classList.contains("lean4-status-checked")).toBe(true);

    harness.readers[0]!.unload();
    await harness.settle();
    expect(harness.host.blocksForNote("note.md")).toEqual([]);
    expect(gateway.closed).toEqual([block.documentId]);
  });

  it("maps identical rendered blocks by their sections and preserves the remaining lease", async () => {
    const note = "```lean\n#check Nat\n```\n\n```lean\n#check Nat\n```";
    harness.read.mockResolvedValue(note);
    const first = harness.mount("#check Nat", "lean", 0);
    const second = harness.mount("#check Nat", "lean", 4);
    await harness.settle();
    const blocks = harness.host.blocksForNote("note.md");
    second.querySelector("button")!.click();
    await harness.settle();
    expect([...FakeLeanGateway.instances[0]!.documents.keys()]).toEqual([blocks[1]!.documentId]);
    expect(first.querySelector(".lean4-status")?.textContent).toBe("Not checked");
    harness.readers[0]!.unload();
    expect(harness.host.blocksForNote("note.md")).toHaveLength(2);
    harness.readers[1]!.unload();
    expect(harness.host.blocksForNote("note.md")).toEqual([]);
  });

  it("keeps display-only examples unchecked", async () => {
    harness.read.mockResolvedValue("```lean-example\nthis is intentionally invalid\n```");
    const container = harness.mount("this is intentionally invalid", "lean-example");
    await harness.settle();
    expect(container.querySelector(".lean4-status")?.textContent).toBe("Display only");
    expect(container.querySelector("button")!.hidden).toBe(true);
    container.querySelector("button")!.click();
    await harness.settle();
    expect(FakeLeanGateway.instances[0]!.documents.size).toBe(0);
  });

  it("uses original fence metadata to distinguish identical checked and display-only examples", async () => {
    harness.read.mockResolvedValue('```lean check=off title="Syntax"\n#check Nat\n```\n\n```lean check=on title="Verified"\n#check Nat\n```');
    const display = harness.mount("#check Nat", "lean", 0);
    const checked = harness.mount("#check Nat", "lean", 4);
    await harness.settle();
    const blocks = harness.host.blocksForNote("note.md");
    expect(display.querySelector(".lean4-reading-language")?.textContent).toBe("Syntax");
    expect(display.querySelector(".lean4-status")?.textContent).toBe("Display only");
    expect(display.querySelector("button")!.hidden).toBe(true);
    expect(checked.querySelector(".lean4-reading-language")?.textContent).toBe("Verified");
    display.querySelector("button")!.click();
    checked.querySelector("button")!.click();
    await harness.settle();
    expect([...FakeLeanGateway.instances[0]!.documents.keys()]).toEqual([blocks[1]!.documentId]);
  });

  it("disables checking and explains invalid fence metadata", async () => {
    harness.read.mockResolvedValue('```lean check=maybe title="Example"\n#check Nat\n```');
    const container = harness.mount("#check Nat");
    await harness.settle();
    expect(container.querySelector(".lean4-status")?.textContent).toBe("Invalid block options");
    expect(container.querySelector(".lean4-message-error")?.textContent).toContain("check");
    expect(container.querySelector("button")!.hidden).toBe(true);
    container.querySelector("button")!.click();
    await harness.settle();
    expect(FakeLeanGateway.instances[0]!.documents.size).toBe(0);
  });

  it("checks a whole session from its later block while excluding display-only examples", async () => {
    harness.read.mockResolvedValue('```lean session=shared\ndef sharedValue := 7\n```\n\n```lean session=shared check=off\nthis is not Lean\n```\n\n```lean session=shared\n#check sharedValue\n```');
    const first = harness.mount("def sharedValue := 7", "lean", 0);
    const excluded = harness.mount("this is not Lean", "lean", 4);
    const last = harness.mount("#check sharedValue", "lean", 8);
    await harness.settle();
    expect(first.querySelector(".lean4-session-context")?.textContent).toBe("Session: shared");
    expect(last.querySelector("button")?.getAttribute("aria-label")).toBe("Check session");
    expect(excluded.querySelector(".lean4-session-context")?.textContent).toBe("Excluded from session: shared");
    expect(excluded.querySelector("button")!.hidden).toBe(true);
    last.querySelector("button")!.click();
    await harness.settle();
    const documents = [...FakeLeanGateway.instances[0]!.documents.values()];
    expect(documents).toHaveLength(1);
    expect(documents[0]!.code.indexOf("def sharedValue")).toBeLessThan(documents[0]!.code.indexOf("#check sharedValue"));
    expect(documents[0]!.code).not.toContain("this is not Lean");
    expect(first.querySelector(".lean4-status")?.textContent).toBe("Checking");
    expect(excluded.querySelector(".lean4-status")?.textContent).toBe("Display only");
  });

  it("keeps identical code in different sessions attached to the correct rendered section", async () => {
    harness.read.mockResolvedValue('```lean session=one\n#check Nat\n```\n\n```lean session=two\n#check Nat\n```');
    const first = harness.mount("#check Nat", "lean", 0);
    const second = harness.mount("#check Nat", "lean", 4);
    await harness.settle();
    expect(first.querySelector(".lean4-session-context")?.textContent).toBe("Session: one");
    expect(second.querySelector(".lean4-session-context")?.textContent).toBe("Session: two");
    second.querySelector("button")!.click();
    await harness.settle();
    expect(first.querySelector(".lean4-status")?.textContent).toBe("Not checked");
    expect(second.querySelector(".lean4-status")?.textContent).toBe("Checking");
    expect(FakeLeanGateway.instances[0]!.documents.size).toBe(1);
  });

  it("shows a session diagnostic only on its owning block and removes it after upstream edits", async () => {
    const note = '```lean session=shared\ndef n := 1\n```\n\n```lean session=shared\n#check missing\n```';
    harness.read.mockResolvedValue(note);
    const first = harness.mount("def n := 1", "lean", 0);
    const second = harness.mount("#check missing", "lean", 4);
    await harness.settle();
    second.querySelector("button")!.click();
    await harness.settle();
    const gateway = FakeLeanGateway.instances[0]!;
    const document = [...gateway.documents.values()][0]!;
    const prefix = document.code.slice(0, document.code.indexOf("missing"));
    const line = prefix.split("\n").length - 1;
    const character = prefix.length - prefix.lastIndexOf("\n") - 1;
    gateway.diagnostics(document, [{
      range: { start: { line, character }, end: { line, character: character + 7 } },
      severity: "error",
      message: "Unknown identifier missing"
    }]);
    await harness.settle();
    expect(first.querySelector(".lean4-message-error")).toBeNull();
    expect(second.querySelector(".lean4-message-position")?.textContent).toBe("Line 1 · Column 8");
    expect(second.querySelector(".lean4-message-body")?.textContent).toBe("Unknown identifier missing");

    harness.host.bindEditor({}, "note.md", note.replace("def n := 1", "def missing := 1"));
    await harness.settle();
    expect(second.querySelector(".lean4-message-error")).toBeNull();
    // An old response for the previous shared document cannot restore that error.
    gateway.diagnostics(document, [{
      range: { start: { line, character }, end: { line, character: character + 7 } },
      severity: "error",
      message: "Old error"
    }]);
    await harness.settle();
    expect(second.querySelector(".lean4-message-error")).toBeNull();
  });
});
