import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Exercise the actual extension handlers, without UI, network calls or API keys.
const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '');
const eventNames = ['MESSAGE_RECEIVED', 'GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED'];

// ST EventEmitter snapshots listeners and awaits each one in registration order.
// makeFirst moves a handler to the front; a slow listener delays later handlers.
class Events {
    listeners = new Map();
    on(name, fn) {
        if (!this.listeners.has(name)) this.listeners.set(name, []);
        this.listeners.get(name).push(fn);
    }
    makeFirst(name, fn) {
        this.listeners.set(name, [fn, ...(this.listeners.get(name) || []).filter(x => x !== fn)]);
    }
    async emit(name, ...args) {
        for (const fn of [...(this.listeners.get(name) || [])]) await fn(...args);
    }
}

function fixture({ beforeBind, catchMode = 'safe' } = {}) {
    let now = 100000, timerId = 0;
    const timers = new Map(), commands = [];
    const events = new Events();
    beforeBind?.(events);
    const sandbox = {
        console: { log() {}, error() {} }, URL,
        Date: class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } },
        setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, due: now + delay, delay }); return id; },
        clearTimeout(id) { timers.delete(id); },
        sessionStorage: { setItem() {} },
        jQuery() {}, // Do not bootstrap UI; bind the production handlers below.
        $() { return { remove() {} }; },
        toastr: { error() {} }, eventSource: events,
        event_types: Object.fromEntries(eventNames.map(x => [x, x])),
        window: { SillyTavern: { getContext() { return { executeSlashCommandsWithOptions(cmd) { commands.push(cmd); } }; } } },
    };
    vm.createContext(sandbox);
    vm.runInContext(source + `
        settings = { enabled: true, catchMode: ${JSON.stringify(catchMode)}, maxRetries: 20, showBadge: false, showPopup: false };
        hookToastr(); bindEvents();
        globalThis.subject = {
            state: () => ({ active: retryState.active, count: retryState.count, inFlight: mainGenInFlight,
                pending: pendingError, endPending: generationEndTimer !== null,
                serial: activeMainGenerationSerial, retrySerial: retryState.generationSerial }),
            stop: () => stopRetrying('test stop'),
            disable: () => { settings.enabled = false; },
            setMaximum: value => { settings.maxRetries = value; },
            managed: value => { managedRetry = value; },
            backgroundTest: runBackgroundErrorTest,
        };
    `, sandbox);
    const advance = async ms => {
        const target = now + ms;
        for (;;) {
            const next = [...timers.entries()].filter(([,t]) => t.due <= target)
                .sort((a,b) => a[1].due - b[1].due || a[0] - b[0])[0];
            if (!next) break;
            const [id,timer] = next;
            now = timer.due; timers.delete(id); timer.fn();
            await Promise.resolve();
        }
        now = target;
    };
    return {
        ...sandbox.subject, events, commands, timers, advance,
        start: (type = 'normal', dryRun = false) => events.emit('GENERATION_STARTED', type, {}, dryRun),
        // ST passes chat.length, not the generation type, to GENERATION_ENDED.
        end: () => events.emit('GENERATION_ENDED', 12),
        receive: () => events.emit('MESSAGE_RECEIVED', 11, 'normal'),
        error: (message = '429 Too Many Requests', title = 'Other extension') => sandbox.toastr.error(message, title),
    };
}

test('streaming END before RECEIVED never arms retry while an earlier extension is slow', async () => {
    let release, entered = false;
    const h = fixture({ beforeBind(events) {
        events.on('MESSAGE_RECEIVED', async () => {
            entered = true;
            await new Promise(resolve => { release = resolve; });
        });
    } });
    await h.start(); h.error();
    // Model ST streaming finalization: END is emitted without awaiting it,
    // followed by MESSAGE_RECEIVED, whose extension listeners may take seconds.
    const ending = h.end();
    const received = h.receive();
    await ending;
    assert.equal(entered, true);
    await h.advance(10000);
    assert.equal(h.commands.length, 0);
    assert.equal(h.state().active, false);
    assert.equal(h.state().endPending, false);
    release(); await received;
});

test('non-streaming success before END ignores later translation errors', async () => {
    const h = fixture(); await h.start(); await h.receive();
    h.error(); await h.end(); await h.advance(10000);
    assert.equal(h.commands.length, 0); assert.equal(h.state().active, false);
});

