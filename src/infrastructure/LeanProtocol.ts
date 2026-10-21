import type {
  LeanDiagnostic,
  TextPosition,
  TextRange,
} from "../application/contracts";

/** Owns validation at the untrusted JSON-RPC boundary. */
export class LeanProtocol {
  static record(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  }

  static position(value: unknown): TextPosition | undefined {
    const record = this.record(value);
    if (
      !record ||
      !Number.isInteger(record.line) ||
      !Number.isInteger(record.character) ||
      (record.line as number) < 0 ||
      (record.character as number) < 0
    ) return undefined;
    return { line: record.line as number, character: record.character as number };
  }

  static range(value: unknown): TextRange | undefined {
    const record = this.record(value);
    const start = this.position(record?.start);
    const end = this.position(record?.end);
    return start && end ? { start, end } : undefined;
  }

  static version(value: unknown): number | null {
    return Number.isInteger(value) && (value as number) >= 0 ? value as number : null;
  }

  static diagnostics(value: unknown): readonly LeanDiagnostic[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const diagnostics: LeanDiagnostic[] = [];
    for (const item of value) {
      const record = this.record(item);
      const range = this.range(record?.range);
      if (!record || !range || typeof record.message !== "string") continue;
      diagnostics.push({
        range,
        message: record.message,
        severity: record.severity === 2 ? "warning"
          : record.severity === 3 ? "information"
          : record.severity === 4 ? "hint" : "error",
      });
    }
    return diagnostics;
  }

  static message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
