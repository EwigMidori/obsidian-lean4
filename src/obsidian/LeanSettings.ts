import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type LeanProofPlugin from "../main";
import { LeanEnvironmentPanel } from "./LeanEnvironmentPanel";
import type { Unsubscribe } from "../application/contracts";
import { LeanI18n } from "./LeanI18n";

/** Owns persisted configuration defaults and the values accepted at the UI boundary. */
export class LeanSettings {
  environmentMode: "basic" | "project" = "basic";
  projectRoot = "";
  lakeExecutable = "lake";
  debounceMs = 200;
  maxOpenBlocks = 4;
  idleTimeoutMs = 60_000;

  static from(data: unknown): LeanSettings {
    const settings = new LeanSettings();
    if (!data || typeof data !== "object") return settings;
    const raw = data as Record<string, unknown>;
    if (typeof raw.projectRoot === "string") settings.projectRoot = raw.projectRoot.trim();
    settings.environmentMode = raw.environmentMode === "basic" || raw.environmentMode === "project"
      ? raw.environmentMode
      : settings.projectRoot ? "project" : "basic";
    if (typeof raw.lakeExecutable === "string" && raw.lakeExecutable.trim()) {
      settings.lakeExecutable = raw.lakeExecutable.trim();
    }
    settings.debounceMs = settings.boundedNumber(raw.debounceMs, 200, 50, 2_000);
    settings.maxOpenBlocks = settings.boundedNumber(raw.maxOpenBlocks, 4, 1, 16);
    settings.idleTimeoutMs = settings.boundedNumber(raw.idleTimeoutMs, 60_000, 10_000, 600_000);
    return settings;
  }

  private boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
    return typeof value === "number" && Number.isFinite(value)
      ? Math.max(minimum, Math.min(maximum, Math.round(value)))
      : fallback;
  }
}

export class LeanSettingsTab extends PluginSettingTab {
  private unsubscribe: Unsubscribe | null = null;

  constructor(app: App, private readonly plugin: LeanProofPlugin) {
    super(app, plugin);
    plugin.register(() => this.stopObserving());
  }

  override display(): void {
    this.stopObserving();
    this.containerEl.empty();
    this.containerEl.createEl("p", {
      text: LeanI18n.text("settings.introduction")
    });
    const environmentPanel = new LeanEnvironmentPanel(this.plugin.proofHost);
    const environmentEl = this.containerEl.createDiv();
    this.unsubscribe = this.plugin.proofHost.subscribe(() => environmentPanel.render(environmentEl));
    new Setting(this.containerEl)
      .setName(LeanI18n.text("settings.environment"))
      .setDesc(LeanI18n.text("settings.environmentDesc"))
      .addDropdown(dropdown => dropdown
        .addOption("basic", LeanI18n.text("settings.basic"))
        .addOption("project", LeanI18n.text("settings.project"))
        .setValue(this.plugin.settings.environmentMode)
        .onChange(value => {
          this.plugin.settings.environmentMode = value === "project" ? "project" : "basic";
          this.display();
        }));
    if (this.plugin.settings.environmentMode === "project") {
      new Setting(this.containerEl)
        .setName(LeanI18n.text("settings.projectRoot"))
        .setDesc(LeanI18n.text("settings.projectRootDesc"))
        .addText(text => text
          .setPlaceholder("C:\\Projects\\MyLeanProject")
          .setValue(this.plugin.settings.projectRoot)
          .onChange(value => { this.plugin.settings.projectRoot = value.trim(); }));
      new Setting(this.containerEl)
        .setName(LeanI18n.text("settings.lake"))
        .setDesc(LeanI18n.text("settings.lakeDesc"))
        .addText(text => text
          .setPlaceholder("lake")
          .setValue(this.plugin.settings.lakeExecutable)
          .onChange(value => { this.plugin.settings.lakeExecutable = value.trim() || "lake"; }));
    }
    const performance = this.containerEl.createEl("details", { cls: "lean4-performance-settings" });
    performance.createEl("summary", { text: LeanI18n.text("settings.performance") });
    new Setting(performance)
      .setName(LeanI18n.text("settings.checkDelay"))
      .setDesc(LeanI18n.text("settings.checkDelayDesc"))
      .addSlider(slider => slider
        .setLimits(50, 2_000, 50)
        .setValue(this.plugin.settings.debounceMs)
        .setDynamicTooltip()
        .onChange(value => { this.plugin.settings.debounceMs = value; }));
    new Setting(performance)
      .setName(LeanI18n.text("settings.maxDocuments"))
      .setDesc(LeanI18n.text("settings.maxDocumentsDesc"))
      .addSlider(slider => slider
        .setLimits(1, 16, 1)
        .setValue(this.plugin.settings.maxOpenBlocks)
        .setDynamicTooltip()
        .onChange(value => { this.plugin.settings.maxOpenBlocks = value; }));
    new Setting(performance)
      .setName(LeanI18n.text("settings.idleTimeout"))
      .setDesc(LeanI18n.text("settings.idleTimeoutDesc"))
      .addSlider(slider => slider
        .setLimits(10, 600, 10)
        .setValue(this.plugin.settings.idleTimeoutMs / 1_000)
        .setDynamicTooltip()
        .onChange(value => { this.plugin.settings.idleTimeoutMs = value * 1_000; }));
    new Setting(this.containerEl)
      .setName(LeanI18n.text("settings.apply"))
      .setDesc(LeanI18n.text("settings.applyDesc"))
      .addButton(button => button
        .setButtonText(LeanI18n.text("settings.save"))
        .setCta()
        .onClick(async () => {
          button.setDisabled(true);
          try {
            await this.plugin.applySettings();
            new Notice(LeanI18n.text("notice.settingsApplied"));
          } catch (error) {
            new Notice(LeanI18n.text("notice.settingsFailed", { error: error instanceof Error ? error.message : String(error) }));
          } finally {
            button.setDisabled(false);
          }
        }));
    this.containerEl.createEl("p", {
      cls: "lean4-muted",
      text: LeanI18n.text("settings.examples")
    });
    this.containerEl.createEl("p", {
      cls: "lean4-muted",
      text: LeanI18n.text("settings.sessions")
    });
  }

  override hide(): void {
    this.stopObserving();
  }

  private stopObserving(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
