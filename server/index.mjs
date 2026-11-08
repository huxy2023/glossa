import { handleMyShipFetch } from '../apps/api/src/index.ts';

export async function fetch(request, context) {
  return handleMyShipFetch(request, context);
}
