import { MarkdownRenderChild, type MarkdownPostProcessorContext } from "obsidian";
import type { ProofBlockSnapshot } from "../application/contracts";
import { LeanPresentation, LeanSyntax } from "./LeanPresentation";
import type { ObsidianProofHost } from "./ObsidianProofHost";
import { LeanEnvironmentPanel } from "./LeanEnvironmentPanel";
import { LeanIconButton, LeanMessagePresenter } from "./LeanFeedback";
import { LeanReadingActions } from "./LeanReadingActions";
import { LeanI18n } from "./LeanI18n";

/** Owns one rendered fence and only displays cached results for that exact block. */
export class LeanReadingBlock extends MarkdownRenderChild {
  private readonly syntax = new LeanSyntax();
  private statusEl!: HTMLElement;
  private titleEl!: HTMLElement;
  private sessionEl!: HTMLElement;
  private messagesEl!: HTMLElement;
  private checkButton!: HTMLButtonElement;
  private actions!: LeanReadingActions;
  private loaded = false;
  private readonly normalizedSource: string;

  constructor(
    containerEl: HTMLElement,
    private readonly source: string,
    private readonly language: string,
    private readonly context: MarkdownPostProcessorContext,
    private readonly host: ObsidianProofHost
  ) {
    super(containerEl);
    this.normalizedSource = this.normalized(source);
  }

  override onload(): void {
    this.loaded = true;
    this.containerEl.empty();
    this.containerEl.addClass("lean4-reading-block");
    const toolbar = this.containerEl.createDiv({ cls: "lean4-reading-toolbar" });
    const labels = toolbar.createDiv({ cls: "lean4-reading-labels" });
    this.titleEl = labels.createSpan({ text: "Lean 4", cls: "lean4-reading-language" });
    this.sessionEl = labels.createSpan({ cls: "lean4-session-context" });
    this.statusEl = labels.createSpan({ cls: "lean4-status" });
    const actions = toolbar.createDiv({ cls: "lean4-reading-actions" });
    this.checkButton = LeanIconButton.create(actions, "play", LeanI18n.text("block.check"));
    this.checkButton.addClass("lean4-check-action");
    this.registerDomEvent(this.checkButton, "click", () => this.check());
    this.actions = new LeanReadingActions(this.containerEl, actions, this.checkButton);
    this.actions.mount();
    const pre = this.containerEl.createEl("pre");
    this.syntax.render(pre.createEl("code", { cls: "language-lean" }), this.source);
    this.messagesEl = this.containerEl.createDiv({ cls: "lean4-reading-messages" });
    this.register(this.host.subscribe(() => this.renderState()));
    void this.host.bindReader(this, this.context.sourcePath)
      .then(() => { if (this.loaded) this.renderState(); })
      .catch(error => {
        if (this.loaded) {
          this.statusEl.textContent = LeanI18n.text("reading.loadFailed");
          this.messagesEl.textContent = error instanceof Error ? error.message : String(error);
        }
      });
  }

  override onunload(): void {
    this.loaded = false;
    this.actions.dispose();
    this.host.release(this);
  }

  private check(): void {
    const block = this.resolveBlock();
    if (block && !block.displayOnly) this.host.checkBlock(block.id);
  }

  private renderState(): void {
    if (!this.loaded) return;
    this.actions.refresh();
    const block = this.resolveBlock();
    this.messagesEl.empty();
    const displayOnly = block?.displayOnly ?? (this.language === "lean-example" || this.language === "lean-off");
    this.titleEl.textContent = block?.title || "Lean 4";
    this.sessionEl.textContent = block ? LeanPresentation.sessionLabel(block) : "";
    this.sessionEl.hidden = !block?.session;
    this.checkButton.hidden = displayOnly;
    this.checkButton.disabled = !block || block.displayOnly || ["queued", "checking"].includes(block.state);
    this.statusEl.className = `lean4-status lean4-status-${block ? LeanPresentation.blockTone(block) : "idle"}`;
    if (!block) {
      this.statusEl.textContent = LeanI18n.text(displayOnly ? "block.display-only" : "block.idle");
      LeanIconButton.describe(this.checkButton, LeanI18n.text("block.check"), LeanI18n.text("reading.checkHint"));
      return;
    }
    if (!displayOnly && this.host.usesBasicEnvironment &&
      ["needs-install", "downloading", "installing", "error", "cancelled"].includes(this.host.environmentSnapshot().state)) {
      new LeanEnvironmentPanel(this.host).render(this.messagesEl.createDiv());
    }
    LeanIconButton.describe(this.checkButton, LeanPresentation.checkLabel(block), LeanPresentation.checkDescription(block));
    this.statusEl.textContent = LeanPresentation.blockLabel(block);
    if (block.metadataError) {
      this.statusEl.title = block.metadataError;
      this.messagesEl.createDiv({ cls: "lean4-message lean4-message-error", text: block.metadataError });
      return;
    }
    if (block.state === "checked") {
      this.statusEl.title = LeanI18n.text("reading.cached");
    } else {
      this.statusEl.title = block.message ?? "";
    }
    if (block.message) this.messagesEl.createDiv({ cls: "lean4-message", text: block.message });
    for (const diagnostic of block.diagnostics) {
      LeanMessagePresenter.render(this.messagesEl, diagnostic);
    }
  }

  private resolveBlock(): ProofBlockSnapshot | undefined {
    const section = this.context.getSectionInfo(this.containerEl);
    const candidates = section
      ? this.host.blocksInSection(this.context.sourcePath, section.lineStart, section.lineEnd)
      : this.host.blocksForNote(this.context.sourcePath);
    const matches = candidates.filter(block =>
      block.language === this.language && this.normalized(block.code) === this.normalizedSource);
    // Metadata is resolved from the original note's fence through the domain
    // snapshot. Processor source contains only code, so identical examples must
    // be distinguished by the current rendered section, never a remembered id.
    if (matches.length !== 1) return undefined;
    return matches[0];
  }

  private normalized(text: string): string {
    return text.replace(/\r\n/gu, "\n").replace(/\n$/u, "");
  }

}
