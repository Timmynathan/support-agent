import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AGENT_MODEL } from '../agent/session.js';
import { routeVoice } from '../voice/vapiRoutes.js';
import { endAll } from './registry.js';
import { handleError, HttpError } from './httpUtil.js';
import { routeText } from './textRoutes.js';

// Two listeners:
//   TEXT  (loopback only, always): the unauthenticated test channel. Never exposed, even when
//         deployed — reachable only from a shell on the same machine.
//   VOICE: serves only the widget and the signature-checked Vapi routes, so exposing it can't
//         expose /chat. Loopback in development (a tunnel connects to it locally); in a
//         deployment VOICE_HOST=0.0.0.0 and the host's PORT.
const TEXT_HOST = '127.0.0.1';
const TEXT_PORT = Number(process.env.TEXT_PORT ?? 8787);
const VOICE_HOST = process.env.VOICE_HOST ?? '127.0.0.1';
// Hosting platforms (Railway, Cloud Run) assign the public port through PORT.
const VOICE_PORT = Number(process.env.VOICE_PORT ?? process.env.PORT ?? 8788);

type Router = (req: IncomingMessage, res: ServerResponse) => Promise<void> | null;

function listen(name: string, host: string, port: number, router: Router): void {
  const server = createServer((req, res) => {
    const route = `${req.method} ${req.url}`;
    // A handler that throws before returning its promise must fail this request, not the
    // process: an uncaught throw here once took the whole server down on a missing variable.
    let handled: Promise<void>;
    try {
      handled = router(req, res) ?? Promise.reject(new HttpError(404, 'not found'));
    } catch (error) {
      handled = Promise.reject(error);
    }
    handled.catch((error: unknown) => handleError(route, res, error));
  });
  server.listen(port, host, () => process.stdout.write(`${name} listening on http://${host}:${port}\n`));
}

listen('text channel', TEXT_HOST, TEXT_PORT, routeText);
listen('voice channel', VOICE_HOST, VOICE_PORT, routeVoice);
process.stdout.write(`agent model ${AGENT_MODEL}\n`);

async function shutdown(): Promise<void> {
  await endAll('server_shutdown');
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
