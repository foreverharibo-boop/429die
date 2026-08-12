import { extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types } from "../../../../script.js";

const EXT_ID = "429die";

// 켜고 끄는 것 외에는 UI로 노출하지 않는 고정값
const CONFIG = {
    retryDelay: 3000,        // ms
    backoffMultiplier: 1.5,  // 재시도마다 딜레이 증가
    maxDelay: 20000,         // 백오프 상한선
    errorToEndWindow: 10000, // 오류 감지 후 같은 생성 종료로 인정할 최대 시간
    patterns: [
        // --- Rate limit / 할당량 (429 계열) ---
        "429",
        "error-code-429",
        "resource exhausted",
        "rate limit",
        "rate-limit",
        "too many requests",
        "quota",
        "requests per minute",
        "rpm",
        "tpm",
        // --- 과부하 / 서버가 잠깐 바쁨 ---
        "overloaded",
        "please try again later",
        "try again",
        "temporarily unavailable",
        "server is busy",
        "capacity",
        "at capacity",
        // --- 일시적 서버 오류 (5xx 계열) ---
        "internal server error",
        "500",
        "502",
        "bad gateway",
        "503",
        "service unavailable",
        "504",
        "gateway timeout",
        "upstream",
        // --- 타임아웃 / 네트워크 일시 장애 ---
        "timeout",
        "timed out",
        "econnreset",
        "econnrefused",
        "connection reset",
        "connection refused",
        "network error",
        "fetch failed",
        "socket hang up",
        "empty response",
        "no response",
        // --- 검열 / 콘텐츠 필터 (리롤하면 통과되는 경우가 많음) ---
        "content filter",
        "content_filter",
        "safety",
        "blocked",
        "prohibited",
        "recitation",
        "no candidates",
        "candidate was blocked",
        "finishreason: safety",
        "finishreason: other",
        "finish_reason: safety",
        "finish_reason: content_filter",
    ],
    // 아래 패턴이 오류 메시지에 있으면 위 패턴과 무관하게 재시도하지 않음
    excludePatterns: [
        "401",
        "403",
        "unauthorized",
        "forbidden",
        "invalid api key",
        "invalid_api_key",
        "api key",
        "authentication",
        "permission denied",
        "400",
        "bad request",
        "invalid request",
        "context length",
        "context_length",
        "maximum context",
        "too long",
        "insufficient",
        "billing",
        "credit",
        "payment",
    ],
};

let settings;
let lastGenerationType = null;
let mainGenInFlight = false; // 본 채팅 생성이 진행 중인지 (generateRaw 백그라운드 생성은 이 이벤트를 안 냄)
let pendingError = false;    // 오류 토스트를 감지했고, 재시도 여부 판단 대기 중
let gotMessageThisGen = false; // 이번 본 채팅 생성에서 정상 응답(MESSAGE_RECEIVED)을 받았는지
let pendingErrorTimer = null;  // 오류 후 정상 응답이 오는지 확인하는 타이머
let mainGenerationSerial = 0; // 실제 본채팅 생성 회차 식별자
let activeMainGenerationSerial = null;
let pendingErrorGenerationSerial = null;
let pendingErrorAt = 0;
let retryState = {
    active: false,
    count: 0,
    timer: null,
    programmaticClick: false,
    suppressUntil: 0,
    manuallyStopped: false,
    stoppingGeneration: false,
    retryStartPending: false,
    retryStartTimer: null,
};

const LOG_BUFFER_MAX = 300;
const logBuffer = [];

function log(...args) {
    console.log("[429die]", ...args);
    try {
        const time = new Date().toLocaleTimeString("ko-KR", { hour12: false });
        const line = `[${time}] ` + args.map((a) => {
            if (typeof a === "string") return a;
            try { return JSON.stringify(a); } catch { return String(a); }
        }).join(" ");
        logBuffer.push(line);
        if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
    } catch { /* 로그 기록 실패는 무시 */ }
}

function popup(type, message) {
    if (!settings || !settings.showPopup) return;
    if (toastr[type]) toastr[type](message, "429die");
}

function loadSettings() {
    if (!extension_settings[EXT_ID]) {
        extension_settings[EXT_ID] = { enabled: true, maxRetries: 20, showBadge: true, showPopup: true };
    }
    if (extension_settings[EXT_ID].enabled === undefined) {
        extension_settings[EXT_ID].enabled = true;
    }
    if (extension_settings[EXT_ID].maxRetries === undefined) {
        extension_settings[EXT_ID].maxRetries = 20;
    }
    if (extension_settings[EXT_ID].showBadge === undefined) {
        extension_settings[EXT_ID].showBadge = true;
    }
    if (extension_settings[EXT_ID].showPopup === undefined) {
        extension_settings[EXT_ID].showPopup = true;
    }
    if (extension_settings[EXT_ID].catchMode === undefined) {
        extension_settings[EXT_ID].catchMode = "safe"; // "safe" = A(재시도 가능한 오류만), "all" = 모든 오류
    }
    return extension_settings[EXT_ID];
}

