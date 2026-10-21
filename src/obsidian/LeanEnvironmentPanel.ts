import { Notice } from "obsidian";
import type { ObsidianProofHost } from "./ObsidianProofHost";
import { LeanI18n } from "./LeanI18n";

/** Owns the preparation actions and the progress text shared by plugin surfaces. */
export class LeanEnvironmentPanel {
  constructor(private readonly host: ObsidianProofHost) {}

  render(container: HTMLElement): void {
    container.empty();
    container.addClass("lean4-environment");
    container.classList.remove("lean4-environment-ready", "lean4-environment-error", "lean4-environment-working");
    if (!this.host.usesBasicEnvironment) {
      container.createDiv({ text: LeanI18n.text("environment.project"), cls: "lean4-muted" });
      return;
    }
    const environment = this.host.environmentSnapshot();
    container.classList.add(environment.state === "ready" ? "lean4-environment-ready"
      : environment.state === "error" ? "lean4-environment-error" : "lean4-environment-working");
    container.createDiv({ text: LeanI18n.text("environment.heading"), cls: "lean4-environment-heading" });
    container.createDiv({
      text: LeanI18n.text(`environment.${environment.state}`),
      cls: environment.state === "error" ? "lean4-message lean4-message-error" : "lean4-message"
    });
    if (environment.downloadedBytes !== undefined) {
      const received = this.bytes(environment.downloadedBytes);
      const text = environment.totalBytes !== undefined
        ? LeanI18n.text("environment.downloadedTotal", { received, total: this.bytes(environment.totalBytes) })
        : LeanI18n.text("environment.downloaded", { received });
      container.createDiv({ text, cls: "lean4-muted" });
    }
    if (environment.message) {
      const details = container.createEl("details", { cls: "lean4-environment-details" });
      details.createEl("summary", { text: LeanI18n.text("environment.details") });
      details.createDiv({ text: environment.message, cls: "lean4-message lean4-muted" });
    }
    if (this.host.preparingEnvironment) {
      const cancel = container.createEl("button", { text: LeanI18n.text("environment.cancel") });
      cancel.addEventListener("click", () => this.host.cancelPreparation());
      return;
    }
    if (environment.state === "ready" || environment.state === "discovering") return;
    container.createEl("p", {
      text: LeanI18n.text("environment.reuse"),
      cls: "lean4-muted"
    });
    const prepare = container.createEl("button", {
      text: LeanI18n.text(["error", "cancelled"].includes(environment.state) ? "environment.retry" : "environment.prepare")
    });
    prepare.addEventListener("click", () => {
      void this.host.prepareEnvironment().catch(error => {
        new Notice(LeanI18n.text("notice.preparationFailed", { error: error instanceof Error ? error.message : String(error) }));
      });
    });
  }

  private bytes(value: number): string {
    return value >= 1_048_576 ? `${(value / 1_048_576).toFixed(1)} MiB`
      : value >= 1_024 ? `${(value / 1_024).toFixed(1)} KiB` : LeanI18n.text("environment.bytes", { count: value });
  }
}
