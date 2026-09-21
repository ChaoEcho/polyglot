import { test, expect } from 'bun:test';
import { TranslationService, TranslationError, chunks, validTranslation, workerRun, type Route } from './translation';
const routes: Route[] = [
  { name: 'google-direct', provider: 'google', timeout: 5000 },
  { name: 'bing-direct', provider: 'bing', timeout: 5000 },
];
test('split preserves source exactly, including paragraphs and emoji', () => {
  const text = '猫，'.repeat(950) + '\n\n' + '狗😀'.repeat(800);
  const parts = chunks(text);
  expect(parts.map(p => p.text).join('')).toBe(text);
  expect(parts.every(p => p.text.length <= 900)).toBe(true);
  expect(parts.filter(p => !p.literal).every(p => !/[\uD800-\uDBFF]$/.test(p.text))).toBe(true);
});
test('reject empty, unchanged, partial CJK and HTML', () => {
  for (const result of ['', '猫', 'cat 猫', '<html>error']) expect(validTranslation('猫', result, 'en')).toBe(false);
  expect(validTranslation('猫', 'cat', 'en')).toBe(true);
});
test('invalid Google result falls back to Bing', async () => {
  const seen: string[] = [];
  const service = new TranslationService(routes, async r => { seen.push(r.name); return r.provider === 'google' ? '猫' : 'cat'; });
  expect((await service.translate('猫', 'en')).translated_text).toBe('cat');
  expect(seen).toEqual(['google-direct', 'bing-direct']);
});
test('English bypasses all provider calls', async () => {
  const service = new TranslationService(routes, async () => { throw Error('must not call'); });
  expect((await service.translate('cat', 'en')).translated_text).toBe('cat');
});
test('chunks retain order with concurrency at most two', async () => {
  let active = 0, peak = 0;
  const service = new TranslationService(routes, async (_, text) => {
    active++; peak = Math.max(peak, active); await Bun.sleep(2); active--;
    return text.startsWith('猫') ? 'cat' : 'dog';
  });
  expect((await service.translate('猫'.repeat(901) + '\n\n狗', 'en')).translated_text).toBe('cat cat\n\ndog');
  expect(peak).toBe(2);
});
test('three failures open circuit; one probe after cooldown recovers', async () => {
  let now = 0, failed = true, calls = 0;
  const service = new TranslationService(routes.slice(0, 1), async () => {
    calls++; if (failed) throw new TranslationError('rate_limited'); return 'cat';
  }, 1000, () => now);
  for (let i = 0; i < 4; i++) await expect(service.translate('猫', 'en')).rejects.toThrow();
  expect(calls).toBe(3);
  now = 60001; failed = false;
  expect((await service.translate('猫', 'en')).translated_text).toBe('cat');
  expect(calls).toBe(4);
});
test('budget cancels in-flight provider and no fallback after abort', async () => {
  let stopped = false, calls = 0;
  const service = new TranslationService(routes, async (_, _text, _target, _source, signal) => {
    calls++;
    return await new Promise((_, reject) => signal.addEventListener('abort', () => {
      stopped = true; reject(new TranslationError('translation_timeout'));
    }, { once: true }));
  }, 10);
  await expect(service.translate('猫', 'en')).rejects.toThrow('translation_timeout');
  expect(stopped).toBe(true); expect(calls).toBe(1);
});
test('worker is terminated when its actual deadline expires', async () => {
  const started = Date.now();
  await expect(workerRun({ name: 'test', provider: 'google', timeout: 1, proxy: 'http://127.0.0.1:1' }, '猫', 'en', undefined, new AbortController().signal)).rejects.toThrow();
  expect(Date.now() - started).toBeLessThan(1500);
});
