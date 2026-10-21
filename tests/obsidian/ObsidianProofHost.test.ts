import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { LeanSettings } from "../../src/obsidian/LeanSettings";
import { ObsidianProofHost } from "../../src/obsidian/ObsidianProofHost";
import { Deferred, FakeLeanGateway } from "./fixtures/FakeLeanGateway";
import { TFile } from "./fixtures/ObsidianApiStub";
import { FakeManagedEnvironment } from "./fixtures/FakeManagedEnvironment";

vi.mock("../../src/infrastructure/LeanLanguageServerGateway", async () => ({
  LeanLanguageServerGateway: (await import("./fixtures/FakeLeanGateway")).FakeLeanGateway
}));
vi.mock("../../src/infrastructure/ManagedLeanEnvironment", async () => ({
  ManagedLeanEnvironment: (await import("./fixtures/FakeManagedEnvironment")).FakeManagedEnvironment
}));

class HostHarness {
  readonly file = new TFile("note.md");
  readonly read = vi.fn<() => Promise<string>>().mockResolvedValue("```lean\n#check Nat\n```");
  readonly settings: LeanSettings;
  readonly host: ObsidianProofHost;

  constructor(settings = LeanSettings.from({ projectRoot: "/test/project" })) {
    this.settings = settings;
    const app = {
      vault: {
        getAbstractFileByPath: (path: string) => path === this.file.path ? this.file : null,
        cachedRead: this.read
      }
    } as unknown as App;
    this.host = new ObsidianProofHost(app, this.settings);
  }

  async settle(): Promise<void> {
    for (let iteration = 0; iteration < 8; iteration++) await Promise.resolve();
  }
}

