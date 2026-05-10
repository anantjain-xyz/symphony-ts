import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

/**
 * Read just the first line of a file without loading the rest into memory.
 * Returns `null` for empty files. The underlying stream is destroyed as soon
 * as the first line is yielded, so file size has no effect on memory or time.
 */
export async function readFirstLine(filePath: string): Promise<string | null> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      return line;
    }
    return null;
  } finally {
    rl.close();
    stream.destroy();
  }
}
