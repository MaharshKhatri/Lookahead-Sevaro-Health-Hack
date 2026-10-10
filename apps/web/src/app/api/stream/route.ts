import { getReadyStore, type StoreEvent } from '@/server/store';
import { errorJson } from '@/server/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const HEARTBEAT_MS = 15_000;

/**
 * GET /api/stream: Server-Sent Events {type, version, nowMs}. Clients refetch
 * /api/view when the version changes (debounced 200 ms). A comment heartbeat
 * every 15 s keeps proxies from closing the connection.
 */
export async function GET(req: Request): Promise<Response> {
  try {
    const store = await getReadyStore();
    const encoder = new TextEncoder();
    let cleanup = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (chunk: string) => {
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            cleanup();
          }
        };
        const s = store.snapshot();
        send(`retry: 2000\n\n`);
        send(`data: ${JSON.stringify({ type: 'hello', version: s.version, nowMs: s.clock.nowMs, bootId: s.bootId })}\n\n`);
        const unsubscribe = store.subscribe((e: StoreEvent) => send(`data: ${JSON.stringify(e)}\n\n`));
        const heartbeat = setInterval(() => send(`: heartbeat ${Date.now()}\n\n`), HEARTBEAT_MS);
        cleanup = () => {
          clearInterval(heartbeat);
          unsubscribe();
          try {
            controller.close();
          } catch {
            // already closed
          }
        };
        req.signal.addEventListener('abort', () => cleanup());
      },
      cancel() {
        cleanup();
      },
    });
    return new Response(stream, {
      headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' },
    });
  } catch (e) {
    return errorJson('INTERNAL', e instanceof Error ? e.message : String(e), 500);
  }
}
