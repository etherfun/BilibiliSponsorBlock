import Config from "./config";
import { createContentApp } from "./content/app";
import { CONTENT_EVENTS } from "./content/app/events";
import {
    getPreviewBar,
    registerPreviewBarManager,
    removeDurationAfterSkip,
} from "./content/previewBarManager";
import {
    registerSegmentSubmission,
    resetSubmissionState,
    getCategoryPill,
    getSkipButtonControlBar,
} from "./content/segmentSubmission";
import { registerSkipUIManager } from "./content/skipUIManager";
import {
    contentState,
    getPageLoaded,
    setupPageLoadingListener,
    syncContentStateStore,
} from "./content/state";
import {
    registerSkipScheduler,
    resetSchedulerState,
    resetSponsorSkipped,
} from "./content/skipScheduler";
import { setupMessageListener } from "./content/messageHandler";
import { addHotkeyListener } from "./content/hotkeyHandler";
import { resetVideoListenerState, setupVideoListeners } from "./content/videoListeners";
import { DynamicListener, CommentListener } from "./render/DynamicAndCommentSponsorBlock";
import { setMessageNotice } from "./render/MessageNotice";
import { checkPageForNewThumbnails, setupThumbnailListener } from "./thumbnail-utils/thumbnailManagement";
import {
    ChannelIDInfo,
    ChannelIDStatus,
    PageType,
} from "./types";
import { waitFor } from "./utils/";
import { cleanPage } from "./utils/cleanup";
import { GenericUtils } from "./utils/genericUtils";
import { logDebug } from "./utils/logger";
import { getControls, getProgressBar } from "./utils/pageUtils";
import {
    detectPageType,
    getPageType,
    getVideo,
    getVideoID,
    setupVideoModule,
} from "./utils/video";

const app = createContentApp();
let lifecycleRegistered = false;

setupPageLoadingListener();
detectPageType();
syncContentStateStore("content.bootstrap");

if (getPageType() === PageType.Unsupported || getPageType() === PageType.Live) {
    logDebug(`Skipping content initialization on unsupported page: ${window.location.href}`);
} else {
    init();
}



function init(): void {
    cleanPage();

    if (!lifecycleRegistered) {
        lifecycleRegistered = true;
        app.bus.on(CONTENT_EVENTS.VIDEO_RESET_REQUESTED, () => resetValues());
        app.bus.on(CONTENT_EVENTS.VIDEO_ID_CHANGED, () => {
            void videoIDChange();
        });
        app.bus.on(CONTENT_EVENTS.VIDEO_CHANNEL_RESOLVED, ({ channelIDInfo }) => {
            void channelIDChange(channelIDInfo);
        });
        app.bus.on(CONTENT_EVENTS.CHANNEL_WHITELIST_CHANGED, ({ videoID, whitelisted, reason }) => {
            if (videoID !== getVideoID()) {
                return;
            }

            if (reason === "popupToggle") {
                void app.commands.execute("segments/lookup", {});
                return;
            }

            if (reason === "channelResolved" && whitelisted && Config.config.forceChannelCheck && contentState.sponsorTimes?.length > 0) {
                void app.commands.execute("skip/checkStartSponsors", undefined);
            }
        });
        app.bus.on(CONTENT_EVENTS.VIDEO_ELEMENT_CHANGED, ({ newVideo, video }) => {
            videoElementChange(newVideo, video);
        });
    }

    registerPreviewBarManager();
    registerSegmentSubmission();
    registerSkipUIManager();
    registerSkipScheduler();
    app.commands.register("config/applyCategoryColors", () => setCategoryColorCSSVariables());

    waitFor(() => Config.isReady(), 5000, 10).then(() => {
        setCategoryColorCSSVariables();

        if (
            [PageType.Dynamic, PageType.Channel].includes(detectPageType()) &&
            (Config.config.dynamicAndCommentSponsorBlocker && Config.config.dynamicSponsorBlock)
        ) {
            DynamicListener();
        }

        if (
            [PageType.Video, PageType.List, PageType.Dynamic, PageType.Channel, PageType.Opus, PageType.Festival].includes(getPageType()) &&
            (Config.config.dynamicAndCommentSponsorBlocker && Config.config.commentSponsorBlock)
        ) {
            CommentListener();
        }
    });

    if (
        (document.hidden && getPageType() == PageType.Video) ||
        [PageType.Video, PageType.Festival].includes(getPageType())
    ) {
        document.addEventListener("visibilitychange", () => videoElementChange(true, getVideo()), { once: true });
        window.addEventListener("mouseover", () => videoElementChange(true, getVideo()), { once: true });
    }

    setupVideoModule();

    waitFor(() => getPageLoaded(), 10000, 100).then(setupThumbnailListener);

    setMessageNotice(false, getPageLoaded);

    addHotkeyListener();
    setupMessageListener();
}

