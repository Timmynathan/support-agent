import type { IncomingMessage, ServerResponse } from 'node:http';

const MAX_BODY_BYTES = 256 * 1024;

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

// The raw bytes are kept because signature checks must run over exactly what was sent.
export async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0;
  const parts: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'request body too large');
    parts.push(chunk as Buffer);
  }
  return Buffer.concat(parts).toString('utf8');
}

export function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const body: unknown = JSON.parse(raw || '{}');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
    return body as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'body must be a JSON object');
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body, null, 2));
}

export function handleError(route: string, res: ServerResponse, error: unknown): void {
  // The other side went away mid-request (Vapi cancels a turn when the caller keeps talking).
  // Nothing failed on our side and there is nobody left to answer.
  if (error instanceof Error && (error.message === 'aborted' || (error as NodeJS.ErrnoException).code === 'ECONNRESET')) {
    process.stderr.write(`${route}: client closed the request before it completed\n`);
    return;
  }
  const status = error instanceof HttpError ? error.status : 500;
  // Internal detail goes to the server log, never to the response.
  if (status === 500) process.stderr.write(`${route} failed: ${error instanceof Error ? error.stack : String(error)}\n`);
  if (res.headersSent) {
    res.end();
    return;
  }
  sendJson(res, status, { error: status === 500 ? 'internal error' : (error as Error).message });
}
