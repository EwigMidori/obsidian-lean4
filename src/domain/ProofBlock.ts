import { SourceMap } from "./SourceMap";

export interface ParsedProofBlock {
  readonly code: string;
  readonly language: string;
  readonly info: string;
  readonly title?: string;
  readonly metadataError?: string;
  readonly session?: string;
  readonly displayOnly: boolean;
  readonly from: number;
  readonly to: number;
  readonly closingFenceFrom: number | null;
  readonly sourceMap: SourceMap;
}

/** One Markdown proof fragment. Its own version tracks code and checking-policy changes. */
export class ProofBlock {
  private static nextId = 1;
  readonly id = `proof-block-${ProofBlock.nextId++}`;
  private revision = 1;

  constructor(
    readonly noteId: string,
    private parsed: ParsedProofBlock,
    private index: number,
  ) {}

  get version(): number { return this.revision; }
  get ordinal(): number { return this.index; }
  get code(): string { return this.parsed.code; }
  get language(): string { return this.parsed.language; }
  get info(): string { return this.parsed.info; }
  get title(): string | undefined { return this.parsed.title; }
  get metadataError(): string | undefined { return this.parsed.metadataError; }
  get session(): string | undefined { return this.parsed.session; }
  get displayOnly(): boolean { return this.parsed.displayOnly; }
  get from(): number { return this.parsed.from; }
  get to(): number { return this.parsed.to; }
  get closingFenceFrom(): number | null { return this.parsed.closingFenceFrom; }
  get sourceMap(): SourceMap { return this.parsed.sourceMap; }

  replace(parsed: ParsedProofBlock, ordinal: number): boolean {
    const changed = this.code !== parsed.code || this.displayOnly !== parsed.displayOnly;
    if (changed) this.revision += 1;
    this.parsed = parsed;
    this.index = ordinal;
    return changed;
  }
}
