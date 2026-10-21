import { describe, expect, it } from "vitest";
import { BlockCatalog } from "../../src/domain/BlockCatalog";
import { DocumentCatalog } from "../../src/domain/DocumentCatalog";
import { ParsedProofBlock, ProofBlock } from "../../src/domain/ProofBlock";
import { ProofDocument } from "../../src/domain/ProofDocument";
import { SourceMap } from "../../src/domain/SourceMap";

class DocumentFixture {
  readonly blocks: BlockCatalog;
  readonly documents: DocumentCatalog;

  constructor(readonly noteId = "Proofs.md") {
    this.blocks = new BlockCatalog(noteId);
    this.documents = new DocumentCatalog(noteId);
  }

  update(markdown: string) {
    this.blocks.update(markdown);
    return this.documents.update(this.blocks.blocks);
  }

  static parsed(code: string, from: number, session?: string, displayOnly = false): ParsedProofBlock {
    const lines = code.split("\n");
    let start = from;
    const sourceLines = lines.map((line) => {
      const source = { sourceStart: start, contentStart: start, length: line.length };
      start += line.length + 1;
      return source;
    });
    return {
      code, language: "lean", info: "lean", session, displayOnly,
      from, to: from + code.length, closingFenceFrom: null,
      sourceMap: new SourceMap(from, from + code.length, sourceLines, true),
    };
  }

  static block(code: string, from: number, ordinal: number, session?: string, noteId = "Proofs.md") {
    return new ProofBlock(noteId, DocumentFixture.parsed(code, from, session), ordinal);
  }

  static fence(code: string, options = ""): string {
    return `\`\`\`lean${options ? ` ${options}` : ""}\n${code}\n\`\`\`\n`;
  }
}

