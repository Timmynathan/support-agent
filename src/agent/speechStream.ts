// Incrementally parses the turn's structured output as the model streams it, so the voice path
// can decide WHETHER to speak (from answer_type and citations, which the schema orders first)
// and then speak spoken_text while it is still being generated.

export interface TurnMeta {
  answer_type: string;
  cited_chunk_ids: string[];
}

type State = 'prefix' | 'text' | 'done';

export class StructuredSpeechParser {
  private buffer = '';
  private state: State = 'prefix';
  private textStart = 0;
  private cursor = 0;
  meta: TurnMeta | null = null;

  constructor(
    private readonly onMeta: (meta: TurnMeta | null) => void,
    private readonly onText: (text: string) => void,
  ) {}

  feed(chunk: string): void {
    this.buffer += chunk;
    if (this.state === 'prefix') this.tryEnterText();
    if (this.state === 'text') this.drainText();
  }

  private tryEnterText(): void {
    const match = /"spoken_text"\s*:\s*"/.exec(this.buffer);
    if (!match) return;
    const prefix = this.buffer.slice(0, match.index);
    this.meta = parseMeta(prefix);
    this.onMeta(this.meta);
    this.state = 'text';
    this.textStart = match.index + match[0].length;
    this.cursor = this.textStart;
  }

  // Decodes JSON string content up to the closing quote. An escape split across chunks is left
  // in the buffer until the rest of it arrives.
  private drainText(): void {
    let out = '';
    while (this.cursor < this.buffer.length) {
      const ch = this.buffer[this.cursor]!;
      if (ch === '"') {
        this.state = 'done';
        this.cursor++;
        break;
      }
      if (ch !== '\\') {
        out += ch;
        this.cursor++;
        continue;
      }
      const next = this.buffer[this.cursor + 1];
      if (next === undefined) break;
      if (next === 'u') {
        const hex = this.buffer.slice(this.cursor + 2, this.cursor + 6);
        if (hex.length < 4) break;
        out += String.fromCharCode(parseInt(hex, 16));
        this.cursor += 6;
        continue;
      }
      out += ESCAPES[next] ?? next;
      this.cursor += 2;
    }
    if (out) this.onText(out);
  }
}

const ESCAPES: Record<string, string> = { n: ' ', t: ' ', r: '', b: '', f: '', '"': '"', '\\': '\\', '/': '/' };

// Only trusted when both fields arrived before spoken_text; otherwise null, and the caller
// must wait for the complete output before speaking anything.
function parseMeta(prefix: string): TurnMeta | null {
  const answerType = /"answer_type"\s*:\s*"([a-z_]+)"/.exec(prefix)?.[1];
  const cited = /"cited_chunk_ids"\s*:\s*(\[[^\]]*\])/.exec(prefix)?.[1];
  if (!answerType || cited === undefined) return null;
  try {
    const ids: unknown = JSON.parse(cited);
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) return null;
    return { answer_type: answerType, cited_chunk_ids: ids };
  } catch {
    return null;
  }
}
