import { ProofBlock } from "./ProofBlock";
import { SourceMap, SourcePosition } from "./SourceMap";

export interface ProofDocumentChange {
  readonly changed: boolean;
  readonly mappingChanged: boolean;
}

export interface ProofDocumentRange {
  readonly start: SourcePosition;
  readonly end: SourcePosition;
}

export interface MappedDocumentRange {
  readonly blockId: string;
  readonly from: number;
  readonly to: number;
  readonly range: ProofDocumentRange;
}

interface DocumentMember {
  readonly blockId: string;
  readonly start: number;
  readonly end: number;
  readonly lineStarts: readonly number[];
  readonly sourceMap: SourceMap;
  readonly mapping: readonly number[];
}

interface DocumentComposition {
  readonly code: string;
  readonly members: readonly DocumentMember[];
  readonly lineStarts: readonly number[];
}

/** Owns one Lean source document and the projection back to its Markdown members. */
export class ProofDocument {
  private static nextId = 1;
  readonly id: string;
  readonly session: string | undefined;
  private revision: number;
  private epoch = 1;
  private current: readonly ProofBlock[];
  private composition: DocumentComposition;

  constructor(
    readonly noteId: string,
    members: readonly ProofBlock[],
    session?: string,
  ) {
    this.session = session || undefined;
    this.assertMembers(members);
    this.id = this.session === undefined ? members[0]!.id : `proof-document-${ProofDocument.nextId++}`;
    this.revision = this.session === undefined ? members[0]!.version : 1;
    this.current = [...members];
    this.composition = this.compose(members);
  }

  get members(): readonly ProofBlock[] { return this.current; }
  get code(): string { return this.composition.code; }
  get version(): number { return this.revision; }
  get mappingEpoch(): number { return this.epoch; }
  get ordinal(): number { return this.current[0]!.ordinal; }

  containsBlock(blockId: string): boolean {
    return this.composition.members.some((member) => member.blockId === blockId);
  }

  replace(members: readonly ProofBlock[]): ProofDocumentChange {
    this.assertMembers(members);
    if (this.session === undefined && members[0]!.id !== this.id) {
      throw new Error("An independent proof document retains its original block identity.");
    }
    const next = this.compose(members);
    const changed = next.code !== this.code;
    const mappingChanged = !this.sameMapping(next.members);
    if (changed) this.revision += 1;
    if (mappingChanged) this.epoch += 1;
    this.current = [...members];
    this.composition = next;
    return { changed, mappingChanged };
  }

  positionAt(blockId: string, markdownOffset: number): SourcePosition | null {
    const member = this.composition.members.find((candidate) => candidate.blockId === blockId);
    if (!member) return null;
    const local = member.sourceMap.positionAt(markdownOffset);
    if (!local) return null;
    const offset = member.start + this.offsetAt(local, member.lineStarts, member.end - member.start);
    return this.positionOf(offset, this.composition.lineStarts);
  }

  mapRange(range: ProofDocumentRange): readonly MappedDocumentRange[] {
    if (!this.hasPosition(range.start) || !this.hasPosition(range.end)) return [];
    const start = this.offsetAt(range.start, this.composition.lineStarts, this.code.length);
    const end = this.offsetAt(range.end, this.composition.lineStarts, this.code.length);
    if (end < start) return [];
    if (start === end) {
      const member = this.memberAtPoint(start);
      return member ? [this.mapMemberRange(member, start, end)] : [];
    }
    const mapped: MappedDocumentRange[] = [];
    for (const member of this.composition.members) {
      const overlapStart = Math.max(start, member.start);
      const overlapEnd = Math.min(end, member.end);
      // Endpoints are half-open: a range ending at the next block never marks it.
      if (overlapStart < overlapEnd) {
        mapped.push(this.mapMemberRange(member, overlapStart, overlapEnd));
      }
    }
    return mapped;
  }

  private assertMembers(members: readonly ProofBlock[]): void {
    if (members.length === 0) throw new Error("A proof document requires at least one block.");
    if (members.some((member) => member.noteId !== this.noteId || member.displayOnly)) {
      throw new Error("A proof document can only contain checked blocks from its own note.");
    }
    if (this.session === undefined && members.length !== 1) {
      throw new Error("An independent proof document contains exactly one block.");
    }
    if (members.some((member) => (member.session || undefined) !== this.session)) {
      throw new Error("Every shared proof document member must declare the same session.");
    }
    if (new Set(members.map((member) => member.id)).size !== members.length) {
      throw new Error("A proof block can occur only once in a proof document.");
    }
  }

