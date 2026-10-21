import { describe, expect, it } from "vitest";
import { FenceMetadata } from "../../src/domain/FenceMetadata";
import { BlockCatalog } from "../../src/domain/BlockCatalog";

describe("Lean fence metadata", () => {
  it("defaults lean and lean4 to checking while preserving display-only language aliases", () => {
    expect(FenceMetadata.parse("lean")?.displayOnly).toBe(false);
    expect(FenceMetadata.parse("lean4")?.displayOnly).toBe(false);
    expect(FenceMetadata.parse("lean-off")?.displayOnly).toBe(true);
    expect(FenceMetadata.parse("lean-example")?.displayOnly).toBe(true);
    expect(FenceMetadata.parse("javascript")).toBeNull();
  });

  it("reads quoted titles with spaces, Unicode, and escaped quotes and backslashes", () => {
    const metadata = FenceMetadata.parse('lean4 check=off title="自然数 示例 \\"A\\" \\\\ 证明"');
    expect(metadata?.displayOnly).toBe(true);
    expect(metadata?.title).toBe('自然数 示例 "A" \\ 证明');
    expect(metadata?.error).toBeUndefined();
    expect(FenceMetadata.parse("lean title='自然数 示例' check=on")?.title).toBe("自然数 示例");
    expect(FenceMetadata.parse('lean title=""')?.title).toBe("");
    expect(FenceMetadata.parse('lean title="\\alpha"')?.title).toBe("\\alpha");
  });

  it("retains an explicit session name exactly, independently of its checking policy", () => {
    expect(FenceMetadata.parse('lean session="自然数 示例"')?.session).toBe("自然数 示例");
    expect(FenceMetadata.parse("lean4 session=Arithmetic check=off")?.session).toBe("Arithmetic");
    expect(FenceMetadata.parse('lean session=" A " title="标题"')?.session).toBe(" A ");
    expect(FenceMetadata.parse("lean")?.session).toBeUndefined();
  });

  it.each([
    "lean check=unknown",
    "lean check=",
    "lean check=OFF",
    "lean check=on check=off",
    "lean chekc=off",
    "lean check",
    'lean check="on',
    'lean title="demo"check=off',
    'lean title="one" title="two"',
    "lean-off check=on",
    "lean-example check=on",
    "lean session=",
    'lean session=""',
    'lean session="   "',
    'lean session="a\\nb"',
    'lean session="a\\tb"',
    "lean session=one session=two",
  ])("refuses to run malformed or contradictory metadata: %s", (info) => {
    const metadata = FenceMetadata.parse(info);
    expect(metadata?.displayOnly).toBe(true);
    expect(metadata?.error).toBeTruthy();
  });

  it("changes presentation without changing Lean identity or version", () => {
    const catalog = new BlockCatalog("Proof.md");
    catalog.update('```lean title="原标题"\n#check Nat\n```\n');
    const id = catalog.blocks[0]!.id;
    const changes = catalog.update('```lean title="修改后的 标题"\n#check Nat\n```\n');
    expect(changes.changed).toEqual([]);
    expect(catalog.blocks[0]!.id).toBe(id);
    expect(catalog.blocks[0]!.version).toBe(1);
    expect(catalog.blocks[0]!.title).toBe("修改后的 标题");
    catalog.update('```lean check=off title="修改后的 标题"\n#check Nat\n```\n');
    expect(catalog.blocks[0]!.version).toBe(2);
    expect(catalog.blocks[0]!.displayOnly).toBe(true);
    catalog.update('```lean check=on title="修改后的 标题"\n#check Nat\n```\n');
    expect(catalog.blocks[0]!.version).toBe(3);
    expect(catalog.blocks[0]!.displayOnly).toBe(false);
  });
});