function matchesPattern(message) {
    // "모든 오류" 모드: 오류 토스트가 뜨면 무조건 재시도
    if (settings.catchMode === "all") {
        return true;
    }
    // "안전" 모드(A): 재시도 가능한 오류만, 인증/요청/잔액 오류는 제외
    if (!message) return false;
    const lower = String(message).toLowerCase();
    if (CONFIG.excludePatterns.some((p) => p && lower.includes(p.toLowerCase()))) {
        log("제외 패턴에 해당하는 오류, 재시도 안 함:", lower);
        return false;
    }
    return CONFIG.patterns.some((p) => p && lower.includes(p.toLowerCase()));
}

function getBadgeParent() {
    // 입력창 컨테이너를 우선 부모로 사용 (뷰포트 기준 fixed가 모바일에서 깨지는 것 회피)
    return document.getElementById("form_sheld")
        || document.getElementById("sheld")
        || document.body;
}

function applyBadgeStyle($ind) {
    const el = $ind[0];
    if (!el) return;
    const s = el.style;
    const set = (k, v) => s.setProperty(k, v, "important");

    const parent = el.parentElement;
    const anchoredToForm = parent && (parent.id === "form_sheld" || parent.id === "sheld");

    if (anchoredToForm) {
        // 입력창 컨테이너 기준으로 그 위에 붙인다 (웹·모바일 공통으로 확실)
        set("position", "absolute");
        set("left", "50%");
        set("right", "auto");
        set("transform", "translateX(-50%)");
        set("bottom", "100%");        // 컨테이너(입력창)의 바로 위
        set("top", "auto");
        set("margin-bottom", "8px");
    } else {
        // 예외: 컨테이너를 못 찾으면 뷰포트 하단 기준
        set("position", "fixed");
        set("left", "50%");
        set("right", "auto");
        set("transform", "translateX(-50%)");
        set("bottom", "calc(72px + env(safe-area-inset-bottom, 0px))");
        set("top", "auto");
    }

    set("z-index", "2147483647");
    set("max-width", "calc(100vw - 24px)");
    set("width", "max-content");
    set("box-sizing", "border-box");
    set("margin-left", "0");
    set("margin-right", "0");
    set("margin-top", "0");
    set("padding", "8px 16px");
    set("background", "#ffffff");
    set("color", "#222222");
    set("border-radius", "20px");
    set("font-size", "13px");
    set("line-height", "1.4");
    set("cursor", "pointer");
    set("box-shadow", "0 2px 10px rgba(0,0,0,0.4)");
    set("user-select", "none");
    set("white-space", "nowrap");
    set("overflow", "hidden");
    set("text-overflow", "ellipsis");
    set("display", "block");
    set("visibility", "visible");
    set("opacity", "1");
    set("pointer-events", "auto");
    set("backdrop-filter", "none");
    set("-webkit-backdrop-filter", "none");
    set("filter", "none");
    set("text-shadow", "none");
}

function updateIndicator() {
    let $ind = $("#die429_indicator");
    if (!retryState.active || !settings.showBadge) {
        $ind.remove();
        return;
    }
    const typeText = lastGenerationType === "swipe" ? "스와이프" : "전송";
    const countText = settings.maxRetries > 0
        ? `${retryState.count}/${settings.maxRetries}`
        : `${retryState.count}회`;
    const text = `🔄 ${typeText} 재시도 중... (${countText})  ✕`;
    if ($ind.length === 0) {
        $ind = $(`<div id="die429_indicator"></div>`);
        const parent = getBadgeParent();
        // absolute 배치가 먹도록 부모를 positioned 상태로 + 배지가 잘리지 않게
        if (parent !== document.body) {
            if (getComputedStyle(parent).position === "static") {
                parent.style.setProperty("position", "relative");
            }
            parent.style.setProperty("overflow", "visible");
        }
        parent.appendChild($ind[0]);
    }
    $ind.text(text);
    applyBadgeStyle($ind);
}

function showDemoBadge() {
    // 실제 재시도 없이 배지 위치만 확인하기 위한 데모 배지
    const old = document.getElementById("die429_indicator");
    if (old) old.remove();

    const el = document.createElement("div");
    el.id = "die429_indicator";
    el.textContent = "🔄 전송 재시도 중... (3/20)  ✕ (테스트)";
    const parent = getBadgeParent();
    if (parent !== document.body) {
        if (getComputedStyle(parent).position === "static") {
            parent.style.setProperty("position", "relative");
        }
        parent.style.setProperty("overflow", "visible");
    }
    parent.appendChild(el);

    applyBadgeStyle($(el));

    // 5초 뒤 자동 제거
    setTimeout(() => {
        if (!retryState.active) {
            const cur = document.getElementById("die429_indicator");
            if (cur) cur.remove();
        }
    }, 5000);
}

function resetRetryState() {
    retryState.active = false;
    retryState.count = 0;
    lastGenerationType = null;
    if (retryState.timer) {
        clearTimeout(retryState.timer);
        retryState.timer = null;
    }
    retryState.retryStartPending = false;
    if (retryState.retryStartTimer) {
        clearTimeout(retryState.retryStartTimer);
        retryState.retryStartTimer = null;
    }
    updateIndicator();
}

function clearPendingErrorState() {
    pendingError = false;
    pendingErrorGenerationSerial = null;
    pendingErrorAt = 0;
    if (pendingErrorTimer) {
        clearTimeout(pendingErrorTimer);
        pendingErrorTimer = null;
    }
}

function beginMainGeneration(type) {
    mainGenerationSerial += 1;
    activeMainGenerationSerial = mainGenerationSerial;
    lastGenerationType = type === "swipe" ? "swipe" : "normal";
    mainGenInFlight = true;
    gotMessageThisGen = false;
    clearPendingErrorState();
}

