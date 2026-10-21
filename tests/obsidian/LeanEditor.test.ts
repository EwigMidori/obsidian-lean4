// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App, MarkdownFileInfo } from "obsidian";
import { LeanEditor } from "../../src/obsidian/LeanEditor";
import { LeanSettings } from "../../src/obsidian/LeanSettings";
import { ObsidianProofHost } from "../../src/obsidian/ObsidianProofHost";
import { FakeLeanGateway } from "./fixtures/FakeLeanGateway";
import { editorInfoField, TFile } from "./fixtures/ObsidianApiStub";

vi.mock("../../src/infrastructure/LeanLanguageServerGateway", async () => ({
  LeanLanguageServerGateway: (await import("./fixtures/FakeLeanGateway")).FakeLeanGateway
}));
vi.mock("../../src/infrastructure/ManagedLeanEnvironment", async () => ({
  ManagedLeanEnvironment: (await import("./fixtures/FakeManagedEnvironment")).FakeManagedEnvironment
}));

class EditorHarness {
  readonly host = new ObsidianProofHost({} as App, LeanSettings.from({ projectRoot: "/test/project" }));
  readonly errors: unknown[] = [];
  readonly fallbackKeys: string[] = [];
  view: EditorView | null = null;

  mount(text: string, cursor = text.length, readonly = false, editable = true): EditorView {
    this.view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: text,
        selection: { anchor: cursor },
        extensions: [
          editorInfoField.init(() => ({ file: new TFile("note.md") } as unknown as MarkdownFileInfo)),
          EditorState.readOnly.of(readonly),
          EditorView.editable.of(editable),
          EditorView.exceptionSink.of(error => this.errors.push(error)),
          new LeanEditor(this.host).extension(),
          keymap.of([
            { key: "Tab", run: view => this.originalEditorKey(view, "Tab", "\t") },
            { key: "Enter", run: view => this.originalEditorKey(view, "Enter", "\n") }
          ])
        ]
      })
    });
    return this.view;
  }

  press(key: string): void {
    this.view!.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  }

  async settle(): Promise<void> {
    for (let iteration = 0; iteration < 8; iteration++) await Promise.resolve();
  }

  async destroy(): Promise<void> {
    this.view?.destroy();
    this.view = null;
    await this.host.dispose();
    document.body.replaceChildren();
  }

  private originalEditorKey(view: EditorView, key: string, insert: string): boolean {
    this.fallbackKeys.push(key);
    if (view.state.readOnly || !view.state.facet(EditorView.editable)) return false;
    const selection = view.state.selection.main;
    view.dispatch({
      changes: { from: selection.from, to: selection.to, insert },
      selection: { anchor: selection.from + insert.length }
    });
    return true;
  }
}

