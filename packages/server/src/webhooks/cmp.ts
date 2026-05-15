import { Hono } from 'hono';
import { ConsentManager } from '../engine/consent';
import { StorageProvider } from '../engine/storage';
import { OneTrustAdapter, CookiebotAdapter } from './adapters';
import { CMPAdapter } from './adapters/types';
import { ConsentState } from '@consentguard/shared';

export function createWebhookRouter(storage: StorageProvider, onConsentUpdated?: (userId: string, state: ConsentState) => Promise<void>) {
  const router = new Hono();
  const consentManager = new ConsentManager(storage);

  const adapters: Record<string, CMPAdapter> = {
    onetrust: new OneTrustAdapter(),
    cookiebot: new CookiebotAdapter(),
  };

  /**
   * CMP Webhook Handler
   */
  router.post('/:provider', async (c) => {
    const provider = c.req.param('provider');
    const adapter = adapters[provider];

    if (!adapter) {
      return c.json({ error: `Unsupported CMP provider: ${provider}` }, 400);
    }

    const body = await c.req.json();
    const userId = adapter.getUserId(body);
    const purposes = adapter.getPurposes(body);
    const metadata = adapter.getMetadata(body);

    if (!userId) {
      return c.json({ error: 'User ID not found in payload' }, 400);
    }

    console.log(`[ConsentGuard] Processing ${provider} webhook for user ${userId}`);

    const state: ConsentState = {
      userId,
      purposes,
      timestamp: Date.now(),
      metadata,
    };

    await consentManager.setConsent(userId, state);

    if (onConsentUpdated) {
      // Fire and forget
      onConsentUpdated(userId, state).catch(err => {
        console.error(`[ConsentGuard] Error in onConsentUpdated callback:`, err);
      });
    }

    return c.json({ 
      status: 'processed', 
      provider, 
      userId, 
      categoriesUpdated: Object.keys(purposes).filter(k => purposes[k]) 
    });
  });

  return router;
}