function clearMainGenerationState({ preserveLastType = false } = {}) {
    mainGenInFlight = false;
    activeMainGenerationSerial = null;
    gotMessageThisGen = false;
    clearPendingErrorState();
    if (!preserveLastType) {
        lastGenerationType = null;
    }
}

function stopSTGeneration() {
    // 우리가 stopGeneration을 부르면 GENERATION_STOPPED 이벤트가 발생하는데,
    // 그 이벤트를 onGenerationStopped가 다시 받아 무한루프가 되므로 플래그로 차단
    retryState.stoppingGeneration = true;
    let usedApi = false;
    try {
        const ctx = (window.SillyTavern && window.SillyTavern.getContext)
            ? window.SillyTavern.getContext()
            : null;
        if (ctx && typeof ctx.stopGeneration === "function") {
            ctx.stopGeneration();
            usedApi = true;
        }
    } catch (e) {
        console.error("[429die] stopGeneration 호출 실패:", e);
    }
    // context API를 썼다면 정지 버튼까지 다시 누르지 않는다.
    // 두 경로를 연속 실행하면 같은 생성을 중복 취소하게 된다.
    if (!usedApi) {
        const $stop = $("#mes_stop");
        if ($stop.length && $stop.is(":visible")) {
            retryState.programmaticClick = true;
            $stop.trigger("click");
            setTimeout(() => { retryState.programmaticClick = false; }, 300);
        }
    }
    // 이벤트가 비동기로 도착할 수 있으니 잠시 뒤 플래그 해제
    setTimeout(() => { retryState.stoppingGeneration = false; }, 500);
}

function stopRetrying(reason, { stopGeneration = false } = {}) {
    // 이미 중단된 상태에서 또 불리면(중복 이벤트/더블 클릭 등) 아무것도 하지 않음
    if (!retryState.active && retryState.manuallyStopped) return;

    if (retryState.active) {
        log("중단:", reason);
        popup("info", `자동 재시도를 종료했습니다. (${reason})`);
    }
    // 중단 래치: 사용자가 직접 새 액션(전송/스와이프)을 하기 전까지
    // ST의 자동 스와이프 되돌리기 등으로 재시도가 되살아나지 않게 완전 차단
    retryState.manuallyStopped = true;
    retryState.suppressUntil = Date.now() + 3000;
    clearMainGenerationState();
    // 진행 중인 ST 생성 정지는 요청된 경우에만 실행한다.
    // 예: 배지 ✕ 클릭은 재시도로 시작된 생성까지 끊어야 하지만,
    // "사용자가 새로 전송함" 같은 경우엔 방금 시작된 새 생성을 끊으면 안 된다.
    if (stopGeneration) stopSTGeneration();
    resetRetryState();
}

function scheduleRetry() {
    if (!settings.enabled) return;
    if (retryState.manuallyStopped) {
        log("사용자가 중단함, 새 액션 전까지 재시도 안 함");
        return;
    }
    if (Date.now() < retryState.suppressUntil) {
        log("중단 직후 쿨다운 중, 재시도 스킵");
        return;
    }
    if (lastGenerationType === null) {
        log("유저가 아직 아무 버튼도 누르지 않음, 재시도 스킵");
        return;
    }

    if (settings.maxRetries > 0 && retryState.count >= settings.maxRetries) {
        log(`최대 재시도 횟수(${settings.maxRetries}회) 도달`);
        popup("warning", `최대 재시도 횟수(${settings.maxRetries}회)에 도달하여 종료했습니다.`);
        resetRetryState();
        return;
    }

    retryState.active = true;
    retryState.count += 1;

    let delay = CONFIG.retryDelay;
    if (CONFIG.backoffMultiplier > 1.0) {
        delay = Math.min(
            CONFIG.retryDelay * Math.pow(CONFIG.backoffMultiplier, retryState.count - 1),
            CONFIG.maxDelay
        );
    }

    updateIndicator();
    log(`재시도 #${retryState.count} 예약됨, ${delay}ms 후 실행`);

    retryState.timer = setTimeout(() => retryLastAction(), delay);
}

function retryLastAction() {
    if (!retryState.active) return;

    // 우리가 시작하는 재시도 생성은 programmaticClick 때문에 onGenerationStarted에서
    // mainGenInFlight가 안 켜지므로, 여기서 직접 켜준다 (재시도 생성의 실패도 감지하기 위함).
    beginMainGeneration(lastGenerationType);

    // "곧 시작될 생성은 내 재시도"라는 마커.
    // QR 큐잉·슬래시 커맨드 지연·무거운 채팅 때문에 생성 시작(GENERATION_STARTED)이
    // programmaticClick 800ms 창을 넘겨 도착하면, 그걸 사용자 전송으로 착각해
    // 재시도를 스스로 죽이는 문제가 있었다. 시간이 아니라 마커 소비로 판별한다.
    markRetryStartPending();

    if (lastGenerationType === "swipe") {
        clickSwipeButton();
    } else {
        clickSendButton();
    }
}

