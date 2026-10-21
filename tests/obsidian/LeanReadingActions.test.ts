// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeanIconButton } from "../../src/obsidian/LeanFeedback";
import { LeanReadingActions } from "../../src/obsidian/LeanReadingActions";
import { ObsidianDom } from "./fixtures/ObsidianApiStub";

class ActionsHarness {
  readonly embed = document.body.createDiv({ cls: "cm-preview-code-block cm-embed-block markdown-rendered cm-lang-lean" });
  readonly container = this.embed.createDiv({ cls: "block-language-lean lean4-reading-block" });
  readonly fallback = this.container.createDiv({ cls: "lean4-reading-actions" });
  readonly check = LeanIconButton.create(this.fallback, "play", "Check block");
  readonly actions = new LeanReadingActions(this.container, this.fallback, this.check);

  addSource(): { toolbar: HTMLElement; source: HTMLButtonElement } {
    const toolbar = this.embed.createDiv({ cls: "embed-actions" });
    const source = toolbar.createEl("button", { cls: "embed-action edit-block-button" });
    return { toolbar, source };
  }

  async settle(): Promise<void> {
    for (let index = 0; index < 5; index++) await Promise.resolve();
  }
}

describe("LeanReadingActions scoped Live Preview toolbar", () => {
  let harness: ActionsHarness;
  beforeEach(() => { ObsidianDom.install(); harness = new ActionsHarness(); });
  afterEach(() => { harness.actions.dispose(); document.body.replaceChildren(); });

  it("docks beside a late host source action and leaves that action owned by the host", async () => {
    harness.actions.mount();
    expect(harness.check.parentElement).toBe(harness.fallback);
    const { toolbar, source } = harness.addSource();
    const sourceClick = vi.fn();
    source.addEventListener("click", sourceClick);
    await harness.settle();
    expect([...toolbar.children]).toEqual([harness.check, source]);
    expect(harness.check.classList.contains("lean4-docked-action")).toBe(true);
    expect(toolbar.querySelectorAll(".lean4-icon-button")).toHaveLength(1);
    source.click();
    expect(sourceClick).toHaveBeenCalledOnce();
    const insert = vi.spyOn(toolbar, "insertBefore");
    harness.actions.refresh();
    toolbar.append(document.createElement("span"));
    await harness.settle();
    expect(insert).not.toHaveBeenCalled();
  });

  it("returns to its own toolbar if host actions disappear, then docks again when recreated", async () => {
    const { toolbar } = harness.addSource();
    harness.actions.mount();
    toolbar.remove();
    await harness.settle();
    expect(harness.check.parentElement).toBe(harness.fallback);
    expect(harness.check.classList.contains("embed-action")).toBe(false);
    const replacement = harness.addSource();
    await harness.settle();
    expect([...replacement.toolbar.children]).toEqual([harness.check, replacement.source]);
  });

  it("removes only its moved check button on unload and disconnects its observer", async () => {
    const { toolbar, source } = harness.addSource();
    harness.actions.mount();
    harness.actions.dispose();
    expect([...toolbar.children]).toEqual([source]);
    harness.fallback.append(document.createElement("span"));
    await harness.settle();
    expect(document.body.contains(harness.check)).toBe(false);
    expect(document.body.contains(source)).toBe(true);
  });

  it("uses the ordinary reading toolbar without creating a fake source action", () => {
    harness.embed.classList.remove("cm-embed-block");
    harness.actions.mount();
    expect(harness.check.parentElement).toBe(harness.fallback);
    expect(harness.embed.querySelector(".embed-actions")).toBeNull();
    expect(harness.embed.querySelector(".edit-block-button")).toBeNull();
  });
});
