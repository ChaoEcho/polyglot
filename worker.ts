/** Isolated provider invocation: terminating the worker closes provider sockets,
 * including Bing's internally retried requests that expose no abort signal. */
import { translate as google } from '@vitalets/google-translate-api';
import bing from 'bing-translate-api';
import { HttpsProxyAgent } from 'https-proxy-agent';

declare var self: Worker;
self.onmessage = async (event: MessageEvent) => {
  const { provider, text, target, source, proxy } = event.data;
  const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;
  try {
    let result: string;
    if (provider === 'google') {
      result = (await google(text, { to: target, from: source || 'auto', fetchOptions: { agent } })).text;
    } else {
      const translated = await bing.translate(text, source || null, target, false, false, undefined,
        agent ? { https: agent } : undefined);
      result = translated?.translation || '';
    }
    self.postMessage({ ok: true, text: result });
  } catch (error: any) {
    // Never serialize errors: URLs may embed input text or proxy credentials.
    self.postMessage({ ok: false, category: error?.status === 429 || error?.statusCode === 429 ? 'rate_limited' : 'provider_error' });
  } finally {
    agent?.destroy();
  }
};
