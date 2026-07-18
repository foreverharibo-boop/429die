import { extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types } from "../../../../script.js";

const EXT_ID = "429die";

// 켜고 끄는 것 외에는 UI로 노출하지 않는 고정값
const CONFIG = {
    retryDelay: 3000,        // ms
    backoffMultiplier: 1.5,  // 재시도마다 딜레이 증가
    maxDelay: 20000,         // 백오프 상한선
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
let retryState = {
    active: false,
    count: 0,
    timer: null,
    programmaticClick: false,
    suppressUntil: 0,
    manuallyStopped: false,
};

function log(...args) {
    console.log("[429die]", ...args);
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
        // MovingUI가 body에 transform을 걸면 position:fixed가 깨지므로 html에 붙인다
        $("html").append($ind);
    }
    $ind.text(text);
}

function resetRetryState() {
    retryState.active = false;
    retryState.count = 0;
    lastGenerationType = null;
    if (retryState.timer) {
        clearTimeout(retryState.timer);
        retryState.timer = null;
    }
    updateIndicator();
}

function stopSTGeneration() {
    // ST에서 진행 중인 생성을 정지시킨다
    try {
        const ctx = (window.SillyTavern && window.SillyTavern.getContext)
            ? window.SillyTavern.getContext()
            : null;
        // 1) 정식 API가 있으면 그걸 사용
        if (ctx && typeof ctx.stopGeneration === "function") {
            ctx.stopGeneration();
        }
    } catch (e) {
        console.error("[429die] stopGeneration 호출 실패:", e);
    }
    // 2) 화면의 정지 버튼도 눌러준다 (있을 때만)
    const $stop = $("#mes_stop");
    if ($stop.length && $stop.is(":visible")) {
        retryState.programmaticClick = true;
        $stop.trigger("click");
        setTimeout(() => { retryState.programmaticClick = false; }, 300);
    }
}

function stopRetrying(reason) {
    if (retryState.active) {
        log("중단:", reason);
        popup("info", `자동 재시도를 종료했습니다. (${reason})`);
    }
    // 중단 래치: 사용자가 직접 새 액션(전송/스와이프)을 하기 전까지
    // ST의 자동 스와이프 되돌리기 등으로 재시도가 되살아나지 않게 완전 차단
    retryState.manuallyStopped = true;
    retryState.suppressUntil = Date.now() + 3000;
    // 진행 중인 ST 생성도 멈춘다 (안 그러면 이미 시작된 재생성이 끝까지 진행됨)
    stopSTGeneration();
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

    if (lastGenerationType === "swipe") {
        clickSwipeButton();
    } else {
        clickSendButton();
    }
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

    log("전송 버튼 클릭, 시도 #", retryState.count);
    retryState.programmaticClick = true;
    $sendBtn.trigger("click");
    retryState.programmaticClick = false;
}

function hookToastr() {
    const originalError = toastr.error.bind(toastr);
    toastr.error = function (message, title, options) {
        try {
            const combined = `${title || ""} ${message || ""}`;
            if (settings.enabled && matchesPattern(combined)) {
                log("오류 패턴 감지:", combined);
                scheduleRetry();
            }
        } catch (e) {
            console.error("[429die] 훅 오류:", e);
        }
        return originalError(message, title, options);
    };
}

function onMessageReceived() {
    if (retryState.active) {
        log("생성 성공, 재시도 루프 종료");
        popup("success", "응답을 받았습니다. 자동 재시도를 종료합니다.");
        resetRetryState();
    }
    // 성공했으니 다음 오류에 오작동하지 않도록 초기화
    lastGenerationType = null;
}

function onGenerationStopped() {
    if (retryState.active) {
        stopRetrying("생성이 수동으로 중단됨");
    }
}

function trackButtonClicks() {
    // 배지(✕) 클릭/터치로 중단 — document 델리게이션이라 배지가 다시 그려져도 항상 동작
    $(document).on("click pointerdown", "#die429_indicator", (e) => {
        e.preventDefault();
        e.stopPropagation();
        stopRetrying("사용자가 클릭하여 중단함");
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
    if (event_types.GENERATION_STOPPED) {
        eventSource.on(event_types.GENERATION_STOPPED, onGenerationStopped);
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
            </div>
        </div>
    </div>`;

    $("#extensions_settings").append(html);

    $("#die429_enabled").on("change", function () {
        settings.enabled = $(this).is(":checked");
        if (!settings.enabled) stopRetrying("비활성화됨");
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

jQuery(async () => {
    settings = loadSettings();
    hookToastr();
    bindEvents();
    trackButtonClicks();
    addSettingsUI();
    log("확장 로드 완료");
});
