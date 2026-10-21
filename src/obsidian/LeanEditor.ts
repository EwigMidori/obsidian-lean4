import { Prec, StateEffect, type Extension, type Range } from "@codemirror/state";
import {
  Decoration, EditorView, ViewPlugin, WidgetType, keymap,
  type DecorationSet, type ViewUpdate
} from "@codemirror/view";
import { editorInfoField } from "obsidian";
import type { ProofBlockSnapshot, Unsubscribe } from "../application/contracts";
import { LeanPresentation, LeanSyntax, type LeanToken } from "./LeanPresentation";
import type { ObsidianProofHost } from "./ObsidianProofHost";

/** Installs additive decorations and key bindings without replacing Markdown's language. */
export class LeanEditor {
  static readonly refresh = StateEffect.define<void>();

  constructor(private readonly host: ObsidianProofHost) {}

  extension(): Extension {
    return [
      ViewPlugin.define(view => new LeanEditorSession(view, this.host), {
        decorations: session => session.decorations
      }),
      Prec.high(keymap.of([
        { key: "Tab", run: view => this.insertUnicode(view) },
        { key: "Enter", run: view => this.insertIndentedLine(view) }
      ]))
    ];
  }

  private blockAt(view: EditorView, offset: number): ProofBlockSnapshot | undefined {
    const noteId = view.state.field(editorInfoField, false)?.file?.path;
    if (!noteId) return undefined;
    return this.host.blocksForNote(noteId).find(block =>
      offset >= block.codeFrom &&
      (offset < block.codeTo || block.includesEnd && offset === block.codeTo));
  }

  private insertUnicode(view: EditorView): boolean {
    if (view.state.readOnly || !view.state.facet(EditorView.editable)) return false;
    const selection = view.state.selection;
    if (selection.ranges.length !== 1 || !selection.main.empty) return false;
    const cursor = selection.main.head;
    const block = this.blockAt(view, cursor);
    if (!block) return false;
    const preceding = view.state.sliceDoc(Math.max(block.codeFrom, cursor - 32), cursor);
    const match = /\\([A-Za-z0-9_]+)$/u.exec(preceding);
    if (!match) return false;
    const replacement = LeanUnicodeInput.lookup(match[1] ?? "");
    if (!replacement) return false;
    view.dispatch({
      changes: { from: cursor - match[0].length, to: cursor, insert: replacement },
      selection: { anchor: cursor - match[0].length + replacement.length },
      userEvent: "input"
    });
    return true;
  }

  private insertIndentedLine(view: EditorView): boolean {
    if (view.state.readOnly || !view.state.facet(EditorView.editable)) return false;
    const selection = view.state.selection;
    if (selection.ranges.length !== 1) return false;
    const { from, to } = selection.main;
    const block = this.blockAt(view, from);
    if (!block || to > block.codeTo) return false;
    const line = view.state.doc.lineAt(from);
    const before = view.state.sliceDoc(line.from, from);
    const indent = /^[ \t]*/u.exec(before)?.[0] ?? "";
    const extra = /(?:\b(?:by|where|do|then|else)|:=|=>)\s*$/u.test(before) ? "  " : "";
    const insert = `\n${indent}${extra}`;
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length },
      userEvent: "input"
    });
    return true;
  }
}

/** Each live editor owns its note lease, token cache, and deferred refresh. */
class LeanEditorSession {
  decorations: DecorationSet = Decoration.none;
  private noteId: string | null = null;
  private readonly syntax = new LeanSyntax();
  private readonly tokenCache = new Map<string, { source: string; tokens: readonly LeanToken[] }>();
  private readonly unsubscribe: Unsubscribe;
  private destroyed = false;
  private refreshPending = false;

  constructor(private readonly view: EditorView, private readonly host: ObsidianProofHost) {
    this.synchronize();
    this.unsubscribe = host.subscribe(() => this.requestRefresh());
    this.rebuild();
    if (view.hasFocus) this.inspect();
  }

  update(update: ViewUpdate): void {
    const noteId = this.currentNoteId();
    if (update.docChanged || noteId !== this.noteId) this.synchronize();
    if (update.docChanged || update.selectionSet || update.focusChanged) {
      if (this.view.hasFocus) this.inspect();
    }
    if (update.docChanged || update.viewportChanged || update.transactions.some(transaction =>
      transaction.effects.some(effect => effect.is(LeanEditor.refresh)))) this.rebuild();
  }

  destroy(): void {
    this.destroyed = true;
    this.unsubscribe();
    this.host.release(this);
    this.tokenCache.clear();
  }

  private currentNoteId(): string | null {
    return this.view.state.field(editorInfoField, false)?.file?.path ?? null;
  }

  private synchronize(): void {
    this.noteId = this.currentNoteId();
    if (this.noteId) {
      this.host.bindEditor(this, this.noteId, this.view.state.doc.toString());
    } else {
      this.host.release(this);
    }
  }