describe("proof document membership and source versions", () => {
  it("shares only explicitly named blocks in Markdown order without injecting imports", () => {
    const fixture = new DocumentFixture();
    const markdown = DocumentFixture.fence("def n := 1", "session=arithmetic")
      + DocumentFixture.fence("def n := 2")
      + DocumentFixture.fence("#check n", "session=arithmetic");
    const changes = fixture.update(markdown);
    const [first, independent, last] = fixture.blocks.blocks;
    const document = fixture.documents.documentFor(first!.id)!;
    expect(changes.added).toHaveLength(2);
    expect(document.members).toEqual([first, last]);
    expect(document.code).toBe("def n := 1\n#check n\n");
    expect(document.session).toBe("arithmetic");
    expect(fixture.documents.documentFor(last!.id)).toBe(document);
    expect(fixture.documents.documentFor(independent!.id)!.id).toBe(independent!.id);
    expect(document.containsBlock(last!.id)).toBe(true);
    expect(document.containsBlock(independent!.id)).toBe(false);
  });

  it("compares session names exactly and keeps independent documents at their block version", () => {
    const catalog = new DocumentCatalog("Proofs.md");
    const blocks = [
      DocumentFixture.block("a", 0, 0, "Group"),
      DocumentFixture.block("b", 10, 1, "group"),
      DocumentFixture.block("c", 20, 2, ""),
      DocumentFixture.block("d", 30, 3),
    ];
    blocks[3]!.replace(DocumentFixture.parsed("e", 30), 3);
    catalog.update(blocks);
    expect(catalog.documents).toHaveLength(4);
    expect(catalog.documents[2]!.session).toBeUndefined();
    expect(catalog.documents[2]!.id).toBe(blocks[2]!.id);
    expect(catalog.documents[3]!.version).toBe(2);
  });

  it("inserts one LF only when a preceding member has no trailing LF", () => {
    const members = [
      DocumentFixture.block("a", 10, 0, "s"),
      DocumentFixture.block("b\n", 20, 1, "s"),
      DocumentFixture.block("c", 30, 2, "s"),
    ];
    expect(new ProofDocument("Proofs.md", members, "s").code).toBe("a\nb\nc");
  });

  it("retains group identity while reordering, moving, removing, and disabling members", () => {
    const catalog = new DocumentCatalog("Proofs.md");
    const first = DocumentFixture.block("a\n", 10, 0, "s");
    const second = DocumentFixture.block("b\n", 20, 1, "s");
    const third = DocumentFixture.block("c\n", 30, 2, "t");
    catalog.update([first, second, third]);
    const shared = catalog.documentFor(first.id)!;
    const other = catalog.documentFor(third.id)!;
    const id = shared.id;
    second.replace(DocumentFixture.parsed("b\n", 10, "s"), 0);
    first.replace(DocumentFixture.parsed("a\n", 20, "s"), 1);
    expect(catalog.update([first, second, third]).changed).toEqual([shared]);
    expect(shared.id).toBe(id);
    expect(shared.code).toBe("b\na\n");
    expect(shared.version).toBe(2);
    second.replace(DocumentFixture.parsed("b\n", 10, "t"), 0);
    expect(catalog.update([first, second, third]).changed).toEqual([other, shared]);
    expect(catalog.documentFor(second.id)).toBe(other);
    expect(shared.code).toBe("a\n");
    catalog.update([first, second]);
    expect(other.code).toBe("b\n");
    second.replace(DocumentFixture.parsed("b\n", 10, "t", true), 0);
    const disabled = catalog.update([first, second]);
    expect(disabled.removed).toEqual([other]);
    expect(catalog.documentFor(second.id)).toBeUndefined();
    expect(catalog.update([]).removed).toEqual([shared]);
  });

  it("keeps identical session names in different notes isolated", () => {
    const first = DocumentFixture.block("a", 10, 0, "s", "First.md");
    const second = DocumentFixture.block("b", 20, 0, "s", "Second.md");
    const firstCatalog = new DocumentCatalog("First.md");
    const secondCatalog = new DocumentCatalog("Second.md");
    firstCatalog.update([first, second]);
    secondCatalog.update([first, second]);
    expect(firstCatalog.documents[0]!.code).toBe("a");
    expect(secondCatalog.documents[0]!.code).toBe("b");
    expect(firstCatalog.documents[0]!.id).not.toBe(secondCatalog.documents[0]!.id);
    expect(firstCatalog.documentFor(second.id)).toBeUndefined();
  });

  it("protects aggregate membership invariants in its constructor and replacement", () => {
    const first = DocumentFixture.block("a", 10, 0, "s");
    const otherSession = DocumentFixture.block("b", 20, 1, "t");
    const independent = DocumentFixture.block("c", 30, 2);
    const otherIndependent = DocumentFixture.block("d", 40, 3);
    const foreignNote = DocumentFixture.block("e", 50, 0, "s", "Other.md");
    const displayOnly = new ProofBlock("Proofs.md", DocumentFixture.parsed("f", 60, "s", true), 4);
    expect(() => new ProofDocument("Proofs.md", [], "s")).toThrow();
    expect(() => new ProofDocument("Proofs.md", [first, otherSession], "s")).toThrow();
    expect(() => new ProofDocument("Proofs.md", [first, independent], "s")).toThrow();
    expect(() => new ProofDocument("Proofs.md", [independent, otherIndependent])).toThrow();
    expect(() => new ProofDocument("Proofs.md", [first, foreignNote], "s")).toThrow();
    expect(() => new ProofDocument("Proofs.md", [first, displayOnly], "s")).toThrow();
    expect(() => new ProofDocument("Proofs.md", [first, first], "s")).toThrow();
    const shared = new ProofDocument("Proofs.md", [first], "s");
    expect(() => shared.replace([otherSession])).toThrow();
    expect(() => shared.replace([independent])).toThrow();
    expect(shared.code).toBe("a");
    expect(shared.members).toEqual([first]);
    expect(shared.version).toBe(1);
    expect(shared.mappingEpoch).toBe(1);
    const isolated = new ProofDocument("Proofs.md", [independent]);
    expect(() => isolated.replace([independent, otherIndependent])).toThrow();
    expect(() => isolated.replace([otherIndependent])).toThrow();
    expect(isolated.code).toBe("c");
  });

  it("changes the mapping epoch for prose shifts without changing the Lean source version", () => {
    const fixture = new DocumentFixture();
    const markdown = DocumentFixture.fence("def n := 1", "session=s")
      + DocumentFixture.fence("#check n", "session=s");
    fixture.update(markdown);
    const document = fixture.documents.documents[0]!;
    const changes = fixture.update(`Intro\n${markdown}`);
    expect(changes.changed).toEqual([]);
    expect(changes.mappingChanged).toEqual([document]);
    expect(document.version).toBe(1);
    expect(document.mappingEpoch).toBe(2);
    expect(document.positionAt(fixture.blocks.blocks[1]!.id, `Intro\n${markdown}`.indexOf("#check n")))
      .toEqual({ line: 1, character: 0 });
  });

  it("updates source and mapping independently and ignores presentation-only title changes", () => {
    const fixture = new DocumentFixture();
    fixture.update(DocumentFixture.fence("def n := 1", 'session=s title="One"'));
    const document = fixture.documents.documents[0]!;
    expect(fixture.update(DocumentFixture.fence("def n := 1", 'session=s title="Two"')))
      .toEqual({ added: [], changed: [], removed: [], mappingChanged: [] });
    expect(document.mappingEpoch).toBe(1);
    expect(fixture.update(DocumentFixture.fence("def n := 2", 'session=s title="Two"')).changed)
      .toEqual([document]);
    expect(document.version).toBe(2);
    expect(document.mappingEpoch).toBe(1);
    const moved = fixture.update(DocumentFixture.fence("def n := 2", 'session=s title="Longer"'));
    expect(moved.changed).toEqual([]);
    expect(moved.mappingChanged).toEqual([document]);
    expect(document.version).toBe(2);
  });

  it("invalidates mappings for different member identities or order even with identical source", () => {
    const first = DocumentFixture.block("a\n", 10, 0, "s");
    const second = DocumentFixture.block("a\n", 20, 1, "s");
    const document = new ProofDocument("Proofs.md", [first, second], "s");
    expect(document.replace([second, first])).toEqual({ changed: false, mappingChanged: true });
    expect(document.version).toBe(1);
    expect(document.mappingEpoch).toBe(2);
    const replacement = DocumentFixture.block("a\n", 20, 1, "s");
    expect(document.replace([replacement, first])).toEqual({ changed: false, mappingChanged: true });
    expect(document.version).toBe(1);
    expect(document.mappingEpoch).toBe(3);
  });

  it("invalidates changed newline ownership even when every code character stays at the same Markdown offset", () => {
    const fixture = new DocumentFixture();
    const original = "  ```lean session=s\r\n  a\r\n b\r\n  ```\r\n";
    const edited = "  ```lean session=s\r\n  a\n  b\r\n  ```\r\n";
    fixture.update(original);
    const document = fixture.documents.documents[0]!;
    const block = fixture.blocks.blocks[0]!;
    const gap = original.indexOf("b") - 2;
    expect(document.positionAt(block.id, gap)).toEqual({ line: 0, character: 1 });
    expect(edited.indexOf("b")).toBe(original.indexOf("b"));
    const changes = fixture.update(edited);
    expect(changes.changed).toEqual([]);
    expect(changes.mappingChanged).toEqual([document]);
    expect(document.mappingEpoch).toBe(2);
    expect(document.positionAt(block.id, gap)).toEqual({ line: 1, character: 0 });
  });
});

