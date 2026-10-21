import { StateField } from "@codemirror/state";
import type { MarkdownFileInfo } from "obsidian";

export class ObsidianLocale {
  private static language = "en";
  static get(): string { return this.language; }
  static set(language: string): void { this.language = language; }
}

export const getLanguage = (): string => ObsidianLocale.get();
export const setLanguage = (language: string): void => ObsidianLocale.set(language);
export const setIcon = (element: HTMLElement, icon: string): void => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", `svg-icon lucide-${icon}`);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("viewBox", "0 0 24 24");
  element.replaceChildren(svg);
};

/** Test implementations of the public API surface used by the adapters. */
export class TFile {
  constructor(public path: string) {}
}

export class Notice {
  static readonly messages: string[] = [];
  constructor(message: string) { Notice.messages.push(message); }
}

export class Component {
  private readonly cleaners: (() => void)[] = [];
  private loaded = false;

  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.onload();
  }

  unload(): void {
    if (!this.loaded) return;
    this.loaded = false;
    this.onunload();
    for (const cleaner of this.cleaners.splice(0)) cleaner();
  }

  onload(): void {}
  onunload(): void {}
  register(cleaner: () => void): void { this.cleaners.push(cleaner); }
  registerDomEvent(element: HTMLElement, name: string, callback: EventListener): void {
    element.addEventListener(name, callback);
    this.register(() => element.removeEventListener(name, callback));
  }
}

export class MarkdownRenderChild extends Component {
  constructor(readonly containerEl: HTMLElement) { super(); }
}

export class ItemView extends Component {
  readonly contentEl = document.createElement("div");
  readonly app: unknown;
  constructor(readonly leaf: { app?: unknown }) {
    super();
    this.app = leaf.app ?? {};
  }
}

export class MarkdownView extends Component {}

export class PluginSettingTab {}
export class Setting {}

export const editorInfoField = StateField.define<MarkdownFileInfo>({
  create: () => ({ file: null } as MarkdownFileInfo),
  update: value => value
});

/** Obsidian's documented HTMLElement helpers, only for the browser test realm. */
export class ObsidianDom {
  static install(): void {
    Object.assign(HTMLElement.prototype, {
      empty(this: HTMLElement): void { this.replaceChildren(); },
      addClass(this: HTMLElement, ...names: string[]): void { this.classList.add(...names); },
      appendText(this: HTMLElement, text: string): void { this.append(document.createTextNode(text)); },
      createEl(this: HTMLElement, tag: string, options: { cls?: string; text?: string } = {}): HTMLElement {
        const element = document.createElement(tag);
        if (options.cls) element.className = options.cls;
        if (options.text) element.textContent = options.text;
        this.append(element);
        return element;
      },
      createDiv(this: HTMLElement, options: { cls?: string; text?: string } = {}): HTMLElement {
        return this.createEl("div", options);
      },
      createSpan(this: HTMLElement, options: { cls?: string; text?: string } = {}): HTMLElement {
        return this.createEl("span", options);
      }
    });
  }
}
