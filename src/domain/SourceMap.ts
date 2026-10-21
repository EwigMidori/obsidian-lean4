export interface SourcePosition {
  readonly line: number;
  readonly character: number;
}

export interface SourceLine {
  readonly sourceStart: number;
  readonly contentStart: number;
  readonly length: number;
}

/** Owns the translation between one fenced document and its Markdown source. */
export class SourceMap {
  constructor(
    readonly from: number,
    readonly to: number,
    private readonly lines: readonly SourceLine[],
    readonly includesEnd = false,
  ) {}

  contains(offset: number): boolean {
    return offset >= this.from && (offset < this.to || this.includesEnd && offset === this.to);
  }

  positionAt(offset: number): SourcePosition | null {
    if (!this.contains(offset)) return null;
    if (this.lines.length === 0) return { line: 0, character: 0 };
    let low = 0;
    let high = this.lines.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (this.lines[middle]!.sourceStart <= offset) low = middle;
      else high = middle - 1;
    }
    const line = this.lines[low]!;
    return {
      line: low,
      character: Math.max(0, Math.min(line.length, offset - line.contentStart)),
    };
  }

  offsetAt(position: SourcePosition): number {
    if (this.lines.length === 0) return this.from;
    if (position.line >= this.lines.length) return this.to;
    const line = this.lines[Math.max(0, position.line)]!;
    return line.contentStart + Math.max(0, Math.min(line.length, position.character));
  }
}
