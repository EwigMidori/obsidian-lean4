interface FenceOption {
  readonly key: string;
  readonly value: string;
  readonly next: number;
}

/** Owns fenced-block presentation and the explicit permission to check its code. */
export class FenceMetadata {
  private constructor(
    readonly info: string,
    readonly language: string,
    readonly displayOnly: boolean,
    readonly title?: string,
    readonly error?: string,
    readonly session?: string,
  ) {}

  static parse(info: string): FenceMetadata | null {
    const languageMatch = /^\s*(\S+)/.exec(info);
    if (!languageMatch) return null;
    const language = languageMatch[1]!.toLowerCase();
    if (!["lean", "lean4", "lean-example", "lean-off"].includes(language)) return null;
    const legacyDisplay = language === "lean-example" || language === "lean-off";
    let check = legacyDisplay ? "off" : "on";
    let title: string | undefined;
    let session: string | undefined;
    let cursor = languageMatch[0].length;
    const seen = new Set<string>();
    try {
      while (cursor < info.length) {
        while (cursor < info.length && /\s/.test(info[cursor]!)) cursor += 1;
        if (cursor >= info.length) break;
        const option = FenceMetadata.readOption(info, cursor);
        cursor = option.next;
        if (seen.has(option.key)) throw new Error(`围栏选项 ${option.key} 重复；请只声明一次。`);
        seen.add(option.key);
        if (option.key === "check") {
          if (option.value !== "on" && option.value !== "off") {
            throw new Error(`无法识别 check=${option.value || '""'}；请使用 check=on 或 check=off。`);
          }
          if (legacyDisplay && option.value === "on") {
            throw new Error(`${language} 仅用于展示；如需检查，请改用 lean check=on。`);
          }
          check = option.value;
        } else if (option.key === "title") {
          title = option.value;
        } else if (option.key === "session") {
          if (!option.value.trim() || /[\u0000-\u001f\u007f]/.test(option.value)) {
            throw new Error("session 名称不能为空、全为空白或包含控制字符。");
          }
          session = option.value;
        } else {
          throw new Error(`无法识别围栏选项 ${option.key}；仅支持 check、title 和 session。`);
        }
      }
      return new FenceMetadata(info.trim(), language, check === "off", title, undefined, session);
    } catch (error) {
      const message = error instanceof Error ? error.message : "围栏元数据格式无效。";
      return new FenceMetadata(info.trim(), language, true, title, message, session);
    }
  }

  private static readOption(info: string, from: number): FenceOption {
    let cursor = from;
    while (cursor < info.length && !/[\s=]/.test(info[cursor]!)) cursor += 1;
    const key = info.slice(from, cursor);
    if (!key || info[cursor] !== "=") {
      throw new Error(`围栏选项 ${key || info[from]} 缺少 =；例如 check=off 或 title="自然数示例"。`);
    }
    cursor += 1;
    const quote = info[cursor] === '"' || info[cursor] === "'" ? info[cursor++] : undefined;
    let value = "";
    if (quote) {
      let closed = false;
      while (cursor < info.length) {
        const character = info[cursor++]!;
        if (character === quote) {
          closed = true;
          break;
        }
        if (character === "\\") {
          if (cursor >= info.length) throw new Error(`围栏选项 ${key} 的转义字符不完整。`);
          const escaped = info[cursor++]!;
          value += FenceMetadata.unescape(escaped);
        } else {
          value += character;
        }
      }
      if (!closed) throw new Error(`围栏选项 ${key} 的引号未闭合。`);
      if (cursor < info.length && !/\s/.test(info[cursor]!)) {
        throw new Error(`围栏选项 ${key} 后需要空格分隔。`);
      }
    } else {
      const valueFrom = cursor;
      while (cursor < info.length && !/\s/.test(info[cursor]!)) cursor += 1;
      value = info.slice(valueFrom, cursor);
      if (/["']/.test(value)) throw new Error(`围栏选项 ${key} 的引号位置无效。`);
    }
    return { key, value, next: cursor };
  }

  private static unescape(character: string): string {
    if (character === "n") return "\n";
    if (character === "r") return "\r";
    if (character === "t") return "\t";
    if (character === "\\" || character === '"' || character === "'") return character;
    return `\\${character}`;
  }
}