function markRetryStartPending() {
    // 마커는 소비되거나 재시도가 끝날 때(resetRetryState)까지 유지한다.
    // 이전에 있던 20초 만료 타이머는 제거 — 무거운 채팅에선 슬래시 커맨드 실행 후
    // 실제 생성 시작까지 30초 이상 걸릴 수 있어서, 만료 직후 도착한 진짜 재시도
    // 생성을 사용자 전송으로 오인해 재시도를 죽이는 원인이 됐다.
    retryState.retryStartPending = true;
}

function consumeRetryStartMarker() {
    if (!retryState.retryStartPending) return false;
    retryState.retryStartPending = false;
    return true;
}

function clickSwipeButton() {
    if (!retryState.active) return;

    // '.swipe_right' 버튼을 직접 누르면 스와이프 인덱스가 계속 앞으로 넘어가버림.
    // ST의 정식 재생성(슬래시 커맨드)을 써서 마지막 메시지를 다시 굴린다.
    const ctx = (window.SillyTavern && window.SillyTavern.getContext)
        ? window.SillyTavern.getContext()
        : null;
    const exec = ctx && (ctx.executeSlashCommandsWithOptions || ctx.executeSlashCommands);

    if (exec) {
        log("스와이프 재생성(슬래시 커맨드), 시도 #", retryState.count);
        retryState.programmaticClick = true;
        try {
            exec.call(ctx, "/swipe");
        } catch (e) {
            console.error("[429die] 스와이프 커맨드 실패, 버튼 클릭으로 대체:", e);
            fallbackSwipeClick();
        }
        setTimeout(() => { retryState.programmaticClick = false; }, 800);
        return;
    }

    // 슬래시 커맨드를 못 쓰는 환경이면 버튼 클릭으로 대체
    fallbackSwipeClick();
}

function fallbackSwipeClick() {
    const $swipeBtn = $("#chat").find(".mes").last().find(".swipe_right");
    if ($swipeBtn.length === 0) {
        log("스와이프 버튼을 찾을 수 없음, 전송 버튼으로 대체");
        clickSendButton();
        return;
    }
    log("스와이프 버튼 클릭(대체), 시도 #", retryState.count);
    retryState.programmaticClick = true;
    $swipeBtn.trigger("click");
    setTimeout(() => { retryState.programmaticClick = false; }, 800);
}

function clickSendButton() {
    if (!retryState.active) return;

    // 유저가 기본 전송 버튼 대신 Quick Reply(빠답) 등으로 메시지를 보내는 경우가 있어,
    // 버튼을 눌러도 전송이 안 될 수 있다. ST 정식 슬래시 커맨드로 재생성을 실행한다.
    const ctx = (window.SillyTavern && window.SillyTavern.getContext)
        ? window.SillyTavern.getContext()
        : null;
    const exec = ctx && (ctx.executeSlashCommandsWithOptions || ctx.executeSlashCommands);

    if (exec) {
        // 유저 빠답과 동일한 동작:
        // 입력창이 비어있으면 재생성(/trigger)만, 내용이 있으면 보내고(/send) 재생성(/trigger).
        const cmd = '/if left={{input}} right="" rule=eq else={: /send {{input}} | /trigger :} {: /trigger :}';
        log("전송 재생성(슬래시 커맨드), 시도 #", retryState.count);
        retryState.programmaticClick = true;
        try {
            exec.call(ctx, cmd);
        } catch (e) {
            console.error("[429die] 전송 커맨드 실패, 버튼 클릭으로 대체:", e);
            fallbackSendClick();
        }
        setTimeout(() => { retryState.programmaticClick = false; }, 800);
        return;
    }

    // 슬래시 커맨드를 못 쓰는 환경이면 버튼 클릭으로 대체
    fallbackSendClick();
}

function fallbackSendClick() {
    const $sendBtn = $("#send_but");
    if ($sendBtn.length === 0) {
        log("전송 버튼을 찾을 수 없음, 중단");
        resetRetryState();
        return;
    }

    if ($sendBtn.is(":hidden") || $sendBtn.hasClass("displayNone")) {
        retryState.timer = setTimeout(retryLastAction, 500);
        return;
    }

    log("전송 버튼 클릭(대체), 시도 #", retryState.count);
    retryState.programmaticClick = true;
    $sendBtn.trigger("click");
    // GENERATION_STARTED 이벤트가 클릭 직후 비동기로 늦게 뜰 수 있으므로
    // 스와이프 쪽과 동일하게 약간의 유예를 두고 플래그를 해제한다
    setTimeout(() => { retryState.programmaticClick = false; }, 800);
}

function hookToastr() {
    const originalError = toastr.error.bind(toastr);
    toastr.error = function (message, title, options) {
        try {
            const combined = `${title || ""} ${message || ""}`;
            if (settings.enabled && matchesPattern(combined)) {
                log("오류 패턴 감지:", combined);
                // 즉시 재시도하지 않는다. 이 오류가 본 채팅 생성에서 난 건지,
                // 아니면 번역기/사이드채팅 등 백그라운드 확장에서 난 건지 아직 알 수 없다.
                // 본 채팅 생성이 진행 중일 때만 대기 표시를 남기고, 실제 판단은
                // 본 채팅 생성이 끝나는 GENERATION_ENDED 시점에 "정상 응답을 못 받았는가?"로 한다.
                if (mainGenInFlight) {
                    pendingError = true;
                    pendingErrorGenerationSerial = activeMainGenerationSerial;
                    pendingErrorAt = Date.now();
                    log("오류 대기 표시 → 본 채팅 생성 종료 시 재시도 여부 판단");
                } else {
                    log("본 채팅 생성 진행 중 아님 → 백그라운드 오류로 보고 무시");
                }
            }
        } catch (e) {
            console.error("[429die] 훅 오류:", e);
        }
        return originalError(message, title, options);
    };
}

