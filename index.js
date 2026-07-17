import { extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types } from "../../../../script.js";

const EXT_ID = "429die";

// 켜고 끄는 것 외에는 UI로 노출하지 않는 고정값
const CONFIG = {
    retryDelay: 3000,        // ms
    backoffMultiplier: 1.5,  // 재시도마다 딜레이 증가
    maxDelay: 20000,         // 백오프 상한선
    patterns: [
        "resource exhausted",
        "error-code-429",
        "429",
        "please try again later",
        "overloaded",
        "internal server error",
        "503",
        "502",
        "bad gateway",
    ],
};

let settings;
let lastGenerationType = null;
let retryState = {
    active: false,
    count: 0,
    timer: null,
};

function log(...args) {
    console.log("[429die]", ...args);
}

function loadSettings() {
    if (!extension_settings[EXT_ID]) {
        extension_settings[EXT_ID] = { enabled: true, maxRetries: 20 };
    }
    if (extension_settings[EXT_ID].enabled === undefined) {
        extension_settings[EXT_ID].enabled = true;
    }
    if (extension_settings[EXT_ID].maxRetries === undefined) {
        extension_settings[EXT_ID].maxRetries = 20;
    }
    return extension_settings[EXT_ID];
}

function matchesPattern(message) {
    if (!message) return false;
    const lower = String(message).toLowerCase();
    return CONFIG.patterns.some((p) => p && lower.includes(p.toLowerCase()));
}

function resetRetryState() {
    retryState.active = false;
    retryState.count = 0;
    lastGenerationType = null;
    if (retryState.timer) {
        clearTimeout(retryState.timer);
        retryState.timer = null;
    }
}

function stopRetrying(reason) {
    if (retryState.active) {
        log("중단:", reason);
    }
    resetRetryState();
}

function scheduleRetry() {
    if (!settings.enabled) return;
    if (lastGenerationType === null) {
        log("유저가 아직 아무 버튼도 누르지 않음, 재시도 스킵");
        return;
    }

    if (settings.maxRetries > 0 && retryState.count >= settings.maxRetries) {
        log(`최대 재시도 횟수(${settings.maxRetries}회) 도달`);
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
    const $swipeBtn = $("#chat").find(".mes").last().find(".swipe_right");
    if ($swipeBtn.length === 0) {
        log("스와이프 버튼을 찾을 수 없음, 전송 버튼으로 대체");
        clickSendButton();
        return;
    }
    log("스와이프 버튼 클릭, 시도 #", retryState.count);
    $swipeBtn.trigger("click");
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
    $sendBtn.trigger("click");
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
    // 전송 버튼 클릭 감지
    $(document).on("click", "#send_but", () => {
        if (!retryState.active) {
            lastGenerationType = "normal";
            log("전송 버튼 클릭 감지 → 타입: normal");
        }
    });

    // 스와이프 버튼 클릭 감지 (동적 요소라 delegation 사용)
    $(document).on("click", ".swipe_right", () => {
        if (!retryState.active) {
            lastGenerationType = "swipe";
            log("스와이프 버튼 클릭 감지 → 타입: swipe");
        }
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
                <label>최대 시도 횟수 (0 = 무제한)
                    <input id="die429_max" type="number" min="0" value="${settings.maxRetries}" class="text_pole">
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
    $("#die429_max").on("input", function () {
        settings.maxRetries = Number($(this).val()) || 0;
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
