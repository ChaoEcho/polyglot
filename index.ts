import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { TranslationService, TranslationError } from './translation';
const service = new TranslationService();
const token = process.env.ACCESS_TOKEN_FILE ? readFileSync(process.env.ACCESS_TOKEN_FILE, 'utf8').trim() : process.env.ACCESS_TOKEN || '';
if (!token) throw new Error('ACCESS_TOKEN_FILE is required');
let active = 0;
function authorized(request: Request) {
  const supplied = Buffer.from(request.headers.get('Authorization') || '');
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
Bun.serve({
  port: Number(process.env.PORT || 3220),
  maxRequestBodySize: 65536,
  idleTimeout: 30,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/ping') return new Response('Pong!');
    if (path !== '/translate' || request.method !== 'POST') return new Response('Not Found', { status: 404 });
    if (!authorized(request)) return Response.json({ error: 'unauthorized' }, { status: 401 });
    if (active >= 16) return Response.json({ error: 'translation_busy' }, { status: 429, headers: { 'Retry-After': '5' } });
    let body: any;
    try { body = await request.json(); } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }); }
    if (!body || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 20000 || body.target_lang !== 'en'
      || (body.source_lang !== undefined && typeof body.source_lang !== 'string')) {
      return Response.json({ error: 'invalid_request', message: 'Non-empty text (max 20000 UTF-16 units) and target_lang=en are required' }, { status: 400 });
    }
    active++;
    try { return Response.json(await service.translate(body.text, body.target_lang, body.source_lang, request.signal)); }
    catch (error) {
      const code = error instanceof TranslationError ? error.category : 'translation_unavailable';
      return Response.json({ error: code }, { status: code === 'translation_timeout' ? 504 : 503 });
    } finally { active--; }
  },
});
console.log('Polyglot machine translation ready');
