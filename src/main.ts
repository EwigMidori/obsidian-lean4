import { MarkdownView, Notice, Plugin, TFile, type Editor, type MarkdownFileInfo } from "obsidian";
import { LeanEditor } from "./obsidian/LeanEditor";
import { LeanGoalView } from "./obsidian/LeanGoalView";
import { LeanReadingBlock } from "./obsidian/LeanReadingBlock";
import { LeanSettings, LeanSettingsTab } from "./obsidian/LeanSettings";
import { ObsidianProofHost } from "./obsidian/ObsidianProofHost";
import { LeanPresentation } from "./obsidian/LeanPresentation";
import { LeanI18n } from "./obsidian/LeanI18n";

/** Composition root: Obsidian registration and user commands live with the plugin. */
export default class LeanProofPlugin extends Plugin {
  override settings = new LeanSettings();
  private host!: ObsidianProofHost;
  private loaded = false;
  private lastEnvironmentStatus = "";

  get proofHost(): ObsidianProofHost { return this.host; }

  override async onload(): Promise<void> {
    this.settings = LeanSettings.from(await this.loadData());
    this.host = new ObsidianProofHost(this.app, this.settings);
    this.loaded = true;
    this.registerView(LeanGoalView.type, leaf => new LeanGoalView(leaf, this.host));
    this.registerEditorExtension(new LeanEditor(this.host).extension());
    this.addSettingTab(new LeanSettingsTab(this.app, this));
    for (const language of ["lean", "lean4", "lean-example", "lean-off"]) {
      this.registerMarkdownCodeBlockProcessor(language, (source, element, context) => {
        context.addChild(new LeanReadingBlock(element, source, language, context, this.host));
      });
    }
    this.addCommand({
      id: "prepare-basic-environment",
      name: LeanI18n.text("commands.prepare"),
      checkCallback: checking => {
        if (!this.host.usesBasicEnvironment) return false;
        if (!checking) void this.host.prepareEnvironment().catch(error => this.report(error));
        return true;
      }
    });
    this.addCommand({
      id: "check-current-block",
      name: LeanI18n.text("commands.block"),
      editorCallback: (editor, info) => this.checkCurrentBlock(editor, info)
    });
    this.addCommand({
      id: "check-current-note",
      name: LeanI18n.text("commands.note"),
      callback: () => this.checkCurrentNote()
    });
    this.addCommand({
      id: "show-goals",
      name: LeanI18n.text("commands.goals"),
      callback: () => { void this.showGoals().catch(error => this.report(error)); }
    });
    this.addCommand({
      id: "restart-server",
      name: LeanI18n.text("commands.restart"),
      callback: () => { void this.host.restart().catch(error => this.report(error)); }
    });
    this.addRibbonIcon("sigma", LeanI18n.text("view.goals"), () => {
      void this.showGoals().catch(error => this.report(error));
    });
    const status = this.addStatusBarItem();
    status.addClass("lean4-statusbar");
    this.register(this.host.subscribe(snapshot => {
      const checking = LeanPresentation.documentCount(snapshot.blocks, "checking");
      const queued = LeanPresentation.documentCount(snapshot.blocks, "queued");
      const environment = this.host.environmentSnapshot();
      const state = this.host.usesBasicEnvironment && environment.state !== "ready"
        ? LeanI18n.text("status.basic", { state: LeanI18n.text(`environmentStatus.${environment.state}`) })
        : LeanI18n.text(`service.${snapshot.service.state}`);
      status.textContent = LeanI18n.text("status.label", { state })
        + (checking ? ` · ${LeanI18n.text("count.checking", { count: checking })}` : "")
        + (queued ? ` · ${LeanI18n.text("count.queued", { count: queued })}` : "");
      status.title = this.host.usesBasicEnvironment && environment.state !== "ready"
        ? LeanI18n.text(`environment.${environment.state}`) : snapshot.service.message ?? LeanI18n.text("status.openGoals");
      const environmentStatus = `${this.host.usesBasicEnvironment}:${environment.state}`;
      if (this.host.usesBasicEnvironment && environment.state === "needs-install" && this.lastEnvironmentStatus !== environmentStatus) {
        void this.showGoals().catch(error => this.report(error));
      }
      this.lastEnvironmentStatus = environmentStatus;
    }));
    this.registerDomEvent(status, "click", () => {
      void this.showGoals().catch(error => this.report(error));
    });
    this.registerEvent(this.app.vault.on("modify", file => {
      if (file instanceof TFile) void this.host.refreshFile(file).catch(error => this.report(error));
    }));
  }

  override onunload(): void {
    this.loaded = false;
    this.app.workspace.detachLeavesOfType(LeanGoalView.type);
    void this.host?.dispose().catch(error => console.error("Lean 4 shutdown failed", error));
  }

  async applySettings(): Promise<void> {
    this.settings = LeanSettings.from(this.settings);
    if (this.settings.environmentMode === "project" && !this.settings.projectRoot) {
      throw new Error(LeanI18n.text("notice.configureProject"));
    }
    await this.saveData(this.settings);
    if (this.loaded) await this.host.reconfigure(this.settings);
  }

  private checkCurrentBlock(editor: Editor, info: MarkdownFileInfo): void {
    if (!info.file) return;
    const offset = editor.posToOffset(editor.getCursor());
    const block = this.host.snapshot().blocks.find(candidate =>
      candidate.noteId === info.file!.path && offset >= candidate.from && offset <= candidate.to);
    if (!block) {
      new Notice(LeanI18n.text("notice.cursor"));
    } else if (block.displayOnly) {
      new Notice(block.metadataError ?? LeanI18n.text("notice.displayOnly"));
    } else {
      this.host.checkBlock(block.id);
    }
  }

  private checkCurrentNote(): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file) {
      new Notice(LeanI18n.text("notice.openNote"));
      return;
    }
    this.host.checkNote(view.file.path);
  }

  private async showGoals(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(LeanGoalView.type)[0];
    const leaf = existing ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    if (!existing) await leaf.setViewState({ type: LeanGoalView.type, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  private report(error: unknown): void {
    new Notice(`Lean 4: ${error instanceof Error ? error.message : String(error)}`);
  }
}
