import { setIcon } from "obsidian";
import type { LeanDiagnostic } from "../application/contracts";
import { LeanI18n } from "./LeanI18n";

/** Native buttons retain keyboard activation and disabled semantics around host icons. */
export class LeanIconButton {
  static create(parent: HTMLElement, icon: string, label: string): HTMLButtonElement {
    const button = parent.createEl("button", { cls: "clickable-icon lean4-icon-button" });
    button.type = "button";
    setIcon(button, icon);
    this.describe(button, label);
    button.addEventListener("click", event => event.stopPropagation());
    return button;
  }

  static describe(button: HTMLButtonElement, label: string, description = label): void {
    button.setAttribute("aria-label", label);
    button.setAttribute("data-tooltip-position", "top");
    button.title = description;
  }
}

/** Separates diagnostic metadata from selectable plain-text messages. */
export class LeanMessagePresenter {
  static render(parent: HTMLElement, diagnostic: LeanDiagnostic, navigate?: () => void): HTMLElement {
    const card = parent.createDiv({ cls: `lean4-message-card lean4-message-${diagnostic.severity}` });
    const metadata = card.createDiv({ cls: "lean4-message-metadata" });
    metadata.createSpan({ text: LeanI18n.text(`diagnostic.${diagnostic.severity}`), cls: "lean4-message-kind" });
    const positionText = LeanI18n.text("diagnostic.position", {
      line: diagnostic.range.start.line + 1,
      column: diagnostic.range.start.character + 1
    });
    if (navigate) {
      const position = metadata.createEl("button", { text: positionText, cls: "lean4-message-position lean4-message-jump" });
      position.type = "button";
      position.title = LeanI18n.text("diagnostic.jump");
      position.setAttribute("aria-label", LeanI18n.text("diagnostic.jumpLabel", { position: positionText }));
      position.addEventListener("click", navigate);
    } else {
      metadata.createSpan({ text: positionText, cls: "lean4-message-position" });
    }
    card.createEl("pre", { text: diagnostic.message, cls: "lean4-message-body" });
    return card;
  }
}

/** Uses only Lean's textual turnstile boundary, preserving all original goal text. */
export class LeanGoalPresenter {
  static render(parent: HTMLElement, text: string, index: number): HTMLElement {
    const goal = parent.createDiv({ cls: "lean4-goal" });
    goal.setAttribute("aria-label", LeanI18n.text("goal.index", { index: index + 1 }));
    const boundary = /^[\t ]*⊢/mu.exec(text);
    if (!boundary) {
      this.section(goal, LeanI18n.text("goal.raw"), text, "raw");
      return goal;
    }
    if (boundary.index > 0) this.section(goal, LeanI18n.text("goal.context"), text.slice(0, boundary.index), "context");
    this.section(goal, LeanI18n.text("goal.target"), text.slice(boundary.index), "target");
    return goal;
  }

  private static section(parent: HTMLElement, label: string, text: string, kind: string): void {
    const section = parent.createDiv({ cls: `lean4-goal-section lean4-goal-${kind}` });
    section.createDiv({ text: label, cls: "lean4-goal-section-label" });
    section.createEl("pre", { text, cls: "lean4-goal-code" });
  }
}
