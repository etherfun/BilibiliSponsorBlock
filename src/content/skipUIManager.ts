import Config from "../config";
import SkipNotice from "../render/SkipNotice";
import advanceSkipNotice from "../render/advanceSkipNotice";
import { SponsorTime } from "../types";
import { waitFor } from "../utils/";
import { getContentApp } from "./app";
import { CONTENT_EVENTS } from "./app/events";
import { contentState } from "./state";
import { getSkipNoticeContentContainer } from "./skipNoticeContentContainer";

function getSkipButtonControlBar() {
    return getContentApp().ui.getState().skipButtonControlBar;
}

function createSkipNotice(
    skippingSegments: SponsorTime[],
    autoSkip: boolean,
    unskipTime: number | null | undefined,
    startReskip: boolean
): void {
    for (const skipNotice of contentState.skipNotices) {
        if (
            skippingSegments.length === skipNotice.segments.length &&
            skippingSegments.every((segment) => skipNotice.segments.some((existingSegment) => existingSegment.UUID === segment.UUID))
        ) {
            return;
        }
    }

    const advanceSkipNoticeShow = !!contentState.advanceSkipNotices;
    const newSkipNotice = new SkipNotice(
        skippingSegments,
        autoSkip,
        getSkipNoticeContentContainer,
        () => {
            contentState.advanceSkipNotices?.close();
            contentState.advanceSkipNotices = null;
        },
        unskipTime ?? null,
        startReskip,
        advanceSkipNoticeShow
    );
    if (Config.config.skipKeybind == null) newSkipNotice.setShowKeybindHint(false);
    contentState.skipNotices.push(newSkipNotice);

    contentState.activeSkipKeybindElement?.setShowKeybindHint(false);
    contentState.activeSkipKeybindElement = newSkipNotice;
}

function createAdvanceSkipNotice(
    skippingSegments: SponsorTime[],
    unskipTime: number | null | undefined,
    autoSkip: boolean,
    startReskip: boolean
): void {
    if (contentState.advanceSkipNotices && !contentState.advanceSkipNotices.closed && contentState.advanceSkipNotices.sameNotice(skippingSegments)) {
        return;
    }

    contentState.advanceSkipNotices?.close();
    contentState.advanceSkipNotices = new advanceSkipNotice(
        skippingSegments,
        getSkipNoticeContentContainer,
        unskipTime ?? null,
        autoSkip,
        startReskip
    );
    if (Config.config.skipKeybind == null) contentState.advanceSkipNotices.setShowKeybindHint(false);

    contentState.activeSkipKeybindElement?.setShowKeybindHint(false);
    contentState.activeSkipKeybindElement = contentState.advanceSkipNotices;
}

function applySkipButtonState(enabled: boolean, segment: SponsorTime | null, duration?: number): void {
    if (!enabled || !segment) {
        const skipButtonControlBar = getSkipButtonControlBar();
        skipButtonControlBar?.disable();
        if (skipButtonControlBar && contentState.activeSkipKeybindElement === skipButtonControlBar) {
            contentState.activeSkipKeybindElement = null;
        }
        return;
    }

    void waitFor(() => getSkipButtonControlBar(), 5000, 10)
        .then((skipButtonControlBar) => {
            if (!skipButtonControlBar) {
                return;
            }

            skipButtonControlBar.enable(segment, duration);
            skipButtonControlBar.setShowKeybindHint(Config.config.skipKeybind != null);

            contentState.activeSkipKeybindElement?.setShowKeybindHint(false);
            contentState.activeSkipKeybindElement = skipButtonControlBar;
        })
        .catch(() => undefined);
}

export function registerSkipUIManager(): void {
    const app = getContentApp();

    app.bus.on(CONTENT_EVENTS.SKIP_NOTICE_REQUESTED, ({ noticeKind, skippingSegments, autoSkip, unskipTime, startReskip }) => {
        if (noticeKind === "advance") {
            createAdvanceSkipNotice(skippingSegments, unskipTime, autoSkip, startReskip);
            return;
        }

        createSkipNotice(skippingSegments, autoSkip, unskipTime, startReskip);
    });

    app.bus.on(CONTENT_EVENTS.SKIP_BUTTON_STATE_CHANGED, ({ enabled, segment, duration }) => {
        applySkipButtonState(enabled, segment, duration);
    });
}
