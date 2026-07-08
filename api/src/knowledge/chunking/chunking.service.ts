import { Injectable } from '@nestjs/common';

export interface Chunk {
  ordinal: number;
  text: string;
  section?: string;
  tokenCount: number;
}

export interface ChunkOptions {
  /** Target maximum tokens per chunk. */
  maxTokens?: number;
  /** Overlap (in tokens) carried from the previous chunk. */
  overlapTokens?: number;
}

const DEFAULT_MAX = 400;
const DEFAULT_OVERLAP = 48;

/** Rough token estimate: whitespace-delimited words (~1 token/word for NL/EN). */
function countTokens(text: string): number {
  const m = text.trim().match(/\S+/g);
  return m ? m.length : 0;
}

/**
 * Structure-aware chunker. Splits text on blank lines (paragraphs / headings),
 * then greedily packs paragraphs into chunks up to maxTokens, carrying a small
 * word overlap between consecutive chunks so context isn't cut mid-thought.
 * A single oversized paragraph is hard-split by words.
 */
@Injectable()
export class ChunkingService {
  chunk(text: string, options: ChunkOptions = {}): Chunk[] {
    const maxTokens = options.maxTokens ?? DEFAULT_MAX;
    const overlap = Math.min(
      options.overlapTokens ?? DEFAULT_OVERLAP,
      maxTokens - 1,
    );

    const paragraphs = text
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    // Break paragraphs larger than maxTokens into word-windows up front.
    const units: string[] = [];
    for (const p of paragraphs) {
      if (countTokens(p) <= maxTokens) {
        units.push(p);
        continue;
      }
      const words = p.match(/\S+/g) ?? [];
      for (let i = 0; i < words.length; i += maxTokens) {
        units.push(words.slice(i, i + maxTokens).join(' '));
      }
    }

    const chunks: Chunk[] = [];
    let current: string[] = [];
    let currentTokens = 0;

    const flush = (): void => {
      if (current.length === 0) return;
      const chunkText = current.join('\n\n');
      chunks.push({
        ordinal: chunks.length,
        text: chunkText,
        tokenCount: countTokens(chunkText),
      });
    };

    for (const unit of units) {
      const unitTokens = countTokens(unit);
      if (currentTokens + unitTokens > maxTokens && current.length > 0) {
        flush();
        // Seed the next chunk with the tail of the previous one for overlap.
        const prevWords = current.join(' ').match(/\S+/g) ?? [];
        const tail = prevWords.slice(Math.max(0, prevWords.length - overlap));
        current = tail.length > 0 ? [tail.join(' ')] : [];
        currentTokens = tail.length;
      }
      current.push(unit);
      currentTokens += unitTokens;
    }
    flush();

    return chunks;
  }
}