function onMessageReceived() {
    // 정상 응답을 받았음 → 이번 생성은 성공. 대기 중이던 오류(백그라운드 오류)는 무효화.
    gotMessageThisGen = true;
    clearPendingErrorState();

    if (retryState.active) {
        log("생성 성공, 재시도 루프 종료");
        popup("success", "응답을 받았습니다. 자동 재시도를 종료합니다.");
        resetRetryState();
    }
    // 성공했으니 다음 오류에 오작동하지 않도록 본채팅 생성 상태 전체 초기화
    clearMainGenerationState();
}

function onGenerationEnded(type) {
    // 본 채팅 생성이 끝났다. 이번 생성에서 정상 응답을 못 받았는데(gotMessageThisGen=false)
    // 오류가 대기 중이면(pendingError) → 본 채팅 생성이 실패한 것으로 보고 재시도한다.
    // 백그라운드 확장(번역기/사이드채팅)의 오류는 본 채팅 생성을 실패시키지 않으므로,
    // 그 경우엔 정상 응답이 와서(onMessageReceived) gotMessageThisGen=true가 되어 재시도하지 않는다.
    if (retryState.stoppingGeneration) return; // 우리가 멈춘 경우는 제외
    if (type === "quiet") return; // 백그라운드 quiet 생성 종료는 본채팅 상태와 무관
    if (!mainGenInFlight || activeMainGenerationSerial === null) {
        log("추적 중인 본채팅 생성 없음 → 종료 이벤트 무시");
        return;
    }

    const errorAge = pendingErrorAt > 0 ? Date.now() - pendingErrorAt : Infinity;
    const errorBelongsToThisGeneration = pendingError
        && mainGenInFlight
        && activeMainGenerationSerial !== null
        && pendingErrorGenerationSerial === activeMainGenerationSerial
        && errorAge >= 0
        && errorAge <= CONFIG.errorToEndWindow;
    const failed = errorBelongsToThisGeneration && !gotMessageThisGen;
    const wasPending = pendingError;
    const retryType = lastGenerationType;

    // 성공·실패 여부와 관계없이 종료된 생성 상태는 반드시 닫는다.
    // 실패로 확정된 경우에만 재시도 종류(전송/스와이프)를 보존한다.
    clearMainGenerationState({ preserveLastType: failed });

    if (failed) {
        lastGenerationType = retryType;
        log("본 채팅 생성이 정상 응답 없이 종료됨 + 오류 대기 → 재시도");
        scheduleRetry();
    } else if (wasPending) {
        log("오류와 종료가 같은 본채팅 생성으로 확인되지 않음 → 재시도 안 함");
    } else {
        log("본채팅 생성 종료 → 추적 상태 정리");
    }
}

function onGenerationStopped(type) {
    // 우리가 유발한 정지 이벤트면 무시 (무한루프 방지)
    if (retryState.stoppingGeneration) return;
    if (type === "quiet") return;
    if (!mainGenInFlight || activeMainGenerationSerial === null) {
        log("추적 중인 본채팅 생성 없음 → 중단 이벤트 무시");
        return;
    }

    // 주의: GENERATION_STOPPED는 사용자가 정지 버튼을 눌렀을 때뿐 아니라
    // ST가 실패한 스와이프를 되돌리는 내부 뒷정리("Swipe failed, Swiping back")에서도
    // 발생한다. 이 이벤트만으로는 둘을 구분할 수 없으므로 여기서는 재시도를
    // 중단하지 않는다. 진짜 사용자 정지는 #mes_stop 실제 클릭(originalEvent 존재)을
    // trackButtonClicks에서 감지해 처리한다.
    if (retryState.active) {
        log("생성 중단 이벤트 감지 — 재시도 유지 (ST 내부 뒷정리일 수 있음)");
        return;
    }

    // 일반 본채팅의 수동 중단은 오류 재시도로 취급하지 않는다.
    // 단, 이미 오류가 감지된 상태(pendingError)라면 이 STOPPED는 실패 뒷정리일
    // 가능성이 높으므로 상태를 지우지 않고 GENERATION_ENDED의 판단에 맡긴다.
    if (pendingError) {
        log("생성 중단 이벤트 — 오류 감지 상태이므로 종료 판단은 ENDED에 위임");
        return;
    }
    clearMainGenerationState();
    log("본채팅 생성 중단 → 재시도 없이 추적 상태 정리");
}

