/** Keeps the check action beside the host's source action in Live Preview. */
export class LeanReadingActions {
  private embed: HTMLElement | null = null;
  private observer: MutationObserver | null = null;
  private frame: number | null = null;
  private disposed = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly fallback: HTMLElement,
    private readonly check: HTMLButtonElement
  ) {}

  mount(): void {
    this.refresh();
    this.frame = window.requestAnimationFrame(() => {
      this.frame = null;
      this.refresh();
    });
  }

  refresh(): void {
    if (this.disposed) return;
    const embed = this.container.closest<HTMLElement>(".cm-embed-block");
    if (embed !== this.embed) {
      this.observer?.disconnect();
      this.embed = embed;
      this.observer = embed ? new MutationObserver(() => this.place()) : null;
      if (embed) this.observer!.observe(embed, { childList: true, subtree: true });
    }
    this.place();
  }

  dispose(): void {
    this.disposed = true;
    this.observer?.disconnect();
    if (this.frame !== null) window.cancelAnimationFrame(this.frame);
    this.check.remove();
    this.embed = null;
  }

  private place(): void {
    if (this.disposed) return;
    const source = this.embed?.querySelector<HTMLElement>(":scope > .embed-actions > .edit-block-button");
    const actions = source?.parentElement;
    if (source && actions) {
      this.check.classList.add("embed-action", "lean4-docked-action");
      if (this.check.parentElement !== actions || this.check.nextElementSibling !== source) {
        actions.insertBefore(this.check, source);
      }
    } else {
      this.check.classList.remove("embed-action", "lean4-docked-action");
      if (this.check.parentElement !== this.fallback) this.fallback.append(this.check);
    }
  }
}
