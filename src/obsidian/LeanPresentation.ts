import type { BlockCheckState, ProofBlockSnapshot } from "../application/contracts";
import { LeanI18n } from "./LeanI18n";

/** User-facing labels belong to the presentation boundary, never the proof domain. */
export class LeanPresentation {
  static blockTone(block: ProofBlockSnapshot): BlockCheckState | "warning" {
    if (block.metadataError || block.diagnostics.some(item => item.severity === "error")) return "error";
    if (block.diagnostics.some(item => item.severity === "warning")) return "warning";
    return block.state;
  }

  static blockLabel(block: ProofBlockSnapshot): string {
    if (block.metadataError) return LeanI18n.text("block.invalid");
    const errors = block.diagnostics.filter(item => item.severity === "error").length;
    const warnings = block.diagnostics.filter(item => item.severity === "warning").length;
    const summary = [
      errors ? LeanI18n.text(errors === 1 ? "count.error" : "count.errors", { count: errors }) : "",
      warnings ? LeanI18n.text(warnings === 1 ? "count.warning" : "count.warnings", { count: warnings }) : ""
    ]
      .filter(Boolean)
      .join(", ");
    return summary && block.state === "checked" ? summary : LeanI18n.text(`block.${block.state}`);
  }

  static sessionLabel(block: ProofBlockSnapshot): string {
    if (!block.session) return "";
    const errors = block.documentErrorCount ?? 0;
    const status = errors > 0 && !block.displayOnly
      ? ` · ${LeanI18n.text(errors === 1 ? "session.error" : "session.errors", { count: errors })}` : "";
    return LeanI18n.text(block.displayOnly ? "session.excluded" : "session.label", { name: block.session }) + status;
  }

  static checkLabel(block: ProofBlockSnapshot): string {
    return LeanI18n.text(block.session && !block.displayOnly ? "block.checkSession" : "block.check");
  }

  static checkDescription(block: ProofBlockSnapshot): string {
    return block.session
      ? LeanI18n.text("block.checkSessionDescription", { name: block.session })
      : LeanI18n.text("block.checkDescription");
  }

  static documentCount(blocks: readonly ProofBlockSnapshot[], state: BlockCheckState): number {
    return new Set(blocks.filter(block => block.state === state).map(block => block.documentId ?? block.id)).size;
  }
}

export interface LeanToken {
  readonly from: number;
  readonly to: number;
  readonly className: string;
}

/** A small visual lexer; proof parsing and correctness always belong to Lean. */
export class LeanSyntax {
  private readonly keyword = new Set([
    "abbrev", "axiom", "by", "calc", "class", "def", "deriving", "do", "else", "end",
    "example", "exists", "export", "extends", "forall", "from", "fun", "have", "if",
    "import", "in", "inductive", "instance", "let", "match", "namespace", "noncomputable",
    "opaque", "open", "partial", "private", "protected", "section", "set_option", "show",
    "structure", "theorem", "then", "universe", "unsafe", "variable", "variables", "where",
    "with", "Type", "Prop", "Sort"
  ]);

  tokenize(code: string): readonly LeanToken[] {
    const tokens: LeanToken[] = [];
    const pattern = /--[^\r\n]*|\/-|"(?:\\[\s\S]|[^"\\])*(?:"|$)|[\p{L}_][\p{L}\p{N}_'.]*|\d+(?:\.\d+)?|[∀∃λ→←↔∧∨¬:=<>+*/^|]+/gu;
    for (let match = pattern.exec(code); match; match = pattern.exec(code)) {
      const value = match[0];
      let to = pattern.lastIndex;
      let className: string | undefined;
      if (value === "/-") {
        to = this.commentEnd(code, to);
        pattern.lastIndex = to;
        className = "lean4-token-comment";
      } else if (value.startsWith("--")) {
        className = "lean4-token-comment";
      } else if (value.startsWith('"')) {
        className = "lean4-token-string";
      } else if (this.keyword.has(value)) {
        className = "lean4-token-keyword";
      } else if (/^\d/u.test(value)) {
        className = "lean4-token-number";
      } else if (/^[∀∃λ→←↔∧∨¬:=<>+*/^|]/u.test(value)) {
        className = "lean4-token-operator";
      }
      if (className) tokens.push({ from: match.index, to, className });
    }
    return tokens;
  }

  render(container: HTMLElement, source: string): void {
    container.empty();
    if (source.length > 200_000) {
      container.textContent = source;
      return;
    }
    let offset = 0;
    for (const token of this.tokenize(source)) {
      container.appendText(source.slice(offset, token.from));
      container.createSpan({ cls: token.className, text: source.slice(token.from, token.to) });
      offset = token.to;
    }
    container.appendText(source.slice(offset));
  }

  private commentEnd(code: string, offset: number): number {
    let depth = 1;
    while (offset < code.length && depth > 0) {
      const pair = code.slice(offset, offset + 2);
      if (pair === "/-") {
        depth++;
        offset += 2;
      } else if (pair === "-/") {
        depth--;
        offset += 2;
      } else {
        offset++;
      }
    }
    return offset;
  }
}
