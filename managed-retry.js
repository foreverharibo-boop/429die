// Explicit opt-in stages only. Never infer ownership from a global toast or fetch.
export function createManagedRetry({ getSettings, classify, log = () => {}, changed = () => {},
    setTimer = setTimeout, clearTimer = clearTimeout }) {
    const stages = new Set(['메인 AI 초안 생성', '메인 AI 재작성', 'JEV 초안 검수', 'JEV 답변 검수', 'JEV 재검수']);
    const tasks = new Map();
    let serial = 0;
    const notify = () => { try { changed(); } catch { /* UI is optional. */ } };
    const record = (event, task, extra = {}) => {
        try { log(event, { task: task.id, owner: '100LOG', stage: task.stage, retry: task.count, ...extra }); } catch { /* optional */ }
    };
    const cancelled = () => Object.assign(new Error('연동 재시도를 중단했습니다.'), { name: 'AbortError', hundredlogCancelled: true });
    function cancel(task) {
        if (task.controller.signal.aborted) return;
        task.controller.abort(cancelled());
        try { task.onCancel?.(); } catch { /* still cancel our own wait */ }
        record('연동 작업 중단', task);
        notify();
    }
    function check(task) {
        if (task.controller.signal.aborted || task.signal?.aborted) throw cancelled();
        if (task.validate?.() === false) { cancel(task); throw cancelled(); }
    }
    async function wait(task, ms) {
        // Retry-After can exceed the timer integer range. Preserve it in chunks.
        for (let remaining = ms; remaining > 0; remaining -= 60000) {
            check(task);
            await new Promise((resolve, reject) => {
                const signal = task.controller.signal;
                let timer;
                const stopped = () => { clearTimer(timer); signal.removeEventListener('abort', stopped); reject(cancelled()); };
                signal.addEventListener('abort', stopped, { once: true });
                timer = setTimer(() => { signal.removeEventListener('abort', stopped); resolve(); }, Math.min(remaining, 60000));
                if (signal.aborted) stopped();
            });
        }
        check(task);
    }
    return Object.freeze({
        apiVersion: 1,
        isEnabled: () => !!getSettings()?.enabled,
        hasActive: () => [...tasks.values()].some(task => !task.controller.signal.aborted),
        getStatus: () => [...tasks.values()].filter(task => !task.controller.signal.aborted && task.count > 0)
            .map(task => ({ id: task.id, owner: '100LOG', stage: task.stage, count: task.count, waiting: task.waiting })),
        cancelAll: () => { for (const task of tasks.values()) cancel(task); },
        async run({ owner, stage, action, signal, validate, onCancel }) {
            if (owner !== '100LOG' || !stages.has(stage) || typeof action !== 'function') throw new TypeError('지원하지 않는 재시도 작업입니다.');
            const task = { id: ++serial, stage: stage === 'JEV 초안 검수' ? 'JEV 답변 검수' : stage, signal, validate, onCancel, controller: new AbortController(), count: 0, waiting: false };
            const stopped = () => cancel(task);
            signal?.addEventListener('abort', stopped, { once: true });
            tasks.set(task.id, task);
            record('연동 작업 시작', task);
            notify();
            try {
                for (;;) {
                    check(task);
                    if (task.count > 0 && !getSettings()?.enabled) { cancel(task); throw cancelled(); }
                    task.waiting = false;
                    notify();
                    try {
                        const result = await action();
                        check(task);
                        record('연동 작업 성공', task);
                        return result;
                    } catch (error) {
                        check(task);
                        // Even the "all errors" setting must respect cancellation.
                        if (error?.name === 'AbortError' || error?.hundredlogCancelled) throw error;
                        const config = getSettings();
                        const decision = classify(error, config?.catchMode);
                        const maximum = Math.max(0, Math.floor(Number(config?.maxRetries) || 0));
                        if (!config?.enabled || !decision.retryable || (maximum > 0 && task.count >= maximum)) {
                            record('연동 재시도 종료', task, { http: decision.http, reason: !config?.enabled ? 'disabled' : !decision.retryable ? 'excluded' : 'limit' });
                            throw error;
                        }
                        task.count++;
                        const delay = Math.max(Math.min(3000 * Math.pow(1.5, task.count - 1), 20000),
                            Number.isFinite(error?.retryAfterMs) ? Math.max(0, error.retryAfterMs) : 0);
                        task.waiting = true;
                        record('연동 재시도 예약', task, { http: decision.http, delayMs: delay, maximum });
                        notify();
                        await wait(task, delay);
                    }
                }
            } finally {
                tasks.delete(task.id);
                signal?.removeEventListener('abort', stopped);
                notify();
            }
        },
    });
}

export function classifyManagedError(error, mode = 'safe') {
    const text = String(error?.message ?? error?.error?.message ?? error ?? '').toLowerCase();
    const code = Number(error?.status || error?.statusCode || error?.response?.status || error?.error?.code)
        || Number(text.match(/\b(400|401|403|408|413|422|429|5\d\d)\b/)?.[1]) || 0;
    if (error?.name === 'AbortError' || error?.hundredlogCancelled) return { retryable: false, http: code };
    if (mode === 'all') return { retryable: true, http: code };
    if ([400, 401, 403, 413, 422].includes(code)
        || /unauthori|forbidden|invalid.?api.?key|api.?key.*(?:invalid|not valid)|authentication|permission.denied|billing|credit|payment|context.length|too.long|인증|권한|키.*확인|토큰 한도|대화가 바뀌|채팅.*바뀌/.test(text)) {
        return { retryable: false, http: code };
    }
    return { http: code, retryable: [408, 429].includes(code) || (code >= 500 && code <= 599)
        || error?.retryable === true || error?.name === 'TimeoutError'
        || /resource.exhausted|rate.limit|too.many.requests|overloaded|temporarily.unavailable|try.again|timeout|timed.out|network|fetch.failed|failed.to.fetch|econnreset|empty.response|no.response|빈 응답|응답.*비어|응답을 받지 못/.test(text) };
}
