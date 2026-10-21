// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App, WorkspaceLeaf } from "obsidian";
import { LeanGoalView } from "../../src/obsidian/LeanGoalView";
import { LeanPresentation } from "../../src/obsidian/LeanPresentation";
import { LeanSettings } from "../../src/obsidian/LeanSettings";
import { ObsidianProofHost } from "../../src/obsidian/ObsidianProofHost";
import { FakeLeanGateway } from "./fixtures/FakeLeanGateway";
import { ObsidianDom } from "./fixtures/ObsidianApiStub";

vi.mock("../../src/infrastructure/LeanLanguageServerGateway", async () => ({
  LeanLanguageServerGateway: (await import("./fixtures/FakeLeanGateway")).FakeLeanGateway
}));
vi.mock("../../src/infrastructure/ManagedLeanEnvironment", async () => ({
  ManagedLeanEnvironment: (await import("./fixtures/FakeManagedEnvironment")).FakeManagedEnvironment
}));

class GoalHarness {
  readonly host = new ObsidianProofHost({} as App, LeanSettings.from({ projectRoot: "/test/project" }));
  readonly view = new LeanGoalView({} as WorkspaceLeaf, this.host);

  async mount(note: string): Promise<void> {
    this.host.bindEditor({}, "note.md", note);
    this.view.load();
    await this.view.onOpen();
  }
  async settle(): Promise<void> {
    for (let index = 0; index < 8; index++) await Promise.resolve();
  }
  async dispose(): Promise<void> {
    this.view.unload();
    await this.view.onClose();
    await this.host.dispose();
  }
}

describe("LeanGoalView shared context", () => {
  let harness: GoalHarness;
  beforeEach(() => {
    ObsidianDom.install();
    FakeLeanGateway.instances.length = 0;
    harness = new GoalHarness();
  });
  afterEach(async () => { await harness.dispose(); });

  it("shows the current session and checks all its members from the goal panel", async () => {
    await harness.mount('```lean session=proof title="Definitions"\ndef n := 7\n```\n\n```lean session=proof title="Result"\n#check n\n```');
    const blocks = harness.host.blocksForNote("note.md");
    harness.host.inspectAt("note.md", blocks[1]!.codeFrom);
    await harness.settle();
    expect(harness.view.contentEl.querySelector(".lean4-goal-location")?.textContent).toContain("Result");
    expect(harness.view.contentEl.querySelector(".lean4-session-context")?.textContent).toBe("Session: proof");
    const check = harness.view.contentEl.querySelector<HTMLButtonElement>('button[aria-label="Check session"]')!;
    expect(check).toBeDefined();
    check.click();
    await harness.settle();
    const documents = [...FakeLeanGateway.instances[0]!.documents.values()];
    expect(documents).toHaveLength(1);
    expect(documents[0]!.code).toContain("def n := 7");
    expect(documents[0]!.code).toContain("#check n");
    expect(LeanPresentation.documentCount(harness.host.snapshot().blocks, "checking")).toBe(1);
  });

  it("labels display-only session members as excluded and offers no session check action", async () => {
    await harness.mount('```lean session=proof check=off title="Sketch"\nnot Lean\n```');
    harness.host.inspectAt("note.md", harness.host.blocksForNote("note.md")[0]!.codeFrom);
    await harness.settle();
    expect(harness.view.contentEl.querySelector(".lean4-session-context")?.textContent).toBe("Excluded from session: proof");
    expect(harness.view.contentEl.querySelector(".lean4-goal-location")?.textContent).toContain("Sketch");
    expect(harness.view.contentEl.querySelector('button[aria-label="Check session"]')).toBeNull();
    expect(FakeLeanGateway.instances[0]!.documents.size).toBe(0);
  });
});
