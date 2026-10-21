import { ParsedProofBlock } from "./ProofBlock";
import { SourceLine, SourceMap } from "./SourceMap";
import { FenceMetadata } from "./FenceMetadata";

interface MarkdownLine {
  readonly from: number;
  readonly to: number;
  readonly text: string;
  readonly newline: boolean;
}

/** Recognizes top-level CommonMark fences, including non-Lean fences to skip. */
export class MarkdownBlockParser {
  parse(markdown: string): readonly ParsedProofBlock[] {
    const lines = this.readLines(markdown);
    const blocks: ParsedProofBlock[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const opening = lines[index]!;
      const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(opening.text);
      if (!match) continue;
      const fence = match[2]!;
      const info = match[3]!.trim();
      if (fence[0] === "`" && info.includes("`")) continue;
      const metadata = FenceMetadata.parse(info);
      const isLean = metadata !== null;
      const content: string[] = [];
      const mapping: SourceLine[] = [];
      let closing: MarkdownLine | undefined;
      let cursor = index + 1;
      for (; cursor < lines.length; cursor += 1) {
        const line = lines[cursor]!;
        if (this.closes(line.text, fence)) {
          closing = line;
          break;
        }
        if (isLean) {
          const indentation = this.contentIndentation(line.text, match[1]!.length);
          const text = line.text.slice(indentation);
          content.push(text + (line.newline ? "\n" : ""));
          mapping.push({
            sourceStart: line.from,
            contentStart: line.from + indentation,
            length: text.length,
          });
        }
      }
      if (isLean) {
        const codeFrom = opening.to;
        const codeTo = closing?.from ?? markdown.length;
        if (!closing && content.at(-1)?.endsWith("\n")) {
          mapping.push({ sourceStart: codeTo, contentStart: codeTo, length: 0 });
        }
        blocks.push({
          code: content.join(""),
          language: metadata!.language,
          info: metadata!.info,
          title: metadata!.title,
          metadataError: metadata!.error,
          session: metadata!.session,
          displayOnly: metadata!.displayOnly,
          from: opening.from,
          to: closing?.to ?? markdown.length,
          closingFenceFrom: closing?.from ?? null,
          sourceMap: new SourceMap(codeFrom, codeTo, mapping, !closing),
        });
      }
      index = cursor;
    }
    return blocks;
  }

  private readLines(markdown: string): readonly MarkdownLine[] {
    const lines: MarkdownLine[] = [];
    let from = 0;
    while (from < markdown.length) {
      const newlineAt = markdown.indexOf("\n", from);
      const to = newlineAt < 0 ? markdown.length : newlineAt + 1;
      const textEnd = newlineAt < 0 ? to : newlineAt;
      const normalizedEnd = markdown[textEnd - 1] === "\r" ? textEnd - 1 : textEnd;
      lines.push({ from, to, text: markdown.slice(from, normalizedEnd), newline: newlineAt >= 0 });
      from = to;
    }
    return lines;
  }

  private closes(line: string, opening: string): boolean {
    const match = /^( {0,3})(`+|~+)[ \t]*$/.exec(line);
    return !!match && match[2]![0] === opening[0] && match[2]!.length >= opening.length;
  }

  private contentIndentation(text: string, maximum: number): number {
    let count = 0;
    while (count < maximum && text[count] === " ") count += 1;
    return count;
  }
}
