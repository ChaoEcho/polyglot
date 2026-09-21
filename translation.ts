import { readFileSync } from 'node:fs';

export class TranslationError extends Error {
  constructor(public category: string) { super(category); }
}
export interface Route { name: string; provider: 'google' | 'bing'; timeout: number; proxy?: string }
type Runner = (route: Route, text: string, target: string, source: string | undefined, signal: AbortSignal) => Promise<string>;
const cjk = /[一-鿿぀-ヿ가-힯]/u;
export function validTranslation(input: string, output: unknown, target: string): output is string {
  return typeof output === 'string' && !!output.trim() && !/<(?:html|!doctype)/i.test(output)
    && !(target === 'en' && cjk.test(input) && (cjk.test(output) || input.trim() === output.trim()));
}

/** Keep line separators verbatim; split long paragraphs without losing order. */
export function chunks(text: string, limit = 900): { text: string; literal: boolean }[] {
  const result: { text: string; literal: boolean }[] = [];
  for (let line of text.split(/(\r?\n)/)) {
    if (!line || /^\s*$/.test(line)) { result.push({ text: line, literal: true }); continue; }
    while (line.length > limit) {
      const head = line.slice(0, limit);
      const boundary = Math.max(...['。', '，', '；', '. ', ', ', '; ', ' '].map(s => head.lastIndexOf(s)));
      let cut = boundary >= limit / 2 ? boundary + 1 : limit;
      if (/[\uD800-\uDBFF]/.test(line[cut - 1]!)) cut--;
      result.push({ text: line.slice(0, cut), literal: false });
      line = line.slice(cut);
    }
    if (line) result.push({ text: line, literal: false });
  }
  return result;
}

export const workerRun: Runner = (route, text, target, source, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(new TranslationError('translation_timeout')); return; }
  const worker = new Worker(new URL('./worker.ts', import.meta.url).href);
  let settled = false;
  const finish = (error?: Error, value?: string) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal.removeEventListener('abort', aborted);
    worker.terminate();
    if (error) reject(error); else resolve(value!);
  };
  const aborted = () => finish(new TranslationError('translation_timeout'));
  const timer = setTimeout(aborted, route.timeout);
  signal.addEventListener('abort', aborted, { once: true });
  worker.onerror = (event) => { event.preventDefault(); finish(new TranslationError('provider_error')); };
  worker.onmessage = (event) => {
    const result = event.data;
    finish(result.ok ? undefined : new TranslationError(result.category), result.text);
  };
  worker.postMessage({ provider: route.provider, proxy: route.proxy, text, target, source });
});

export function defaultRoutes(): Route[] {
  const routes: Route[] = [
    { name: 'google-direct', provider: 'google', timeout: 5000 },
    { name: 'bing-direct', provider: 'bing', timeout: 5000 },
  ];
  if (process.env.GOOGLE_TW_PROXY_FILE) {
    const proxy = readFileSync(process.env.GOOGLE_TW_PROXY_FILE, 'utf8').trim();
    if (!proxy.startsWith('http://')) throw new Error('Invalid proxy secret configuration');
    routes.push({ name: 'google-tw', provider: 'google', timeout: 12000, proxy });
  }
  return routes;
}

export class TranslationService {
  private circuits = new Map<string, { failures: number; until: number; probing: boolean }>();
  constructor(private routes = defaultRoutes(), private runner: Runner = workerRun,
    private budget = 24000, private now = () => Date.now()) {}

  async translate(text: string, target: string, source?: string, caller?: AbortSignal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.budget);
    const abort = () => controller.abort();
    caller?.addEventListener('abort', abort, { once: true });
    if (caller?.aborted) controller.abort();
    const signal = controller.signal;
    const parts = chunks(text);
    let next = 0;
    const output = new Array<string>(parts.length);
    const providers = new Set<string>();
    try {
      const jobs = Array.from({ length: Math.min(2, parts.length) }, async () => {
        while (next < parts.length) {
          const index = next++;
          const part = parts[index]!;
          if (part.literal || (target === 'en' && !cjk.test(part.text))) {
            output[index] = part.text; continue;
          }
          let last = 'translation_unavailable';
          let translated = false;
          for (const route of this.routes) {
            if (signal.aborted) throw new TranslationError('translation_timeout');
            let state = this.circuits.get(route.name);
            if (!state) { state = { failures: 0, until: 0, probing: false }; this.circuits.set(route.name, state); }
            if (state.until > this.now() || state.probing) continue;
            if (state.failures >= 3) state.probing = true;
            const started = this.now();
            try {
              const result = await this.runner(route, part.text, target, source, signal);
              if (!validTranslation(part.text, result, target)) throw new TranslationError('invalid_translation');
              state.failures = 0; state.until = 0;
              output[index] = result.trim(); providers.add(route.provider); translated = true;
              console.log(JSON.stringify({ event: 'translation', route: route.name, ok: true, ms: this.now() - started }));
              break;
            } catch (error) {
              last = error instanceof TranslationError ? error.category : 'provider_error';
              if (!signal.aborted) {
                state.failures++;
                if (state.failures >= 3) state.until = this.now() + 60000;
              }
              console.log(JSON.stringify({ event: 'translation', route: route.name, ok: false, category: last, ms: this.now() - started }));
            } finally { state.probing = false; }
          }
          if (!translated) throw new TranslationError(signal.aborted || last === 'translation_timeout' ? 'translation_timeout' : 'translation_unavailable');
        }
      });
      try { await Promise.all(jobs); }
      catch (error) { controller.abort(); await Promise.allSettled(jobs); throw error; }
      // Separate translated chunks to avoid joining two English words; preserve line breaks.
      const result = output.map((v, i) => i && !parts[i]!.literal && !parts[i - 1]!.literal ? ' ' + v : v).join('');
      if (!validTranslation(text, result, target)) throw new TranslationError('translation_unavailable');
      return { translated_text: result, source_lang: source || 'auto', target_lang: target, provider: [...providers].join(',') || 'passthrough' };
    } finally {
      clearTimeout(timer); caller?.removeEventListener('abort', abort);
      controller.abort();
    }
  }
}
