import { handleApi } from './api';
import { corsResponse } from './http';
import { handleQueue } from './queue';
import type { Env, PushQueueJob } from './types';

export { RelayCoordinator } from './relay-coordinator';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return corsResponse();
    }

    const response = await handleApi(request, env);
    if (response) return response;

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },

  async queue(batch: MessageBatch<PushQueueJob>, env: Env): Promise<void> {
    await handleQueue(batch, env);
  },
} satisfies ExportedHandler<Env, PushQueueJob>;