describe("ObsidianProofHost note and configuration lifetimes", () => {
  let harness: HostHarness;
  beforeEach(() => {
    FakeLeanGateway.instances.length = 0;
    FakeManagedEnvironment.instances.length = 0;
    harness = new HostHarness();
  });
  afterEach(async () => { await harness.host.dispose(); });

  it("keeps a shared note alive until the last editor lease is released", async () => {
    const first = {};
    const second = {};
    const text = "```lean\n#check Nat\n```";
    harness.host.bindEditor(first, "note.md", text);
    harness.host.bindEditor(second, "note.md", text);
    const blockId = harness.host.snapshot().blocks[0]!.id;
    const documentId = harness.host.snapshot().blocks[0]!.documentId!;
    harness.host.checkBlock(blockId);
    await harness.settle();
    const gateway = FakeLeanGateway.instances[0]!;
    expect(gateway.documents.has(documentId)).toBe(true);

    harness.host.release(first);
    await harness.settle();
    expect(harness.host.snapshot().blocks).toHaveLength(1);
    expect(gateway.closed).toEqual([]);

    harness.host.release(second);
    await harness.settle();
    expect(harness.host.snapshot().blocks).toEqual([]);
    expect(gateway.closed).toEqual([documentId]);
  });

  it("never overwrites an editor's newer text with a delayed vault read", async () => {
    let resolveRead!: (text: string) => void;
    harness.read.mockImplementationOnce(() => new Promise(resolve => { resolveRead = resolve; }));
    const reader = {};
    const pendingRead = harness.host.bindReader(reader, "note.md");
    const current = "```lean\ndef newest := 42\n```";
    harness.host.bindEditor({}, "note.md", current);
    resolveRead("```lean\ndef outdated := 0\n```");
    await pendingRead;
    expect(harness.host.noteText("note.md")).toBe(current);
    expect(harness.host.snapshot().blocks[0]!.code).toContain("newest");
  });

  it("does not resurrect a reading-only note after its last lease unloads", async () => {
    let resolveRead!: (text: string) => void;
    harness.read.mockImplementationOnce(() => new Promise(resolve => { resolveRead = resolve; }));
    const reader = {};
    const pendingRead = harness.host.bindReader(reader, "note.md");
    harness.host.release(reader);
    resolveRead("```lean\n#check Nat\n```");
    await pendingRead;
    expect(harness.host.noteText("note.md")).toBeNull();
    expect(harness.host.snapshot().blocks).toEqual([]);
  });

  it("serializes reconfiguration so no intermediate workspace or server is abandoned", async () => {
    const oldGateway = FakeLeanGateway.instances[0]!;
    const releaseOld = new Deferred();
    oldGateway.disposeGate = releaseOld.promise;
    harness.host.bindEditor({}, "note.md", "```lean\n#check Nat\n```");

    const first = harness.host.reconfigure(LeanSettings.from({ projectRoot: "/project/first" }));
    await harness.settle();
    const second = harness.host.reconfigure(LeanSettings.from({ projectRoot: "/project/final" }));
    await harness.settle();
    // A second caller must wait for the in-flight shutdown, not create a new worker.
    expect(FakeLeanGateway.instances).toHaveLength(1);

    releaseOld.resolve();
    await Promise.all([first, second]);
    expect(FakeLeanGateway.instances.map(gateway => gateway.options.projectRoot))
      .toEqual(["/test/project", "/project/first", "/project/final"]);
    expect(FakeLeanGateway.instances.map(gateway => gateway.disposeCalls)).toEqual([1, 1, 0]);
    expect(harness.host.snapshot().blocks[0]!.code).toContain("#check Nat");

    await harness.host.dispose();
    expect(FakeLeanGateway.instances.map(gateway => gateway.disposeCalls)).toEqual([1, 1, 1]);
  });

  it("unloading while configuration is pending never starts a replacement workspace", async () => {
    const releaseOld = new Deferred();
    FakeLeanGateway.instances[0]!.disposeGate = releaseOld.promise;
    const applying = harness.host.reconfigure(LeanSettings.from({ projectRoot: "/pending" }));
    await harness.settle();
    const unloading = harness.host.dispose();
    releaseOld.resolve();
    await Promise.all([applying, unloading]);
    expect(FakeLeanGateway.instances).toHaveLength(1);
    expect(FakeLeanGateway.instances[0]!.disposeCalls).toBe(1);
  });

  it("defaults to a basic environment, checks without a project, and migrates saved projects", async () => {
    expect(LeanSettings.from(undefined).environmentMode).toBe("basic");
    expect(LeanSettings.from(undefined).projectRoot).toBe("");
    expect(LeanSettings.from({ projectRoot: "/existing" }).environmentMode).toBe("project");
    await harness.host.dispose();
    harness = new HostHarness(LeanSettings.from(undefined));
    harness.host.bindEditor({}, "note.md", "```lean\n#check Nat\n```");
    const block = harness.host.blocksForNote("note.md")[0]!;
    harness.host.checkBlock(block.id);
    await harness.settle();
    expect(harness.host.usesBasicEnvironment).toBe(true);
    expect(FakeLeanGateway.instances.at(-1)!.options.projectRoot).toBeUndefined();
    expect(FakeLeanGateway.instances.at(-1)!.documents.has(block.documentId!)).toBe(true);
    expect(FakeManagedEnvironment.instances.at(-1)!.resolveCalls).toBe(1);
  });

  it("prepares once and resumes only the latest requested block after a missing toolchain", async () => {
    await harness.host.dispose();
    harness = new HostHarness(LeanSettings.from(undefined));
    const environment = FakeManagedEnvironment.instances.at(-1)!;
    environment.installed = false;
    environment.pausePreparation = true;
    harness.host.bindEditor({}, "note.md", "```lean\n#check Nat\n```\n\n```lean\n#check Int\n```");
    const [first, second] = harness.host.blocksForNote("note.md");
    harness.host.checkBlock(first!.id);
    await harness.settle();
    expect(harness.host.environmentSnapshot().state).toBe("needs-install");
    const preparation = harness.host.prepareEnvironment();
    const repeated = harness.host.prepareEnvironment();
    expect(repeated).toBe(preparation);
    harness.host.checkBlock(second!.id);
    environment.prepareGate.resolve();
    await preparation;
    await harness.settle();
    expect(environment.prepareCalls).toBe(1);
    expect([...FakeLeanGateway.instances.at(-1)!.documents.keys()]).toEqual([second!.documentId]);
  });

  it("does not reopen a formerly active proof when the cursor moves to a display-only block during preparation", async () => {
    await harness.host.dispose();
    harness = new HostHarness(LeanSettings.from(undefined));
    const environment = FakeManagedEnvironment.instances.at(-1)!;
    environment.installed = false;
    environment.pausePreparation = true;
    harness.host.bindEditor({}, "note.md", "```lean\n#check Nat\n```\n\n```lean check=off title=\"Example\"\n#check Nat\n```");
    const [first, second] = harness.host.blocksForNote("note.md");
    harness.host.inspectAt("note.md", first!.codeFrom);
    harness.host.checkBlock(first!.id);
    await harness.settle();
    const preparation = harness.host.prepareEnvironment();
    harness.host.inspectAt("note.md", second!.codeFrom);
    environment.prepareGate.resolve();
    await preparation;
    await harness.settle();
    expect(FakeLeanGateway.instances.at(-1)!.documents.size).toBe(0);
    expect(harness.host.snapshot().goal?.blockId).toBe(second!.id);
  });

  it("cancels preparation before switching to an advanced project", async () => {
    await harness.host.dispose();
    harness = new HostHarness(LeanSettings.from(undefined));
    const environment = FakeManagedEnvironment.instances.at(-1)!;
    environment.pausePreparation = true;
    const preparation = harness.host.prepareEnvironment();
    await harness.host.reconfigure(LeanSettings.from({ projectRoot: "/advanced" }));
    await preparation;
    expect(environment.cancelled).toBe(true);
    expect(harness.host.usesBasicEnvironment).toBe(false);
    expect(FakeLeanGateway.instances.at(-1)!.options.projectRoot).toBe("/advanced");
  });

  it("cancels preparation on unload without replaying any proof", async () => {
    await harness.host.dispose();
    harness = new HostHarness(LeanSettings.from(undefined));
    const environment = FakeManagedEnvironment.instances.at(-1)!;
    environment.pausePreparation = true;
    const preparation = harness.host.prepareEnvironment();
    const instanceCount = FakeLeanGateway.instances.length;
    await harness.host.dispose();
    await preparation;
    expect(environment.cancelled).toBe(true);
    expect(FakeLeanGateway.instances).toHaveLength(instanceCount);
  });

  it("waits for an in-flight project switch before considering a new preparation", async () => {
    await harness.host.dispose();
    harness = new HostHarness(LeanSettings.from(undefined));
    const environment = FakeManagedEnvironment.instances.at(-1)!;
    const releaseGateway = new Deferred();
    FakeLeanGateway.instances.at(-1)!.disposeGate = releaseGateway.promise;
    const configuring = harness.host.reconfigure(LeanSettings.from({ projectRoot: "/advanced" }));
    await harness.settle();
    const preparation = harness.host.prepareEnvironment();
    await harness.settle();
    expect(environment.prepareCalls).toBe(0);
    releaseGateway.resolve();
    await Promise.all([configuring, preparation]);
    expect(environment.prepareCalls).toBe(0);
    expect(harness.host.usesBasicEnvironment).toBe(false);
  });

  it("forgets a requested block when its note is closed during preparation", async () => {
    await harness.host.dispose();
    harness = new HostHarness(LeanSettings.from(undefined));
    const environment = FakeManagedEnvironment.instances.at(-1)!;
    environment.installed = false;
    environment.pausePreparation = true;
    const owner = {};
    harness.host.bindEditor(owner, "note.md", "```lean\n#check Nat\n```");
    harness.host.checkBlock(harness.host.blocksForNote("note.md")[0]!.id);
    await harness.settle();
    const preparation = harness.host.prepareEnvironment();
    harness.host.release(owner);
    environment.prepareGate.resolve();
    await preparation;
    await harness.settle();
    expect(FakeLeanGateway.instances.at(-1)!.documents.size).toBe(0);
    expect(harness.host.snapshot().blocks).toEqual([]);
  });
});
