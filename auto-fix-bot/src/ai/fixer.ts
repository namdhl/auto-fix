import OpenAI from 'openai';
import { z } from 'zod';
import type { ParsedError } from '../parsers/index.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const FixSchema = z.object({
  reasoning: z.string(),
  confidence: z.enum(['low', 'medium', 'high']),
  patches: z.array(
    z.object({
      file: z.string(),
      // Full file mới — đơn giản hơn diff, dễ validate hơn.
      // Trade-off: tốn token với file lớn.
      newContent: z.string(),
    })
  ),
});

export type Fix = z.infer<typeof FixSchema>;

const SYSTEM_PROMPT = `You are an automated code-fix assistant. You receive:
1. A failing CI error log
2. The current content of the file(s) involved

Your task: produce the MINIMAL fix that resolves the error.

Hard rules:
- DO NOT modify business logic to make tests pass. Fix root cause only.
- DO NOT delete or weaken tests/assertions.
- DO NOT add empty try/catch to swallow errors.
- DO NOT modify dependencies (package.json, requirements.txt, etc.).
- If the fix requires changing more than ~50 lines, set confidence='low'.
- If you're not sure what's wrong, set confidence='low' and explain.

Return JSON ONLY, matching this schema:
{
  "reasoning": "brief explanation of root cause and fix",
  "confidence": "low" | "medium" | "high",
  "patches": [
    { "file": "relative/path.ts", "newContent": "<full new file content>" }
  ]
}`;

export async function generateFix(
  errors: ParsedError[],
  fileContents: Record<string, string>
): Promise<Fix> {
  const userMessage = [
    '## Failing errors:',
    errors
      .map(
        (e, i) =>
          `### Error ${i + 1}\nFile: ${e.file ?? 'unknown'}:${e.line ?? '?'}\nType: ${e.errorType}\nMessage: ${e.message}\n\nLog snippet:\n\`\`\`\n${e.rawSnippet}\n\`\`\``
      )
      .join('\n\n'),
    '',
    '## Current file contents:',
    Object.entries(fileContents)
      .map(([path, content]) => `### ${path}\n\`\`\`\n${content}\n\`\`\``)
      .join('\n\n'),
  ].join('\n');

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    response_format: { type: 'json_object' },
    temperature: 0.1,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
  });

  const raw = response.choices[0]?.message.content ?? '{}';
  const parsed = FixSchema.parse(JSON.parse(raw));
  return parsed;
}