describe("LeanEditor inside a real CodeMirror EditorView", () => {
  let harness: EditorHarness;
  beforeEach(() => {
    FakeLeanGateway.instances.length = 0;
    harness = new EditorHarness();
  });
  afterEach(async () => {
    const errors = [...harness.errors];
    await harness.destroy();
    expect(errors).toEqual([]);
  });

  it("lets the original editor handle Enter and Tab in ordinary Markdown", async () => {
    const view = harness.mount("A normal paragraph \\alpha");
    harness.press("Tab");
    harness.press("Enter");
    await harness.settle();
    expect(harness.fallbackKeys).toEqual(["Tab", "Enter"]);
    expect(view.state.doc.toString()).toBe("A normal paragraph \\alpha\t\n");
  });

  it("expands a known Unicode sequence only inside a Lean block", async () => {
    const text = "```lean\n#check \\alpha\n```";
    const view = harness.mount(text, text.indexOf("\\alpha") + "\\alpha".length);
    harness.press("Tab");
    await harness.settle();
    expect(view.state.doc.toString()).toBe("```lean\n#check α\n```");
    expect(harness.fallbackKeys).toEqual([]);
    expect(harness.host.blocksForNote("note.md")[0]!.code).toContain("α");
  });

  it("preserves indentation and adds one Lean indentation level after by", async () => {
    const text = "```lean\n  example : True := by\n```";
    const view = harness.mount(text, text.indexOf("\n```", 4));
    harness.press("Enter");
    await harness.settle();
    expect(view.state.doc.toString()).toBe("```lean\n  example : True := by\n    \n```");
    expect(harness.fallbackKeys).toEqual([]);
  });

  it("supports Unicode and indentation at the end of an unfinished Lean fence", async () => {
    const view = harness.mount("```lean\n#check \\alpha");
    harness.press("Tab");
    await harness.settle();
    expect(view.state.doc.toString()).toBe("```lean\n#check α");
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\nexample : True := by" } });
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    harness.press("Enter");
    await harness.settle();
    expect(view.state.doc.toString()).toBe("```lean\n#check α\nexample : True := by\n  ");
    expect(harness.fallbackKeys).toEqual([]);
  });

  it("leaves a closed fence and its empty block boundary to Markdown", async () => {
    const text = "```lean\n```";
    const view = harness.mount(text, text.indexOf("\n") + 1);
    harness.press("Tab");
    await harness.settle();
    expect(harness.fallbackKeys).toEqual(["Tab"]);
    expect(view.state.doc.toString()).toBe("```lean\n\t```");
  });

  it("never edits a read-only view and releases its note when destroyed", async () => {
    const text = "```lean\n#check \\alpha\n```";
    const view = harness.mount(text, text.indexOf("\\alpha") + 6, true);
    harness.press("Tab");
    harness.press("Enter");
    await harness.settle();
    expect(view.state.doc.toString()).toBe(text);
    expect(harness.host.blocksForNote("note.md")).toHaveLength(1);
    view.destroy();
    harness.view = null;
    await harness.settle();
    expect(harness.host.blocksForNote("note.md")).toEqual([]);
  });

  it("never edits a non-editable view even when its state is not read-only", async () => {
    const text = "```lean\n#check \\alpha\n```";
    const view = harness.mount(text, text.indexOf("\\alpha") + 6, false, false);
    harness.press("Tab");
    harness.press("Enter");
    await harness.settle();
    expect(view.state.doc.toString()).toBe(text);
  });

  it("handles document changes and later diagnostics without recursive update dispatch", async () => {
    const text = "```lean\n#check missing\n```";
    const view = harness.mount(text, text.indexOf("missing") + 7);
    const block = harness.host.blocksForNote("note.md")[0]!;
    harness.host.checkBlock(block.id);
    await harness.settle();
    const gateway = FakeLeanGateway.instances[0]!;
    const document = gateway.documents.get(block.documentId!)!;
    expect(document).toBeDefined();
    await Promise.resolve();
    gateway.diagnostics(document, [{
      range: { start: { line: 0, character: 7 }, end: { line: 0, character: 14 } },
      severity: "error",
      message: "Unknown identifier missing"
    }]);
    await harness.settle();
    expect(view.dom.querySelector(".lean4-diagnostic-error")?.textContent).toBe("missing");

    view.dispatch({ changes: { from: text.indexOf("missing"), to: text.indexOf("missing") + 7, insert: "Nat" } });
    await harness.settle();
    expect(view.dom.querySelector(".lean4-diagnostic-error")).toBeNull();
    expect(view.state.doc.toString()).toBe("```lean\n#check Nat\n```");
    expect(harness.errors).toEqual([]);
  });

  it("shows a fence title and updates metadata without requiring code edits", async () => {
    const text = '```lean check=off title="Syntax example"\n#check Nat\n```';
    const view = harness.mount(text, text.indexOf("#check"));
    await harness.settle();
    expect(view.dom.querySelector(".lean4-status")?.textContent).toBe("Syntax example · Display only");
    const from = text.indexOf("Syntax example");
    view.dispatch({ changes: { from, to: from + "Syntax example".length, insert: "Renamed" } });
    await harness.settle();
    expect(view.dom.querySelector(".lean4-status")?.textContent).toBe("Renamed · Display only");
    expect(FakeLeanGateway.instances[0]!.documents.size).toBe(0);
  });

  it("makes shared context and excluded examples visible in editor badges", async () => {
    const text = '```lean session=algebra title="Definitions"\ndef n := 1\n```\n\n```lean session=algebra check=off\nnot Lean\n```';
    const view = harness.mount(text, text.indexOf("def n"));
    await harness.settle();
    const labels = [...view.dom.querySelectorAll(".lean4-status")].map(element => element.textContent);
    expect(labels).toContain("Definitions · Session: algebra · Not checked");
    expect(labels).toContain("Excluded from session: algebra · Display only");
    expect(FakeLeanGateway.instances[0]!.documents.size).toBe(0);
  });
});