function onGenerationStarted(type, params, dryRun) {
    // 드라이런(토큰 계산·프롬프트 재계산용 가짜 생성)은 실제 생성이 아님.
    // ST는 GENERATION_STARTED의 세 번째 인자로 dryRun 여부를 넘겨준다.
    // 이걸 무시하면 재시도 대기 중에 드라이런이 끼어들 때마다
    // "사용자가 새로 전송함"으로 착각해 재시도를 죽이게 된다.
    if (dryRun) {
        log(`드라이런 생성 감지(type=${type}) → 무시`);
        return;
    }
    // 이 생성이 방금 우리가 시작한 재시도라면 사용자 액션으로 취급하지 않는다.
    // programmaticClick 가드보다 먼저 소비해야, 빨리 도착하든(800ms 이내)
    // QR 큐잉·슬래시 커맨드 지연으로 늦게 도착하든 마커가 항상 정리된다.
    if (retryState.active && consumeRetryStartMarker()) {
        log(`자동 재시도로 시작된 생성 확인(type=${type}) → 재시도 유지`);
        return;
    }
    // 우리가 재시도용으로 스스로 트리거한 생성이면 무시 (무한루프 방지)
    if (retryState.programmaticClick) return;
    // 중단 직후 쿨다운 창 안이면 ST의 자동 동작일 수 있어 무시
    if (retryState.manuallyStopped && Date.now() < retryState.suppressUntil) return;
    // 백그라운드용 quiet 생성(요약 등)은 사용자의 실제 액션이 아니므로 추적하지 않음
    // (참고: generateRaw 기반 사이드채팅 등은 GENERATION_STARTED 자체를 발생시키지 않음)
    if (type === "quiet") return;

    // 버튼 클릭이든, 빠른답장(QR)/슬래시 커맨드든 어떤 경로로 본 채팅 생성이 시작됐든
    // 여기서 잡아준다. generateRaw 백그라운드 생성은 이 이벤트를 안 내므로 안전.
    if (retryState.active) {
        stopRetrying(type === "swipe" ? "사용자가 새로 스와이프함" : "사용자가 새로 전송함");
    }
    retryState.manuallyStopped = false; // 사용자의 진짜 새 액션 → 래치 해제
    retryState.suppressUntil = 0;
    beginMainGeneration(type);
    log(`생성 시작 감지(type=${type}) → 타입: ${lastGenerationType}`);
}

function trackButtonClicks() {
    // 배지(✕) 클릭/터치로 중단 — document 델리게이션이라 배지가 다시 그려져도 항상 동작
    $(document).on("click pointerdown", "#die429_indicator", (e) => {
        e.preventDefault();
        e.stopPropagation();
        stopRetrying("사용자가 클릭하여 중단함", { stopGeneration: true });
    });

    // 정지 버튼(#mes_stop)을 "진짜 사용자"가 눌렀을 때만 재시도 중단.
    // ST가 실패한 스와이프 뒷정리로 스스로 트리거하는 가짜 클릭(jQuery trigger)은
    // originalEvent가 없으므로 여기서 걸러진다.
    $(document).on("click", "#mes_stop", (e) => {
        if (retryState.programmaticClick) return;      // 우리가 누른 정지는 무시
        if (!e.originalEvent) return;                   // 코드가 만든 가짜 클릭은 무시
        if (retryState.active) {
            stopRetrying("사용자가 생성을 중단함");
        }
        clearMainGenerationState();
    });

    // 전송 버튼 클릭 감지 (사용자가 직접 누른 경우만)
    $(document).on("click", "#send_but", () => {
        if (retryState.programmaticClick) return; // 자동 재시도 클릭은 무시
        // 중단 직후 쿨다운 창 안의 클릭은 ST의 자동 동작일 수 있어 무시
        if (retryState.manuallyStopped && Date.now() < retryState.suppressUntil) return;
        if (retryState.active) stopRetrying("사용자가 새로 전송함");
        retryState.manuallyStopped = false; // 사용자의 진짜 새 액션 → 래치 해제
        retryState.suppressUntil = 0;
        lastGenerationType = "normal";
        log("전송 버튼 클릭 감지 → 타입: normal");
    });

    // 스와이프 버튼 클릭 감지 (동적 요소라 delegation 사용)
    $(document).on("click", ".swipe_right", () => {
        if (retryState.programmaticClick) return; // 자동 재시도 클릭은 무시
        // 중단 직후 쿨다운 창 안의 클릭은 ST의 자동 스와이프 되돌리기일 수 있어 무시
        if (retryState.manuallyStopped && Date.now() < retryState.suppressUntil) return;
        if (retryState.active) stopRetrying("사용자가 새로 스와이프함");
        retryState.manuallyStopped = false; // 사용자의 진짜 새 액션 → 래치 해제
        retryState.suppressUntil = 0;
        lastGenerationType = "swipe";
        log("스와이프 버튼 클릭 감지 → 타입: swipe");
    });
}

function bindEvents() {
    if (typeof eventSource === "undefined" || !event_types) {
        log("eventSource를 찾을 수 없어 이벤트 바인딩 생략");
        return;
    }
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    if (event_types.GENERATION_ENDED) {
        eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);
    }
    if (event_types.GENERATION_STOPPED) {
        eventSource.on(event_types.GENERATION_STOPPED, onGenerationStopped);
    }
    if (event_types.GENERATION_STARTED) {
        // 전송 버튼 클릭이 아니라 빠른답장/슬래시 커맨드 등으로 생성이 시작돼도 놓치지 않기 위한 감지
        eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    }
}

