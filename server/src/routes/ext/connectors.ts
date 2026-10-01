import type { FastifyInstance } from 'fastify';

/** Extension point for the 'connectors' feature area (registered in routes/ext/index.ts). Intentionally empty for now. */
export default async function (_app: FastifyInstance) {
  // Routes for this feature area are added by its own build.
}
