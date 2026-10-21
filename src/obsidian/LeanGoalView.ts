import { ItemView, MarkdownView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import type { WorkspaceSnapshot } from "../application/contracts";
import { LeanPresentation } from "./LeanPresentation";
import type { ObsidianProofHost } from "./ObsidianProofHost";
import { LeanEnvironmentPanel } from "./LeanEnvironmentPanel";
import { LeanGoalPresenter, LeanIconButton, LeanMessagePresenter } from "./LeanFeedback";
import { LeanI18n } from "./LeanI18n";

export class LeanGoalView extends ItemView {
  static readonly type = "lean4-proof-goals";
  private signature = "";

  constructor(leaf: WorkspaceLeaf, private readonly host: ObsidianProofHost) {
    super(leaf);
  }

  override getViewType(): string { return LeanGoalView.type; }
  override getDisplayText(): string { return LeanI18n.text("view.goals"); }
  override getIcon(): string { return "sigma"; }

  override async onOpen(): Promise<void> {
    this.contentEl.addClass("lean4-goal-view");
    this.register(this.host.subscribe(snapshot => this.render(snapshot)));
  }

  override async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  private render(snapshot: WorkspaceSnapshot): void {
    const block = snapshot.blocks.find(candidate => candidate.id === snapshot.goal?.blockId);
    const signature = JSON.stringify([LeanI18n.locale(), this.host.usesBasicEnvironment, this.host.environmentSnapshot(), this.host.preparingEnvironment, snapshot.service, snapshot.goal, block]);
    if (signature === this.signature) return;
    this.signature = signature;
    this.contentEl.empty();
    const heading = this.contentEl.createDiv({ cls: "lean4-goal-heading" });
    heading.createEl("h3", { text: LeanI18n.text("view.heading") });
    const restart = LeanIconButton.create(heading, "rotate-cw", LeanI18n.text("view.restart"));
    restart.disabled = snapshot.service.state === "starting";
    restart.addEventListener("click", () => {
      void this.host.restart().catch(error => new Notice(String(error)));
    });
    const service = this.contentEl.createDiv({
      cls: `lean4-service lean4-service-${snapshot.service.state}`,
      text: LeanI18n.text("view.service", { state: LeanI18n.text(`service.${snapshot.service.state}`) })
    });
    new LeanEnvironmentPanel(this.host).render(this.contentEl.createDiv());
    if (snapshot.service.message) service.createDiv({ text: snapshot.service.message, cls: "lean4-message" });
    if (!block || !snapshot.goal) {
      this.contentEl.createEl("p", {
        cls: "lean4-muted",
        text: LeanI18n.text("view.empty")
      });
      return;
    }
    const toolbar = this.contentEl.createDiv({ cls: "lean4-goal-location" });
    toolbar.createSpan({ text: `${block.noteId} · ${block.title || LeanI18n.text("view.block", { index: block.ordinal + 1 })}` });
    if (block.session) toolbar.createSpan({
      text: LeanPresentation.sessionLabel(block),
      cls: "lean4-session-context"
    });
    toolbar.createSpan({ text: LeanPresentation.blockLabel(block), cls: `lean4-status lean4-status-${LeanPresentation.blockTone(block)}` });
    if (!block.displayOnly) {
      const check = LeanIconButton.create(toolbar, "play", LeanPresentation.checkLabel(block));
      LeanIconButton.describe(check, LeanPresentation.checkLabel(block), LeanPresentation.checkDescription(block));
      check.disabled = ["queued", "checking"].includes(block.state);
      check.addEventListener("click", () => this.host.checkBlock(block.id));
    }
    const goal = snapshot.goal;
    if (goal.state === "ready") {
      if (goal.goals.length === 0) {
        this.contentEl.createEl("p", { text: LeanI18n.text("view.emptyGoal"), cls: "lean4-goal-empty" });
      }
      for (const [index, text] of goal.goals.entries()) LeanGoalPresenter.render(this.contentEl, text, index);
    } else {
      this.contentEl.createEl("p", {
        text: goal.message ?? LeanI18n.text(goal.state === "loading" ? "view.loadingGoal" : "view.unavailableGoal"),
        cls: "lean4-muted"
      });
    }
    if (block.metadataError ?? block.message) this.contentEl.createDiv({
      text: block.metadataError ?? block.message ?? "",
      cls: block.metadataError ? "lean4-message lean4-message-error" : "lean4-message"
    });
    if (block.diagnostics.length > 0) {
      this.contentEl.createEl("h4", { text: LeanI18n.text("view.messages") });
      for (const diagnostic of block.diagnostics) {
        LeanMessagePresenter.render(this.contentEl, diagnostic, () => {
          void this.revealDiagnostic(block.noteId, diagnostic.from).catch(error => new Notice(String(error)));
        });
      }
    }
  }

  private async revealDiagnostic(noteId: string, offset: number): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(noteId);
    if (!(file instanceof TFile)) return;
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file, { state: { mode: "source" } });
    if (leaf.view instanceof MarkdownView) {
      const editor = leaf.view.editor;
      const position = editor.offsetToPos(offset);
      editor.setCursor(position);
      editor.scrollIntoView({ from: position, to: position }, true);
      editor.focus();
    }
  }
}