test('same-turn success cancels deferred END even when notification is in a microtask', async () => {
    const h = fixture(); await h.start(); h.error(); await h.end();
    assert.equal(h.state().active, false); assert.equal(h.state().endPending, true);
    await Promise.resolve().then(() => h.receive());
    await h.advance(4000);
    assert.equal(h.commands.length, 0); assert.equal(h.state().endPending, false);
});

for (const status of [429, 503]) {
    test(`actual ${status} without received reply still retries after normal backoff`, async () => {
        const h = fixture(); await h.start(); h.error(`HTTP ${status}`, 'Generation'); await h.end();
        await h.advance(0); assert.equal(h.state().count, 1);
        await h.advance(2999); assert.equal(h.commands.length, 0);
        await h.advance(1); assert.match(h.commands[0], /\/trigger/);
    });
}

test('swipe failure retries a swipe; repeated failures keep backoff and maximum', async () => {
    const h = fixture(); h.setMaximum(2); await h.start('swipe'); h.error(); await h.end();
    await h.advance(3000); assert.deepEqual(h.commands, ['/swipe']);
    await h.start('swipe'); // Consume the programmatic retry marker.
    h.error(); await h.end(); await h.advance(4499);
    assert.equal(h.commands.length, 1);
    await h.advance(1); assert.deepEqual(h.commands, ['/swipe', '/swipe']);
    await h.start('swipe'); h.error(); await h.end(); await h.advance(20000);
    assert.equal(h.commands.length, 2); assert.equal(h.state().active, false);
});

test('late success cancels queued retry and an already captured callback is harmless', async () => {
    const h = fixture(); await h.start(); h.error(); await h.end(); await h.advance(0);
    const stale = [...h.timers.values()].find(t => t.delay === 3000).fn;
    await h.receive(); stale(); await h.advance(5000);
    assert.equal(h.commands.length, 0); assert.equal(h.state().active, false);
});

test('an old retry callback cannot execute a newer queued retry', async () => {
    const h = fixture(); await h.start(); h.error(); await h.end(); await h.advance(0);
    const stale = [...h.timers.values()].find(t => t.delay === 3000).fn;
    await h.receive(); await h.start(); h.error(); await h.end(); await h.advance(0);
    stale(); assert.equal(h.commands.length, 0);
    await h.advance(3000); assert.equal(h.commands.length, 1);
});

test('a new generation invalidates an old deferred END decision', async () => {
    const h = fixture(); await h.start(); h.error(); await h.end();
    const stale = [...h.timers.values()].find(t => t.delay === 0).fn;
    await h.start(); const serial = h.state().serial;
    stale(); await h.advance(5000);
    assert.equal(h.state().serial, serial); assert.equal(h.state().inFlight, true);
    assert.equal(h.commands.length, 0); assert.equal(h.state().active, false);
});

test('duplicate END events do not duplicate a retry', async () => {
    const h = fixture(); await h.start(); h.error(); await h.end(); await h.end();
    await h.advance(3000); assert.equal(h.commands.length, 1); assert.equal(h.state().count, 1);
});

test('manual stop clears deferred END and scheduled retry', async () => {
    for (const settle of [false, true]) {
        const h = fixture(); await h.start(); h.error(); await h.end();
        if (settle) await h.advance(0);
        h.stop(); await h.advance(10000);
        assert.equal(h.commands.length, 0); assert.equal(h.state().endPending, false);
    }
});

test('disable while waiting prevents retry; dry runs and quiet starts leave a retry intact', async () => {
    const h = fixture(); await h.start(); h.error(); await h.end(); await h.advance(0);
    await h.start('normal', true); await h.start('quiet');
    assert.equal(h.state().active, true);
    h.disable(); await h.advance(3000); assert.equal(h.commands.length, 0);
});

test('safe mode keeps excluding auth errors; all mode still retries them', async () => {
    for (const catchMode of ['safe', 'all']) {
        const h = fixture({ catchMode }); await h.start(); h.error('401 Unauthorized');
        await h.end(); await h.advance(3000);
        assert.equal(h.commands.length, catchMode === 'all' ? 1 : 0);
    }
});

test('managed 100LOG work remains isolated from toast-driven main retries', async () => {
    const h = fixture(); await h.start();
    h.managed({ hasActive: () => true }); h.error();
    assert.equal(h.state().pending, false);
    await h.end(); await h.advance(5000); assert.equal(h.commands.length, 0);
});

test('idle background errors and existing background self-test do not arm retries', async () => {
    const h = fixture(); h.error(); await h.advance(5000);
    assert.equal(h.state().active, false);
    assert.equal(h.backgroundTest().ok, true);
    await h.advance(5000); assert.equal(h.commands.length, 0);
});
