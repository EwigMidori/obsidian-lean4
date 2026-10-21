import { ProofBlock } from "./ProofBlock";
import { ProofDocument } from "./ProofDocument";

export interface DocumentCatalogChange {
  readonly added: readonly ProofDocument[];
  readonly changed: readonly ProofDocument[];
  readonly removed: readonly ProofDocument[];
  readonly mappingChanged: readonly ProofDocument[];
}

/** Groups explicitly shared blocks within one note while keeping other blocks isolated. */
export class DocumentCatalog {
  private current: readonly ProofDocument[] = [];
  private groups = new Map<string, ProofDocument>();
  private byBlock = new Map<string, ProofDocument>();

  constructor(readonly noteId: string) {}

  get documents(): readonly ProofDocument[] { return this.current; }

  documentFor(blockId: string): ProofDocument | undefined {
    return this.byBlock.get(blockId);
  }

  update(blocks: readonly ProofBlock[]): DocumentCatalogChange {
    const members = new Map<string, ProofBlock[]>();
    const ordered = blocks
      .filter((block) => block.noteId === this.noteId && !block.displayOnly)
      .slice()
      .sort((left, right) => left.ordinal - right.ordinal);
    for (const block of ordered) {
      const key = this.keyFor(block);
      const group = members.get(key) ?? [];
      group.push(block);
      members.set(key, group);
    }
    const groups = new Map<string, ProofDocument>();
    const byBlock = new Map<string, ProofDocument>();
    const added: ProofDocument[] = [];
    const changed: ProofDocument[] = [];
    const mappingChanged: ProofDocument[] = [];
    for (const [key, group] of members) {
      const previous = this.groups.get(key);
      const document = previous ?? new ProofDocument(this.noteId, group, group[0]!.session);
      if (previous) {
        const change = previous.replace(group);
        if (change.changed) changed.push(previous);
        if (change.mappingChanged) mappingChanged.push(previous);
      } else {
        added.push(document);
      }
      groups.set(key, document);
      for (const block of group) byBlock.set(block.id, document);
    }
    const removed = [...this.groups.entries()]
      .filter(([key]) => !groups.has(key))
      .map(([, document]) => document);
    this.groups = groups;
    this.byBlock = byBlock;
    this.current = [...groups.values()];
    return { added, changed, removed, mappingChanged };
  }

  private keyFor(block: ProofBlock): string {
    return block.session ? `session:${block.session}` : `block:${block.id}`;
  }
}