function resetValues() {
    resetVideoListenerState();
    resetSchedulerState();
    resetSubmissionState();

    contentState.previewedSegment = false;
    contentState.sponsorTimes = [];
    resetSponsorSkipped();
    contentState.lastResponseStatus = 0;
    contentState.shownSegmentFailedToFetchWarning = false;

    contentState.videoInfo = null;
    contentState.channelWhitelisted = false;
    contentState.lockedCategories = [];

    if (getPreviewBar() !== null) {
        getPreviewBar().clear();
    }

    removeDurationAfterSkip();
    contentState.sponsorDataFound = false;

    if (contentState.switchingVideos === null) {
        contentState.switchingVideos = false;
    } else {
        contentState.switchingVideos = true;
        logDebug("Setting switching videos to true (reset data)");
    }

    app.ui.patchState({
        selectedSegment: null,
        lastPreviewBarUpdate: null,
    });

    getSkipButtonControlBar()?.disable();
    getCategoryPill()?.resetSegment();

    for (let i = 0; i < contentState.skipNotices.length; i++) {
        contentState.skipNotices.pop()?.close();
    }

    if (contentState.advanceSkipNotices) {
        contentState.advanceSkipNotices.close();
        contentState.advanceSkipNotices = null;
    }

    contentState.activeSkipKeybindElement = null;

    syncContentStateStore("content.resetValues");
}

async function videoIDChange(): Promise<void> {
    if (getPreviewBar() === null) {
        waitFor(getControls).then(() => {
            void app.commands.execute("ui/createPreviewBar", undefined);
        });
    }

    chrome.runtime.sendMessage({
        message: "videoChanged",
        videoID: getVideoID(),
        whitelisted: contentState.channelWhitelisted,
    });

    void app.commands.execute("segments/lookup", {});
    checkPageForNewThumbnails();

    contentState.sponsorTimesSubmitting = [];
    void app.commands.execute("segments/updateSubmitting", { getFromConfig: true });

    await waitFor(() => document.querySelector(".bpx-player-loading-panel.bpx-state-loading"), 5000, 5);
    await waitFor(getProgressBar, 24 * 60 * 60, 500);

    void app.commands.execute("ui/updatePlayerButtons", undefined);
    void app.commands.execute("ui/checkPreviewBarState", undefined);
    void app.commands.execute("ui/setupDescriptionPill", undefined);

    if (
        [PageType.Video, PageType.List, PageType.Dynamic, PageType.Channel, PageType.Opus, PageType.Festival].includes(getPageType()) &&
        (Config.config.dynamicAndCommentSponsorBlocker && Config.config.commentSponsorBlock)
    ) {
        CommentListener();
    }
}

async function channelIDChange(channelIDInfo: ChannelIDInfo) {
    const whitelistedChannels = Config.config.whitelistedChannels;

    if (
        whitelistedChannels != undefined &&
        channelIDInfo.status === ChannelIDStatus.Found &&
        whitelistedChannels.some((ch) => ch.id === channelIDInfo.id)
    ) {
        contentState.channelWhitelisted = true;
        syncContentStateStore("content.channelIDChange");
        app.bus.emit(
            CONTENT_EVENTS.CHANNEL_WHITELIST_CHANGED,
            {
                videoID: getVideoID(),
                whitelisted: true,
                reason: "channelResolved",
            },
            { source: "content.channelIDChange" }
        );
    }
}

function videoElementChange(newVideo: boolean, video: HTMLVideoElement | null): void {
    if (!video) {
        return;
    }

    waitFor(() => Config.isReady() && !document.hidden, 24 * 60 * 60, 500).then(() => {
        if (newVideo) {
            setupVideoListeners(video);
            void app.commands.execute("ui/setupSkipButtonControlBar", undefined);
            void app.commands.execute("ui/setupCategoryPill", undefined);
            void app.commands.execute("ui/setupDescriptionPill", undefined);
        }

        void app.commands.execute("ui/updatePreviewBar", undefined);
        void app.commands.execute("ui/checkPreviewBarState", undefined);

        setTimeout(() => void app.commands.execute("ui/checkPreviewBarState", undefined), 100);
        setTimeout(() => void app.commands.execute("ui/checkPreviewBarState", undefined), 1000);
        setTimeout(() => void app.commands.execute("ui/checkPreviewBarState", undefined), 5000);
    });
}

function setCategoryColorCSSVariables() {
    let styleContainer = document.getElementById("sbCategoryColorStyle");
    if (!styleContainer) {
        styleContainer = document.createElement("style");
        styleContainer.id = "sbCategoryColorStyle";

        const head = document.head || document.documentElement;
        head.appendChild(styleContainer);
    }

    let css = ":root {";
    for (const [category, config] of Object.entries(Config.config.barTypes).concat(Object.entries(Config.config.dynamicSponsorTypes))) {
        css += `--sb-category-${category}: ${config.color};`;
        css += `--darkreader-bg--sb-category-${category}: ${config.color};`;

        const luminance = GenericUtils.getLuminance(config.color);
        css += `--sb-category-text-${category}: ${luminance > 128 ? "black" : "white"};`;
        css += `--darkreader-text--sb-category-text-${category}: ${luminance > 128 ? "black" : "white"};`;
    }
    css += "}";

    styleContainer.innerText = css;
}