function addSettingsUI() {
    const html = `
    <div class="die429-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>429die</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label">
                    <input id="die429_enabled" type="checkbox" ${settings.enabled ? "checked" : ""}>
                    <span>활성화</span>
                </label>
                <label>재시도할 오류 범위
                    <select id="die429_mode" class="text_pole">
                        <option value="safe" ${settings.catchMode === "safe" ? "selected" : ""}>안전 모드 (권장) — 서버 과부하·타임아웃·검열 등 재시도로 풀릴 만한 오류만</option>
                        <option value="all" ${settings.catchMode === "all" ? "selected" : ""}>모든 오류 — 어떤 오류든 무조건 재시도</option>
                    </select>
                </label>
                <div id="die429_mode_warning" class="die429-warning" style="display:${settings.catchMode === "all" ? "block" : "none"};">
                    ⚠️ '모든 오류' 모드는 API 키 오류, 잘못된 요청, 잔액 부족처럼 <b>다시 시도해도 절대 풀리지 않는 오류</b>까지 계속 재시도합니다. 헛되이 요청이 반복되거나 최악의 경우 키가 일시 차단될 수 있으니, 특별한 이유가 없다면 '안전 모드'를 쓰는 걸 권장해요.
                </div>
                <label>최대 시도 횟수 (0 = 무제한)
                    <input id="die429_max" type="number" min="0" value="${settings.maxRetries}" class="text_pole">
                </label>
                <label class="checkbox_label">
                    <input id="die429_badge" type="checkbox" ${settings.showBadge ? "checked" : ""}>
                    <span>재시도 중 화면에 표시 (429 배지)</span>
                </label>
                <label class="checkbox_label">
                    <input id="die429_popup" type="checkbox" ${settings.showPopup ? "checked" : ""}>
                    <span>알림 팝업 표시 (종료/성공 안내)</span>
                </label>
                <div class="die429-preview-wrap">
                    <input id="die429_preview" type="button" class="menu_button" value="배지 미리보기 (5초)">
                    <input id="die429_bgtest" type="button" class="menu_button" value="백그라운드 오류 무시 테스트">
                    <input id="die429_logbtn" type="button" class="menu_button" value="로그 보기">
                </div>
                <div id="die429_logwrap" style="display:none;">
                    <textarea id="die429_logview" class="text_pole" rows="10" readonly
                        style="font-size:11px; font-family:monospace; white-space:pre; overflow:auto;"></textarea>
                    <div class="die429-preview-wrap" style="margin-top:6px;">
                        <input id="die429_logcopy" type="button" class="menu_button" value="로그 복사">
                        <input id="die429_logrefresh" type="button" class="menu_button" value="새로고침">
                        <input id="die429_logclear" type="button" class="menu_button" value="지우기">
                    </div>
                </div>
            </div>
        </div>
    </div>`;

    $("#extensions_settings").append(html);

    function renderLogView() {
        const text = logBuffer.length ? logBuffer.join("\n") : "(아직 기록된 로그가 없습니다)";
        const $view = $("#die429_logview");
        $view.val(text);
        // 항상 맨 아래(최신 로그)로 스크롤
        const el = $view[0];
        if (el) el.scrollTop = el.scrollHeight;
    }

    $("#die429_logbtn").on("click", function () {
        const $wrap = $("#die429_logwrap");
        const opening = $wrap.is(":hidden");
        $wrap.toggle();
        $(this).val(opening ? "로그 닫기" : "로그 보기");
        if (opening) renderLogView();
    });

    $("#die429_logrefresh").on("click", renderLogView);

    $("#die429_logclear").on("click", function () {
        logBuffer.length = 0;
        renderLogView();
    });

    $("#die429_logcopy").on("click", function () {
        const text = logBuffer.join("\n");
        const done = () => toastr.success("로그가 클립보드에 복사되었습니다.", "429die");
        const fail = () => {
            // 클립보드 API 실패 시 textarea 선택 방식으로 대체
            const el = $("#die429_logview")[0];
            if (el) {
                el.removeAttribute("readonly");
                el.select();
                el.setSelectionRange(0, text.length);
                try { document.execCommand("copy"); done(); }
                catch { toastr.warning("복사 실패 — 텍스트를 길게 눌러 직접 복사해주세요.", "429die"); }
                el.setAttribute("readonly", "readonly");
            }
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done).catch(fail);
        } else {
            fail();
        }
    });

    $("#die429_preview").on("click", function () {
        showDemoBadge();
    });

    $("#die429_bgtest").on("click", function () {
        const result = runBackgroundErrorTest();
        // 테스트 자체가 가짜 429 토스트를 띄우므로, 결과는 살짝 늦게 띄워 구분되게 함
        setTimeout(() => {
            if (result.ok) toastr.success(result.msg, "429die 테스트");
            else toastr.warning(result.msg, "429die 테스트");
        }, 600);
    });

    $("#die429_enabled").on("change", function () {
        settings.enabled = $(this).is(":checked");
        if (!settings.enabled) stopRetrying("비활성화됨", { stopGeneration: true });
        saveSettingsDebounced();
    });
    $("#die429_mode").on("change", function () {
        settings.catchMode = $(this).val();
        $("#die429_mode_warning").css("display", settings.catchMode === "all" ? "block" : "none");
        saveSettingsDebounced();
    });
    $("#die429_max").on("input", function () {
        settings.maxRetries = Number($(this).val()) || 0;
        saveSettingsDebounced();
    });
    $("#die429_badge").on("change", function () {
        settings.showBadge = $(this).is(":checked");
        updateIndicator();
        saveSettingsDebounced();
    });
    $("#die429_popup").on("change", function () {
        settings.showPopup = $(this).is(":checked");
        saveSettingsDebounced();
    });
}

