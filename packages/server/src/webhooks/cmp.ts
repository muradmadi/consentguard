import { Hono } from 'hono';
import { ConsentManager } from '../engine/consent';
import { serverConfig } from '../config';

export const webhookRouter = new Hono();
const consentManager = new ConsentManager(serverConfig.redisUrl);

/**
 * Generic Webhook Handler (Mocking OneTrust/Cookiebot)
 */
webhookRouter.post('/:provider', async (c) => {
  const provider = c.req.param('provider');
  const body = await c.req.json();

  console.log(`[ConsentGuard] Received webhook from ${provider}`);

  // In a real implementation, we would have specific adapters for each provider's payload structure.
  // For 60%, we'll implement a generic adapter that maps "preferences" to "purposes".
  
  let userId: string | undefined;
  let purposes: Record<string, boolean> = {};

  if (provider === 'onetrust') {
    userId = body.UserId || body.identifier;
    // Mock mapping
    purposes = {
      analytics: body.consentGroups?.includes('C002'),
      marketing: body.consentGroups?.includes('C004'),
    };
  } else if (provider === 'cookiebot') {
    userId = body.userId;
    purposes = {
      analytics: body.statistics === true,
      marketing: body.marketing === true,
    };
  }

  if (!userId) {
    return c.json({ error: 'User ID not found in payload' }, 400);
  }

  await consentManager.setConsent(userId, {
    userId,
    purposes,
    timestamp: Date.now(),
    metadata: { source: `webhook:${provider}` }
  });

  return c.json({ status: 'processed', provider });
});
