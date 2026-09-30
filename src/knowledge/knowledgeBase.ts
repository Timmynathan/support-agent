import { readFileSync } from 'node:fs';
import { fromRoot } from '../shared/paths.js';

export interface KnowledgeChunk {
  id: string;
  title: string;
  section: string;
  text: string;
  summary: string;
}

const KNOWLEDGE_BASE_PATH = fromRoot('assets', 'relaypay-knowledge-base.md');

// One chunk per "###" heading, plus any prose that sits directly under a "##" heading.
// The KB is written as short, self-contained Q&A and policy blocks, so a heading is the natural
// unit: a chunk never mixes two policies, and its id stays stable while the file is unchanged.
export function loadKnowledgeBase(path = KNOWLEDGE_BASE_PATH): KnowledgeChunk[] {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const chunks: KnowledgeChunk[] = [];
  let section = '';
  let heading: string | null = null;
  let body: string[] = [];

  const flush = () => {
    const text = body.join('\n').trim();
    if (text && section) {
      const title = heading ?? section;
      chunks.push({
        id: `kb-${slug(section)}${heading ? `--${slug(heading)}` : ''}`,
        title: heading ? `${section} › ${heading}` : section,
        section,
        text: `${title}\n${text}`,
        summary: firstSentence(text),
      });
    }
    body = [];
  };

  for (const line of lines) {
    if (line.startsWith('## ')) {
      flush();
      section = line.slice(3).trim();
      heading = null;
    } else if (line.startsWith('### ')) {
      flush();
      heading = line.slice(4).trim();
    } else if (section) {
      body.push(line);
    }
  }
  flush();
  return chunks;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const end = flat.search(/[.!?](\s|$)/);
  return end === -1 ? flat.slice(0, 200) : flat.slice(0, end + 1);
}