// 피치 위스퍼처럼 본채팅 밖에서 발생한 429 오류가 429die에 잡히는지
// 실제 메시지 전송 없이 확인하는 드라이런 테스트.
// 제보 상황과 동일하게: 이전 본채팅이 끝난 뒤 백그라운드 확장에서
// 429 토스트가 떠도 이전 생성 상태와 결합되지 않는지 검증한다.
function runBackgroundErrorTest() {
    if (!settings.enabled) {
        return { ok: false, msg: "429die가 꺼져 있습니다. 확장을 켠 뒤 다시 실행해주세요." };
    }
    if (mainGenInFlight || retryState.active) {
        return { ok: false, msg: "현재 생성 또는 자동 재시도가 진행 중입니다. 끝난 뒤 다시 실행해주세요." };
    }

    const snapshot = {
        lastGenerationType,
        mainGenInFlight,
        pendingError,
        gotMessageThisGen,
        mainGenerationSerial,
        activeMainGenerationSerial,
        pendingErrorGenerationSerial,
        pendingErrorAt,
    };

    try {
        // 1) 오류 없이 끝난 이전 본채팅을 만든다.
        // 구버전은 이 종료 뒤 mainGenInFlight가 true로 남을 수 있었다.
        beginMainGeneration("normal");
        onGenerationEnded();

        // 2) 본채팅 유휴 상태에서 피치 위스퍼의 백그라운드 429를 재현한다.
        toastr.error(
            "429 Too Many Requests (강제 백그라운드 테스트)",
            "Peach Whisper 테스트",
        );

        // 올바른 동작: 이전 생성 상태가 닫혀 있고, 오류 대기·재시도가 없어야 한다.
        const misclassified = mainGenInFlight || pendingError || retryState.active;
        if (misclassified) {
            log("❌ 종료된 본채팅 상태와 백그라운드 오류가 결합됨 (드라이런, 실제 재시도 없음)");
            return { ok: false, msg: "테스트 실패: 종료된 본채팅 상태와 백그라운드 429 오류가 결합됐습니다." };
        }

        log("✅ 종료 상태 정리 및 백그라운드 오류 무시 확인 (드라이런)");
        return { ok: true, msg: "테스트 통과: 끝난 본채팅 상태를 정리했고 백그라운드 429 오류를 무시했습니다." };
    } finally {
        lastGenerationType = snapshot.lastGenerationType;
        mainGenInFlight = snapshot.mainGenInFlight;
        pendingError = snapshot.pendingError;
        gotMessageThisGen = snapshot.gotMessageThisGen;
        mainGenerationSerial = snapshot.mainGenerationSerial;
        activeMainGenerationSerial = snapshot.activeMainGenerationSerial;
        pendingErrorGenerationSerial = snapshot.pendingErrorGenerationSerial;
        pendingErrorAt = snapshot.pendingErrorAt;
    }
}

function registerSlashCommands() {
    try {
        const ctx = (window.SillyTavern && window.SillyTavern.getContext)
            ? window.SillyTavern.getContext()
            : null;
        if (!ctx) {
            log("getContext 없음, 슬래시 커맨드 등록 생략");
            return;
        }

        const badgeHandler = () => {
            showDemoBadge();
            return "429die 테스트 배지를 5초간 표시합니다.";
        };

        // 피치 위스퍼처럼 본채팅 밖에서 발생한 429 오류가 429die에 잡히는지
        // 실제 메시지 전송 없이 확인하는 드라이런 테스트 (본체는 runBackgroundErrorTest).
        const backgroundErrorHandler = () => runBackgroundErrorTest().msg;

        // 신형 API 우선, 없으면 구형 API로 대체
        if (ctx.SlashCommandParser && ctx.SlashCommand && ctx.SlashCommandParser.addCommandObject) {
            ctx.SlashCommandParser.addCommandObject(ctx.SlashCommand.fromProps({
                name: "429test",
                callback: badgeHandler,
                helpString: "429die 배지가 화면에 어떻게 뜨는지 테스트로 표시합니다.",
            }));
            ctx.SlashCommandParser.addCommandObject(ctx.SlashCommand.fromProps({
                name: "429bgtest",
                callback: backgroundErrorHandler,
                helpString: "피치 위스퍼 같은 백그라운드 429 오류 오인 여부를 실제 재시도 없이 테스트합니다.",
            }));
            log("슬래시 커맨드 /429test 등록됨 (신형 API)");
            log("슬래시 커맨드 /429bgtest 등록됨 (신형 API)");
        } else if (typeof ctx.registerSlashCommand === "function") {
            ctx.registerSlashCommand("429test", badgeHandler, [], "429die 배지 테스트 표시", true, true);
            ctx.registerSlashCommand("429bgtest", backgroundErrorHandler, [], "백그라운드 429 오류 오인 여부 드라이런 테스트", true, true);
            log("슬래시 커맨드 /429test 등록됨 (구형 API)");
            log("슬래시 커맨드 /429bgtest 등록됨 (구형 API)");
        } else {
            log("슬래시 커맨드 API를 찾을 수 없음");
        }
    } catch (e) {
        console.error("[429die] 슬래시 커맨드 등록 실패:", e);
    }
}

jQuery(async () => {
    settings = loadSettings();
    hookToastr();
    bindEvents();
    trackButtonClicks();
    addSettingsUI();
    registerSlashCommands();
    log("확장 로드 완료");
});