  private compose(blocks: readonly ProofBlock[]): DocumentComposition {
    const pieces: string[] = [];
    const members: DocumentMember[] = [];
    let offset = 0;
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index]!;
      const lineStarts = this.readLineStarts(block.code);
      const mapping = [
        block.from, block.to, block.sourceMap.from, block.sourceMap.to,
        Number(block.sourceMap.includesEnd),
      ];
      let previousEnd = block.sourceMap.from;
      for (let line = 0; line < lineStarts.length; line += 1) {
        const lineEnd = line + 1 < lineStarts.length ? lineStarts[line + 1]! - 1 : block.code.length;
        const contentStart = block.sourceMap.offsetAt({ line, character: 0 });
        const contentEnd = block.sourceMap.offsetAt({ line, character: lineEnd - lineStarts[line]! });
        mapping.push(
          lineStarts[line]!,
          this.lineSourceStart(block.sourceMap, line, previousEnd, contentStart),
          contentStart, contentEnd,
        );
        previousEnd = contentEnd;
      }
      members.push({
        blockId: block.id,
        start: offset,
        end: offset + block.code.length,
        sourceMap: block.sourceMap,
        lineStarts,
        mapping,
      });
      pieces.push(block.code);
      offset += block.code.length;
      if (index + 1 < blocks.length && !block.code.endsWith("\n")) {
        pieces.push("\n");
        offset += 1;
      }
    }
    const code = pieces.join("");
    return { code, members, lineStarts: this.readLineStarts(code) };
  }

  private sameMapping(next: readonly DocumentMember[]): boolean {
    if (next.length !== this.composition.members.length) return false;
    return next.every((member, index) => {
      const previous = this.composition.members[index]!;
      return member.blockId === previous.blockId
        && member.start === previous.start
        && member.end === previous.end
        && member.mapping.length === previous.mapping.length
        && member.mapping.every((coordinate, at) => coordinate === previous.mapping[at]);
    });
  }

  private readLineStarts(code: string): readonly number[] {
    const starts = [0];
    let newline = code.indexOf("\n");
    while (newline >= 0) {
      starts.push(newline + 1);
      newline = code.indexOf("\n", newline + 1);
    }
    return starts;
  }

  private lineSourceStart(sourceMap: SourceMap, line: number, from: number, to: number): number {
    // A CRLF-to-LF edit can trade one newline character for indentation, keeping
    // content offsets unchanged while changing which Lean line owns the gap.
    if (line === 0) return sourceMap.from;
    let low = from;
    let high = to;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const position = sourceMap.positionAt(middle);
      if (position && position.line >= line) high = middle;
      else low = middle + 1;
    }
    return low;
  }

  private offsetAt(position: SourcePosition, lineStarts: readonly number[], length: number): number {
    const line = Math.max(0, position.line);
    if (line >= lineStarts.length) return length;
    const start = lineStarts[line]!;
    const end = line + 1 < lineStarts.length ? lineStarts[line + 1]! - 1 : length;
    return start + Math.max(0, Math.min(end - start, position.character));
  }

  private hasPosition(position: SourcePosition): boolean {
    if (!Number.isInteger(position.line) || !Number.isInteger(position.character)) return false;
    if (position.line < 0 || position.character < 0) return false;
    const starts = this.composition.lineStarts;
    if (position.line >= starts.length) return false;
    const end = position.line + 1 < starts.length ? starts[position.line + 1]! - 1 : this.code.length;
    return position.character <= end - starts[position.line]!;
  }

  private positionOf(offset: number, lineStarts: readonly number[]): SourcePosition {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (lineStarts[middle]! <= offset) low = middle;
      else high = middle - 1;
    }
    return { line: low, character: offset - lineStarts[low]! };
  }

  private memberAtPoint(offset: number): DocumentMember | undefined {
    const members = this.composition.members;
    if (offset === this.code.length) return members.at(-1);
    // Prefer the following block at a shared boundary, including empty members.
    for (let index = members.length - 1; index >= 0; index -= 1) {
      const member = members[index]!;
      if (member.start <= offset && offset < member.end || member.start === offset) return member;
    }
    // A zero-width location at the start of an inserted LF is also the preceding
    // member's real EOF. Nonempty separator-only ranges have no source overlap.
    return members.find((member) => member.end === offset);
  }

  private mapMemberRange(member: DocumentMember, from: number, to: number): MappedDocumentRange {
    const start = this.positionOf(from - member.start, member.lineStarts);
    const end = this.positionOf(to - member.start, member.lineStarts);
    return {
      blockId: member.blockId,
      from: member.sourceMap.offsetAt(start),
      to: member.sourceMap.offsetAt(end),
      range: { start, end },
    };
  }
}