  private inspect(): void {
    if (this.noteId) this.host.inspectAt(this.noteId, this.view.state.selection.main.head);
  }

  private requestRefresh(): void {
    if (this.refreshPending || this.destroyed) return;
    this.refreshPending = true;
    queueMicrotask(() => {
      this.refreshPending = false;
      if (!this.destroyed) this.view.dispatch({ effects: LeanEditor.refresh.of(undefined) });
    });
  }

  private rebuild(): void {
    const blocks = this.noteId ? this.host.blocksForNote(this.noteId) : [];
    const existing = new Set(blocks.map(block => block.id));
    for (const blockId of this.tokenCache.keys()) {
      if (!existing.has(blockId)) this.tokenCache.delete(blockId);
    }
    const decorations: Range<Decoration>[] = [];
    const length = this.view.state.doc.length;
    for (const block of blocks) {
      if (block.from > length || !this.visible(block.from, block.to)) continue;
      const header = this.view.state.doc.lineAt(block.from);
      decorations.push(Decoration.line({ class: "lean4-block-header" }).range(header.from));
      decorations.push(Decoration.widget({
        widget: new LeanBlockBadge(block),
        side: 1
      }).range(header.to));
      if (block.code.length <= 200_000) {
        const source = this.view.state.sliceDoc(block.codeFrom, Math.min(length, block.codeTo));
        let cached = this.tokenCache.get(block.id);
        if (cached?.source !== source) {
          cached = { source, tokens: this.syntax.tokenize(source) };
          this.tokenCache.set(block.id, cached);
        }
        for (const token of cached.tokens) {
          const from = block.codeFrom + token.from;
          const to = Math.min(length, block.codeFrom + token.to);
          if (from < to && this.visible(from, to)) {
            decorations.push(Decoration.mark({ class: token.className }).range(from, to));
          }
        }
      }
      for (const diagnostic of block.diagnostics) {
        const from = Math.max(0, Math.min(length, diagnostic.from));
        const to = Math.min(length, Math.max(from + 1, diagnostic.to));
        if (from < to && this.visible(from, to)) {
          decorations.push(Decoration.mark({
            class: `lean4-diagnostic lean4-diagnostic-${diagnostic.severity}`,
            attributes: { title: diagnostic.message }
          }).range(from, to));
        }
      }
    }
    this.decorations = Decoration.set(decorations, true);
  }

  private visible(from: number, to: number): boolean {
    return this.view.visibleRanges.some(range => from <= range.to && to >= range.from);
  }
}

class LeanBlockBadge extends WidgetType {
  private readonly label: string;
  private readonly title: string;
  private readonly state: string;

  constructor(block: ProofBlockSnapshot) {
    super();
    this.label = [block.title, LeanPresentation.sessionLabel(block), LeanPresentation.blockLabel(block)].filter(Boolean).join(" · ");
    this.title = block.metadataError ?? block.message ?? (block.diagnostics.map(item => item.message).join("\n") || LeanPresentation.checkDescription(block));
    this.state = LeanPresentation.blockTone(block);
  }

  override eq(other: LeanBlockBadge): boolean {
    return this.label === other.label && this.title === other.title && this.state === other.state;
  }

  override toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = `lean4-status lean4-status-${this.state}`;
    span.textContent = this.label;
    span.title = this.title;
    return span;
  }
}

/** Deliberately small, explicit starter dictionary; Tab consumes only known sequences. */
class LeanUnicodeInput {
  private static readonly symbols: Readonly<Record<string, string>> = {
    alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", zeta: "ζ",
    eta: "η", theta: "θ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ",
    nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ",
    phi: "φ", chi: "χ", psi: "ψ", omega: "ω",
    Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Pi: "Π", Sigma: "Σ",
    Phi: "Φ", Psi: "Ψ", Omega: "Ω",
    forall: "∀", exists: "∃", fun: "λ", to: "→", r: "→", left: "←",
    iff: "↔", and: "∧", or: "∨", not: "¬", ne: "≠", le: "≤", ge: "≥",
    in: "∈", notin: "∉", subset: "⊆", union: "∪", inter: "∩", empty: "∅",
    Nat: "ℕ", Int: "ℤ", Rat: "ℚ", Real: "ℝ", Complex: "ℂ",
    N: "ℕ", Z: "ℤ", Q: "ℚ", R: "ℝ", C: "ℂ",
    l: "⟨", rangle: "⟩", langle: "⟨", angle: "∠", times: "×", cdot: "·",
    comp: "∘", sum: "∑", prod: "∏", inf: "∞", _1: "₁", _2: "₂", _3: "₃"
  };

  static lookup(sequence: string): string | undefined {
    return this.symbols[sequence];
  }
}