describe("proof document source projection", () => {
  it("maps normalized CRLF, indentation, and UTF-16 positions through a shared document", () => {
    const fixture = new DocumentFixture();
    const markdown = '  ```lean session=s\r\n  #check "😀"\r\n  ```\r\n'
      + '  ```lean session=s\r\n  #check Nat\r\n  ```\r\n';
    fixture.update(markdown);
    const [first, second] = fixture.blocks.blocks;
    const document = fixture.documents.documents[0]!;
    expect(document.code).toBe('#check "😀"\n#check Nat\n');
    const firstStart = markdown.indexOf('#check "');
    const secondStart = markdown.indexOf("#check Nat");
    expect(document.positionAt(first!.id, firstStart + 10)).toEqual({ line: 0, character: 10 });
    expect(document.positionAt(second!.id, secondStart + 7)).toEqual({ line: 1, character: 7 });
    expect(document.positionAt(second!.id, firstStart)).toBeNull();
    expect(document.positionAt("unknown", firstStart)).toBeNull();
    expect(document.mapRange({ start: { line: 1, character: 7 }, end: { line: 1, character: 10 } }))
      .toEqual([{
        blockId: second!.id, from: secondStart + 7, to: secondStart + 10,
        range: { start: { line: 0, character: 7 }, end: { line: 0, character: 10 } },
      }]);
  });

  it("splits a spanning diagnostic into member-local ranges while skipping intervening Markdown", () => {
    const fixture = new DocumentFixture();
    const markdown = DocumentFixture.fence("abc", "session=s")
      + "Prose outside Lean.\n" + DocumentFixture.fence("def", "session=s");
    fixture.update(markdown);
    const [first, second] = fixture.blocks.blocks;
    const document = fixture.documents.documents[0]!;
    expect(document.mapRange({ start: { line: 0, character: 1 }, end: { line: 1, character: 2 } }))
      .toEqual([
        {
          blockId: first!.id, from: markdown.indexOf("abc") + 1, to: first!.sourceMap.to,
          range: { start: { line: 0, character: 1 }, end: { line: 1, character: 0 } },
        },
        {
          blockId: second!.id, from: markdown.indexOf("def"), to: markdown.indexOf("def") + 2,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } },
        },
      ]);
  });

  it("keeps half-open boundary ranges in the preceding block and zero-width points in the next", () => {
    const first = DocumentFixture.block("abc\n", 10, 0, "s");
    const second = DocumentFixture.block("def\n", 30, 1, "s");
    const document = new ProofDocument("Proofs.md", [first, second], "s");
    const boundary = { line: 1, character: 0 };
    expect(document.mapRange({ start: { line: 0, character: 0 }, end: boundary }))
      .toEqual([{
        blockId: first.id, from: 10, to: 14,
        range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
      }]);
    expect(document.mapRange({ start: boundary, end: boundary }))
      .toEqual([{
        blockId: second.id, from: 30, to: 30,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      }]);
  });

  it("leaves separator-only diagnostics unmapped and splits ranges across an inserted LF", () => {
    const first = DocumentFixture.block("abc", 10, 0, "s");
    const second = DocumentFixture.block("def", 30, 1, "s");
    const document = new ProofDocument("Proofs.md", [first, second], "s");
    expect(document.mapRange({ start: { line: 0, character: 3 }, end: { line: 1, character: 0 } }))
      .toEqual([]);
    expect(document.mapRange({ start: { line: 0, character: 2 }, end: { line: 1, character: 1 } }))
      .toEqual([
        {
          blockId: first.id, from: 12, to: 13,
          range: { start: { line: 0, character: 2 }, end: { line: 0, character: 3 } },
        },
        {
          blockId: second.id, from: 30, to: 31,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        },
      ]);
  });

  it("maps EOF to the final member, including an empty final block and unfinished trailing LF", () => {
    const fixture = new DocumentFixture();
    const markdown = DocumentFixture.fence("a", "session=s") + "```lean session=s\nb\n";
    fixture.update(markdown);
    const last = fixture.blocks.blocks[1]!;
    const document = fixture.documents.documents[0]!;
    expect(document.positionAt(last.id, markdown.length)).toEqual({ line: 2, character: 0 });
    const end = { line: 2, character: 0 };
    expect(document.mapRange({ start: end, end }))
      .toEqual([{
        blockId: last.id, from: markdown.length, to: markdown.length,
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } },
      }]);
    const empty = DocumentFixture.block("", 100, 2, "s");
    document.replace([...fixture.blocks.blocks, empty]);
    expect(document.mapRange({ start: end, end }))
      .toEqual([{
        blockId: empty.id, from: 100, to: 100,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      }]);
  });

  it("leaves out-of-document diagnostics unmapped instead of clamping them to a member", () => {
    const first = DocumentFixture.block("abc\n", 10, 0, "s");
    const second = DocumentFixture.block("def", 30, 1, "s");
    const document = new ProofDocument("Proofs.md", [first, second], "s");
    const valid = { line: 1, character: 1 };
    for (const invalid of [
      { line: 2, character: 0 },
      { line: 500, character: 0 },
      { line: 1, character: 4 },
      { line: 0, character: 500 },
      { line: -1, character: 0 },
      { line: 0, character: -1 },
      { line: 0.5, character: 0 },
      { line: 0, character: Number.NaN },
    ]) {
      expect(document.mapRange({ start: invalid, end: invalid })).toEqual([]);
      expect(document.mapRange({ start: valid, end: invalid })).toEqual([]);
      expect(document.mapRange({ start: invalid, end: valid })).toEqual([]);
    }
    expect(document.mapRange({ start: valid, end: { line: 0, character: 0 } })).toEqual([]);
    const eof = { line: 1, character: 3 };
    expect(document.mapRange({ start: eof, end: eof }))
      .toEqual([{
        blockId: second.id, from: 33, to: 33,
        range: { start: { line: 0, character: 3 }, end: { line: 0, character: 3 } },
      }]);
  });
});
