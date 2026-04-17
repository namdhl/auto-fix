// Parse log thành structured errors. Mỗi language/framework có pattern riêng.
// Đây là implementation tối thiểu — bạn nên mở rộng dần theo dữ liệu thực tế.

export interface ParsedError {
  language: 'node' | 'python' | 'go' | 'unknown';
  errorType: string;       // e.g. "TypeError", "SyntaxError", "ImportError"
  message: string;
  file?: string;           // relative path
  line?: number;
  column?: number;
  rawSnippet: string;      // Đoạn log gốc, gửi cho LLM làm context
}

const PATTERNS = [
  // Node/TS: "src/foo.ts:12:5 - error TS2304: Cannot find name 'bar'."
  {
    lang: 'node' as const,
    re: /(?<file>[\w./-]+\.(?:ts|tsx|js|jsx)):(?<line>\d+):(?<col>\d+)\s*-?\s*error\s+(?<type>\w+):\s*(?<msg>.+)/,
  },
  // Jest: "FAIL src/foo.test.ts" + stack "at ... (src/foo.ts:12:5)"
  {
    lang: 'node' as const,
    re: /at\s+.+\((?<file>[\w./-]+\.(?:ts|js)):(?<line>\d+):(?<col>\d+)\)/,
  },
  // Python: 'File "foo.py", line 12, in <module>'
  {
    lang: 'python' as const,
    re: /File\s+"(?<file>[^"]+\.py)",\s+line\s+(?<line>\d+).*?\n\s*(?<type>\w+Error):\s*(?<msg>.+)/s,
  },
  // Go: "./foo.go:12:5: undefined: bar"
  {
    lang: 'go' as const,
    re: /(?<file>[\w./-]+\.go):(?<line>\d+):(?<col>\d+):\s*(?<msg>.+)/,
  },
];

export function parseErrors(log: string): ParsedError[] {
  const errors: ParsedError[] = [];
  const seen = new Set<string>();

  for (const { lang, re } of PATTERNS) {
    const globalRe = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let match: RegExpExecArray | null;
    while ((match = globalRe.exec(log)) !== null) {
      const g = match.groups ?? {};
      const key = `${g.file}:${g.line}:${g.msg ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Lấy ±10 dòng quanh match làm snippet
      const start = Math.max(0, match.index - 500);
      const end = Math.min(log.length, match.index + 500);

      errors.push({
        language: lang,
        errorType: g.type ?? 'Error',
        message: g.msg ?? match[0],
        file: g.file,
        line: g.line ? Number(g.line) : undefined,
        column: g.col ? Number(g.col) : undefined,
        rawSnippet: log.slice(start, end),
      });
    }
  }

  return errors;
}
