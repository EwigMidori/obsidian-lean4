import { describe, expect, it } from "vitest";
import { BlockCatalog } from "../../src/domain/BlockCatalog";
import { MarkdownBlockParser } from "../../src/domain/MarkdownBlockParser";

describe("independent Markdown proof blocks", () => {
  it("keeps identical declarations as separate documents and ignores other fenced languages", () => {
    const catalog = new BlockCatalog("Proofs.md");
    catalog.update([
      "```lean", "def n := 1", "```",
      "```lean4", "def n := 1", "```",
      "````markdown", "```lean", "def hidden := 1", "```", "````",
      "```lean-example", "this is deliberately incomplete", "```",
      "~~~lean-off", "#check ?", "~~~",
    ].join("\n"));
    expect(catalog.blocks).toHaveLength(4);
    expect(new Set(catalog.blocks.map((block) => block.id)).size).toBe(4);
    expect(catalog.blocks[0]!.code).toBe("def n := 1\n");
    expect(catalog.blocks.map((block) => block.displayOnly)).toEqual([false, false, true, true]);
  });

  it("preserves repeated block identity and code versions across a prose insertion", () => {
    const catalog = new BlockCatalog("Proofs.md");
    const text = "Intro\n```lean\n#check Nat\n```\nBetween\n```lean\n#check Nat\n```\n";
    catalog.update(text);
    const before = catalog.blocks.map((block) => ({ id: block.id, from: block.from, version: block.version }));
    const change = catalog.update(`New paragraph.\n${text}`);
    expect(change.added).toHaveLength(0);
    expect(change.changed).toHaveLength(0);
    expect(change.removed).toHaveLength(0);
    expect(catalog.blocks.map((block) => block.id)).toEqual(before.map((block) => block.id));
    expect(catalog.blocks.map((block) => block.version)).toEqual([1, 1]);
    expect(catalog.blocks[0]!.from).toBe(before[0]!.from + "New paragraph.\n".length);
  });

  it("increments only the edited code block version", () => {
    const catalog = new BlockCatalog("Proofs.md");
    catalog.update("```lean\ndef n := 1\n```\n```lean\ndef n := 1\n```\n");
    const ids = catalog.blocks.map((block) => block.id);
    const changes = catalog.update("```lean\ndef n := 2\n```\n```lean\ndef n := 1\n```\n");
    expect(changes.changed.map((block) => block.id)).toEqual([ids[0]]);
    expect(catalog.blocks.map((block) => block.version)).toEqual([2, 1]);
  });

  it("maps indentation, CRLF and UTF-16 positions back to the Markdown source", () => {
    const text = "说明\r\n  ```lean\r\n  #check \"😀\"\r\n  #check Nat\r\n  ```\r\n";
    const block = new MarkdownBlockParser().parse(text)[0]!;
    expect(block.code).toBe('#check "😀"\n#check Nat\n');
    const start = text.indexOf("#check Nat");
    expect(block.sourceMap.positionAt(start + 7)).toEqual({ line: 1, character: 7 });
    expect(block.sourceMap.offsetAt({ line: 1, character: 7 })).toBe(start + 7);
    expect(block.sourceMap.offsetAt({ line: 0, character: 10 })).toBe(text.indexOf('#check "') + 10);
    expect(block.sourceMap.offsetAt({ line: 300, character: 0 })).toBe(block.sourceMap.to);
    expect(block.sourceMap.positionAt(block.closingFenceFrom!)).toBeNull();
  });

  it("accepts an unfinished top-level fence and does not close it with a shorter fence", () => {
    const parsed = new MarkdownBlockParser().parse("````lean\n#check Nat\n```\n#check Bool");
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.code).toBe("#check Nat\n```\n#check Bool");
    expect(parsed[0]!.closingFenceFrom).toBeNull();
  });

  it("includes the final cursor position of an unfinished fence, including its trailing newline", () => {
    const catalog = new BlockCatalog("Draft.md");
    const text = "```lean\nexample : True := by\n  trivial";
    catalog.update(text);
    expect(catalog.blockAt(text.length)?.sourceMap.positionAt(text.length)).toEqual({ line: 1, character: 9 });
    catalog.update(text + "\n");
    expect(catalog.blockAt(text.length + 1)?.sourceMap.positionAt(text.length + 1)).toEqual({ line: 2, character: 0 });
    catalog.update(text + "\r\n");
    expect(catalog.blockAt(text.length + 2)?.sourceMap.positionAt(text.length + 2)).toEqual({ line: 2, character: 0 });
    catalog.update("```lean\n```\n");
    expect(catalog.blockAt("```lean\n".length)).toBeUndefined();
  });
});
