import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AGENT_MODEL } from '../agent/session.js';
import { routeVoice } from '../voice/vapiRoutes.js';
import { endAll } from './registry.js';
import { handleError, HttpError } from './httpUtil.js';
import { routeText } from './textRoutes.js';

// Two listeners, both on loopback:
//   TEXT  (8787): the unauthenticated test channel. Never tunnelled.
//   VOICE (8788): the tunnel target. Serves only the widget and the signature-checked Vapi routes,
//                 so exposing it can't expose /chat.
const HOST = '127.0.0.1';
const TEXT_PORT = Number(process.env.PORT ?? 8787);
const VOICE_PORT = Number(process.env.VOICE_PORT ?? 8788);

type Router = (req: IncomingMessage, res: ServerResponse) => Promise<void> | null;

function listen(name: string, port: number, router: Router): void {
  const server = createServer((req, res) => {
    const route = `${req.method} ${req.url}`;
    const handled = router(req, res) ?? Promise.reject(new HttpError(404, 'not found'));
    handled.catch((error: unknown) => handleError(route, res, error));
  });
  server.listen(port, HOST, () => process.stdout.write(`${name} listening on http://${HOST}:${port}\n`));
}

listen('text channel', TEXT_PORT, routeText);
listen('voice channel', VOICE_PORT, routeVoice);
process.stdout.write(`agent model ${AGENT_MODEL}\n`);

async function shutdown(): Promise<void> {
  await endAll('server_shutdown');
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
