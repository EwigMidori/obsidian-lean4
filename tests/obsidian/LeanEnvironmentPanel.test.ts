// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { LeanEnvironmentPanel } from "../../src/obsidian/LeanEnvironmentPanel";
import { LeanSettings } from "../../src/obsidian/LeanSettings";
import { ObsidianProofHost } from "../../src/obsidian/ObsidianProofHost";
import { FakeLeanGateway } from "./fixtures/FakeLeanGateway";
import { FakeManagedEnvironment } from "./fixtures/FakeManagedEnvironment";
import { ObsidianDom } from "./fixtures/ObsidianApiStub";

vi.mock("../../src/infrastructure/LeanLanguageServerGateway", async () => ({
  LeanLanguageServerGateway: (await import("./fixtures/FakeLeanGateway")).FakeLeanGateway
}));
vi.mock("../../src/infrastructure/ManagedLeanEnvironment", async () => ({
  ManagedLeanEnvironment: (await import("./fixtures/FakeManagedEnvironment")).FakeManagedEnvironment
}));

class EnvironmentPanelHarness {
  readonly host = new ObsidianProofHost({} as App, LeanSettings.from(undefined));
  readonly container = document.createElement("div");
  private readonly panel = new LeanEnvironmentPanel(this.host);
  private readonly unsubscribe = this.host.subscribe(() => this.panel.render(this.container));
  async settle(): Promise<void> {
    for (let index = 0; index < 12; index++) await Promise.resolve();
  }
  async dispose(): Promise<void> {
    this.unsubscribe();
    await this.host.dispose();
  }
}

describe("LeanEnvironmentPanel preparation controls", () => {
  let harness: EnvironmentPanelHarness;
  beforeEach(() => {
    ObsidianDom.install();
    FakeManagedEnvironment.instances.length = 0;
    FakeLeanGateway.instances.length = 0;
    harness = new EnvironmentPanelHarness();
  });
  afterEach(async () => { await harness.dispose(); });

  it("offers one-click preparation and resumes the requested proof without a project path", async () => {
    const environment = FakeManagedEnvironment.instances[0]!;
    environment.installed = false;
    harness.host.bindEditor({}, "note.md", "```lean\n#check Nat\n```");
    const block = harness.host.blocksForNote("note.md")[0]!;
    harness.host.checkBlock(block.id);
    await harness.settle();
    expect(harness.container.textContent).toContain("Lean is missing");
    expect(harness.container.querySelector("button")!.textContent).toBe("Prepare Lean");
    harness.container.querySelector("button")!.click();
    await harness.settle();
    expect(environment.prepareCalls).toBe(1);
    expect(harness.container.textContent).toContain("Lean ready");
    expect(FakeLeanGateway.instances[0]!.documents.has(block.documentId!)).toBe(true);
  });

  it("shows measured download bytes and provides cancel and retry actions", async () => {
    const environment = FakeManagedEnvironment.instances[0]!;
    environment.pausePreparation = true;
    harness.container.querySelector("button")!.click();
    await harness.settle();
    expect(harness.container.textContent).toContain("1.0 KiB / 4.0 KiB downloaded");
    expect(harness.container.textContent).not.toContain("%");
    expect(harness.container.querySelector("button")!.textContent).toBe("Cancel preparation");
    harness.container.querySelector("button")!.click();
    await harness.settle();
    expect(environment.cancelled).toBe(true);
    expect(harness.container.querySelector("button")!.textContent).toBe("Retry preparation");
    environment.pausePreparation = false;
    harness.container.querySelector("button")!.click();
    await harness.settle();
    expect(harness.container.textContent).toContain("Lean ready");
    expect(environment.prepareCalls).toBe(2);
  });
});
