import { MarkdownBlockParser } from "./MarkdownBlockParser";
import { ParsedProofBlock, ProofBlock } from "./ProofBlock";

export interface CatalogChange {
  readonly added: readonly ProofBlock[];
  readonly changed: readonly ProofBlock[];
  readonly removed: readonly ProofBlock[];
}

interface TextEdit {
  readonly from: number;
  readonly oldTo: number;
  readonly delta: number;
}

/** Keeps identities only where unchanged fences or unique content make them clear. */
export class BlockCatalog {
  private text = "";
  private current: readonly ProofBlock[] = [];
  private readonly parser = new MarkdownBlockParser();

  constructor(readonly noteId: string) {}

  get blocks(): readonly ProofBlock[] { return this.current; }

  blockAt(offset: number): ProofBlock | undefined {
    return this.current.find((block) => block.sourceMap.contains(offset));
  }

  update(text: string): CatalogChange {
    if (text === this.text) return { added: [], changed: [], removed: [] };
    const parsed = this.parser.parse(text);
    const edit = this.changedSpan(this.text, text);
    const available = new Set(this.current);
    const added: ProofBlock[] = [];
    const changed: ProofBlock[] = [];
    const matches = new Map<ParsedProofBlock, ProofBlock>();
    // Exact mapped fence boundaries disambiguate repeated examples during prose edits.
    const boundaries = new Map<string, ProofBlock>();
    for (const old of this.current) {
      const from = this.translate(old.from, edit);
      const closing = old.closingFenceFrom === null ? null : this.translate(old.closingFenceFrom, edit);
      if (from !== null && (old.closingFenceFrom === null || closing !== null)) {
        boundaries.set(`${from}:${closing}`, old);
      }
    }
    for (const block of parsed) {
      const old = boundaries.get(`${block.from}:${block.closingFenceFrom}`);
      if (old && available.has(old)) {
        matches.set(block, old);
        available.delete(old);
      }
    }
    // A move can retain an identity only when its complete contents are unique.
    const oldSignatures = this.groupOld(available);
    const newSignatures = this.groupNew(parsed.filter((block) => !matches.has(block)));
    for (const [signature, candidates] of newSignatures) {
      const previous = oldSignatures.get(signature);
      if (candidates.length === 1 && previous?.length === 1) {
        matches.set(candidates[0]!, previous[0]!);
        available.delete(previous[0]!);
      }
    }
    this.current = parsed.map((definition, ordinal) => {
      const previous = matches.get(definition);
      if (previous) {
        if (previous.replace(definition, ordinal)) changed.push(previous);
        return previous;
      }
      const block = new ProofBlock(this.noteId, definition, ordinal);
      added.push(block);
      return block;
    });
    this.text = text;
    return { added, changed, removed: [...available] };
  }

  private signature(block: { readonly code: string; readonly displayOnly: boolean }): string {
    return `${block.displayOnly ? "display" : "check"}\0${block.code}`;
  }

  private groupOld(blocks: Iterable<ProofBlock>): Map<string, ProofBlock[]> {
    const grouped = new Map<string, ProofBlock[]>();
    for (const block of blocks) {
      const signature = this.signature(block);
      const group = grouped.get(signature) ?? [];
      group.push(block);
      grouped.set(signature, group);
    }
    return grouped;
  }

  private groupNew(blocks: readonly ParsedProofBlock[]): Map<string, ParsedProofBlock[]> {
    const grouped = new Map<string, ParsedProofBlock[]>();
    for (const block of blocks) {
      const signature = this.signature(block);
      const group = grouped.get(signature) ?? [];
      group.push(block);
      grouped.set(signature, group);
    }
    return grouped;
  }

  private changedSpan(previous: string, next: string): TextEdit {
    let from = 0;
    while (from < previous.length && from < next.length && previous[from] === next[from]) from += 1;
    let oldTo = previous.length;
    let nextTo = next.length;
    while (oldTo > from && nextTo > from && previous[oldTo - 1] === next[nextTo - 1]) {
      oldTo -= 1;
      nextTo -= 1;
    }
    return { from, oldTo, delta: next.length - previous.length };
  }

  private translate(offset: number, edit: TextEdit): number | null {
    if (offset < edit.from) return offset;
    if (offset >= edit.oldTo) return offset + edit.delta;
    return null;
  }
}
