import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createManagedRetry, classifyManagedError } from '../managed-retry.js';

const failure = (status = 429) => Object.assign(new Error(`HTTP ${status} private text`), { status });
function fixture(overrides = {}) {
    const settings = { enabled: true, maxRetries: 2, catchMode: 'safe' };
    const delays = [], logs = [];
    const api = createManagedRetry({ getSettings: () => settings, classify: classifyManagedError,
        log: (...args) => logs.push(args), setTimer: (fn, ms) => { delays.push(ms); queueMicrotask(fn); return 1; }, clearTimer() {}, ...overrides });
    return { api, settings, delays, logs, run: (action, options = {}) => api.run({ owner: '100LOG', stage: '메인 AI 초안 생성', action, ...options }) };
}
test('retries only supplied action and records metadata without error text', async () => {
    const h = fixture(); let calls = 0;
    assert.equal(await h.run(() => { if (++calls < 3) throw failure(); return 'draft'; }), 'draft');
    assert.equal(calls, 3); assert.deepEqual(h.delays, [3000, 4500]);
    assert.equal(h.api.hasActive(), false); assert.ok(!JSON.stringify(h.logs).includes('private text'));
});
test('retry count is bounded; zero means unlimited until success', async () => {
    const h = fixture(); let calls = 0;
    await assert.rejects(h.run(() => { calls++; throw failure(); }), /429/);
    assert.equal(calls, 3);
    h.settings.maxRetries = 0; calls = 0;
    await h.run(() => { if (++calls < 9) throw failure(); });
    assert.equal(calls, 9); assert.equal(h.delays.at(-1), 20000);
});
test('safe mode excludes auth and abort; all mode still excludes abort', async () => {
    for (const status of [400, 401, 403, 413, 422]) assert.equal(classifyManagedError(failure(status)).retryable, false);
    for (const status of [408, 429, 500, 502, 503, 504]) assert.equal(classifyManagedError(failure(status)).retryable, true);
    for (const mode of ['safe', 'all']) assert.equal(classifyManagedError({ name: 'AbortError' }, mode).retryable, false);
    const h = fixture(); await assert.rejects(h.run(() => { throw failure(401); })); assert.equal(h.delays.length, 0);
});
test('honors long Retry-After without timer overflow', async () => {
    const h = fixture(); let calls = 0;
    await h.run(() => { if (!calls++) throw Object.assign(failure(), { retryAfterMs: 125000 }); });
    assert.deepEqual(h.delays, [60000, 60000, 5000]);
});
test('stop during backoff cancels owner and prevents another attempt', async () => {
    let pending; const h = fixture({ setTimer: fn => { pending = fn; return 1; } });
    let calls = 0, cancelled = 0;
    const task = h.run(() => { calls++; throw failure(); }, { onCancel: () => cancelled++ });
    assert.equal(h.api.getStatus()[0].waiting, true); h.api.cancelAll();
    await assert.rejects(task, { name: 'AbortError' }); pending();
    assert.equal(calls, 1); assert.equal(cancelled, 1); assert.equal(h.api.hasActive(), false);
});
test('parent abort and chat validation prevent late results', async () => {
    const h = fixture(); const controller = new AbortController(); let finish;
    const task = h.run(() => new Promise(resolve => { finish = resolve; }), { signal: controller.signal });
    controller.abort(); finish('late'); await assert.rejects(task, { name: 'AbortError' });
    let calls = 0;
    await assert.rejects(h.run(() => calls++, { validate: () => false }), { name: 'AbortError' });
    assert.equal(calls, 0);
});
test('disabling while waiting cancels without another request', async () => {
    let pending; const h = fixture({ setTimer: fn => { pending = fn; return 1; } }); let calls = 0;
    const task = h.run(() => { calls++; throw failure(); }); h.settings.enabled = false; pending();
    await assert.rejects(task, { name: 'AbortError' }); assert.equal(calls, 1);
});
test('does not accept collection or unrelated extensions', async () => {
    const h = fixture(); let calls = 0;
    for (const options of [{ stage: '규칙 수집' }, { owner: 'other' }]) await assert.rejects(h.run(() => calls++, options), TypeError);
    assert.equal(calls, 0);
});
