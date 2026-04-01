import SkipNoticeComponent from "../components/SkipNoticeComponent";
import Config from "../config";
import { keybindToString } from "../config/config";
import { SkipButtonControlBar } from "../js-components/skipButtonControlBar";
import { VoteResponse } from "../messageTypes";
import { CategoryPill } from "../render/CategoryPill";
import { DescriptionPortPill } from "../render/DescriptionPortPill";
import { showMessage } from "../render/MessageNotice";
import { PlayerButton } from "../render/PlayerButton";
import SubmissionNotice from "../render/SubmissionNotice";
import { getPortVideoByHash, postPortVideo, postPortVideoVote, updatePortedSegments } from "../requests/portVideo";
import { asyncRequestToServer } from "../requests/requests";
import { getSegmentsByVideoID } from "../requests/segments";
import { FetchResponse } from "../requests/type/requestType";
import { getVideoLabel } from "../requests/videoLabels";
import {
    ActionType,
    BVID,
    Category,
    NewVideoID,
    PortVideo,
    SegmentUUID,
    SponsorHideType,
    SponsorSourceType,
    SponsorTime,
    YTID,
} from "../types";
import Utils from "../utils";
import { waitFor } from "../utils/";
import { AnimationUtils } from "../utils/animationUtils";
import { defaultPreviewTime } from "../utils/constants";
import { durationEquals } from "../utils/duraionUtils";
import { getErrorMessage, getFormattedTime } from "../utils/formating";
import { getHash, getVideoIDHash, HashedValue } from "../utils/hash";
import { getCidMapFromWindow } from "../utils/injectedScriptMessageUtils";
import { getHashParams } from "../utils/pageUtils";
import { generateUserID } from "../utils/setup";
import { getBvID, getCid, getVideo, getVideoID, waitForVideo } from "../utils/video";
import { parseBvidAndCidFromVideoId } from "../utils/videoIdUtils";
import { openWarningDialog } from "../utils/warnings";
import { getContentApp } from "./app";
import { CONTENT_EVENTS } from "./app/events";
import { seekFrameByKeyPressListener } from "./hotkeyHandler";
import { getSkipNoticeContentContainer } from "./skipNoticeContentContainer";
import { contentState, syncContentStateStore } from "./state";

const utils = new Utils();

let lookupWaiting = false;
let loadedPreloadedSegment = false;
function getUIState() {
    return getContentApp().ui.getState();
}

function patchUIState(patch: Partial<ReturnType<typeof getUIState>>): void {
    getContentApp().ui.patchState(patch);
}

function getPlayerButton(): PlayerButton {
    const app = getContentApp();
    const existingButton = app.ui.getState().playerButton;
    if (existingButton) {
        return existingButton;
    }

    const playerButton = new PlayerButton(
        () => void app.commands.execute("segment/toggleCapture", undefined),
        () => void app.commands.execute("segment/cancelCapture", undefined),
        clearSponsorTimes,
        () => void app.commands.execute("segment/openSubmissionMenu", undefined),
        () => void app.commands.execute("popup/openInfoMenu", undefined)
    );
    app.ui.patchState({ playerButton });
    return playerButton;
}

function emitSubmittingChanged(getFromConfig: boolean, source: string): void {
    syncContentStateStore(source);
    getContentApp().bus.emit(
        CONTENT_EVENTS.SEGMENTS_SUBMITTING_CHANGED,
        {
            sponsorTimesSubmitting: contentState.sponsorTimesSubmitting,
            getFromConfig,
        },
        { source }
    );
}

function emitSegmentsLoaded(source: string): void {
    syncContentStateStore(source);
    getContentApp().bus.emit(
        CONTENT_EVENTS.SEGMENTS_LOADED,
        {
            sponsorTimes: contentState.sponsorTimes,
            status: contentState.lastResponseStatus,
        },
        { source }
    );
}

export function getSkipButtonControlBar() { return getUIState().skipButtonControlBar; }
export function getCategoryPill() { return getUIState().categoryPill; }
export function getPopupInitialised() { return getUIState().popupInitialised; }
export function setPopupInitialised(v: boolean) { patchUIState({ popupInitialised: v }); }
export function getSubmissionNotice() { return getUIState().submissionNotice; }

export function resetSubmissionState(): void {
    loadedPreloadedSegment = false;
    lookupWaiting = false;
    const { submissionNotice } = getUIState();
    if (submissionNotice) {
        submissionNotice.close();
    }
    patchUIState({
        playerButtons: {},
        descriptionPill: null,
        submissionNotice: null,
        popupInitialised: false,
        skipButtonControlBar: null,
        categoryPill: null,
    });
}

export function registerSegmentSubmission(): void {
    const app = getContentApp();

    app.commands.register("segment/toggleCapture", () => startOrEndTimingNewSegment());
    app.commands.register("segment/cancelCapture", () => cancelCreatingSegment());
    app.commands.register("segment/submit", () => submitSegments());
    app.commands.register("segment/openSubmissionMenu", () => openSubmissionMenu());
    app.commands.register("segment/previewRecent", () => previewRecentSegment());
    app.commands.register("segment/isCreationInProgress", () => isSegmentCreationInProgress());
    app.commands.register("segment/getRealCurrentTime", () => getRealCurrentTime());
    app.commands.register("segment/resetSubmissionNotice", ({ callRef }) => resetSponsorSubmissionNotice(callRef));
    app.commands.register("skip/dontShowNoticeAgain", () => dontShowNoticeAgain());
    app.commands.register("segment/vote", ({ type, UUID, category, skipNotice }) => vote(type, UUID, category, skipNotice));
    app.commands.register("segment/voteAsync", ({ type, UUID, category }) => voteAsync(type, UUID, category));
    app.commands.register("segments/lookup", ({ keepOldSubmissions, ignoreServerCache, forceUpdatePreviewBar }) =>
        sponsorsLookup(keepOldSubmissions, ignoreServerCache, forceUpdatePreviewBar)
    );
    app.commands.register("segments/updateSubmitting", ({ getFromConfig }) =>
        updateSponsorTimesSubmitting(getFromConfig)
    );
    app.commands.register("segments/import", ({ importedSegments }) => importSegments(importedSegments));
    app.commands.register("ui/updatePlayerButtons", () => updateVisibilityOfPlayerControlsButton());
    app.commands.register("ui/setupSkipButtonControlBar", () => setupSkipButtonControlBar());
    app.commands.register("ui/setupCategoryPill", () => setupCategoryPill());
    app.commands.register("ui/setupDescriptionPill", () => setupDescriptionPill());
    app.commands.register("popup/openInfoMenu", () => openInfoMenu());
    app.commands.register("popup/closeInfoMenu", () => closeInfoMenu());
    app.commands.register("port/submitVideo", ({ ytbID }) => submitPortVideo(ytbID));
    app.commands.register("port/voteVideo", ({ UUID, vote }) => portVideoVote(UUID, vote));
    app.commands.register("port/updateSegments", ({ UUID }) => updateSegments(UUID));
}

export function setupSkipButtonControlBar(): void {
    const { skipButtonControlBar } = getUIState();
    if (!skipButtonControlBar) {
        const nextSkipButtonControlBar = new SkipButtonControlBar({
            skip: (segment) =>
                void getContentApp().commands.execute("skip/execute", {
                    v: getVideo(),
                    skipTime: segment.segment,
                    skippingSegments: [segment],
                    openNotice: true,
                    forceAutoSkip: true,
                }),
            selectSegment: (UUID) => void getContentApp().commands.execute("segments/select", { UUID }),
        });
        patchUIState({ skipButtonControlBar: nextSkipButtonControlBar });
    }

    getSkipButtonControlBar()?.attachToPage();
}

export function setupCategoryPill(): void {
    let { categoryPill } = getUIState();
    if (!categoryPill) {
        categoryPill = new CategoryPill();
        patchUIState({ categoryPill });
    }

    categoryPill.attachToPage(voteAsync);
}

export function setupDescriptionPill(): void {
    let { descriptionPill } = getUIState();
    if (!descriptionPill) {
        descriptionPill = new DescriptionPortPill(
            getPortVideo,
            submitPortVideo,
            portVideoVote,
            updateSegments,
            sponsorsLookup
        );
        patchUIState({ descriptionPill });
    }
    descriptionPill.setupDescription(getVideoID());
}

export async function updatePortVideoElements(newPortVideo: PortVideo): Promise<void> {
    contentState.portVideo = newPortVideo;
    waitFor(() => getUIState().descriptionPill).then(() => getUIState().descriptionPill.setPortVideoData(newPortVideo));
    syncContentStateStore("segmentSubmission.updatePortVideoElements");

    chrome.runtime.sendMessage({
        message: "infoUpdated",
        found: contentState.sponsorDataFound,
        status: contentState.lastResponseStatus,
        sponsorTimes: contentState.sponsorTimes,
        portVideo: newPortVideo,
        time: getVideo()?.currentTime ?? 0,
    });
}

export async function getPortVideo(videoId: NewVideoID, bypassCache = false): Promise<void> {
    const newPortVideo = await getPortVideoByHash(videoId, { bypassCache });
    if (newPortVideo?.UUID === contentState.portVideo?.UUID) return;
    contentState.portVideo = newPortVideo;

    updatePortVideoElements(contentState.portVideo);
}

export async function submitPortVideo(ytbID: YTID): Promise<PortVideo> {
    const newPortVideo = await postPortVideo(getVideoID(), ytbID, getVideo()?.duration);
    contentState.portVideo = newPortVideo;
    updatePortVideoElements(contentState.portVideo);
    sponsorsLookup(true, true, true);
    return newPortVideo;
}

export async function portVideoVote(UUID: string, voteType: number): Promise<void> {
    await postPortVideoVote(UUID, getVideoID(), voteType);
    await getPortVideo(getVideoID(), true);
}

export async function updateSegments(UUID: string): Promise<FetchResponse> {
    const response = await updatePortedSegments(getVideoID(), UUID);
    if (response.ok) {
        sponsorsLookup(true, true, true);
    }
    return response;
}

export async function sponsorsLookup(keepOldSubmissions = true, ignoreServerCache = false, forceUpdatePreviewBar = false): Promise<void> {
    const videoID = getVideoID();
    const { bvId, cid } = parseBvidAndCidFromVideoId(videoID);
    if (!videoID) {
        console.error("[SponsorBlock] Attempted to fetch segments with a null/undefined videoID.");
        return;
    }
    if (lookupWaiting) return;

    if (!getVideo()) {
        await waitForVideo();

        lookupWaiting = true;
        setTimeout(() => {
            lookupWaiting = false;
            sponsorsLookup(keepOldSubmissions, ignoreServerCache, forceUpdatePreviewBar);
        }, 100);
        return;
    }

    const extraRequestData: Record<string, unknown> = {};
    const hashParams = getHashParams();
    if (hashParams.requiredSegment) extraRequestData.requiredSegment = hashParams.requiredSegment;

    const hashPrefix = (await getVideoIDHash(videoID)).slice(0, 4) as BVID & HashedValue;
    const segmentResponse = await getSegmentsByVideoID(videoID, extraRequestData, ignoreServerCache);

    if (videoID !== getVideoID()) return;

    contentState.lastResponseStatus = segmentResponse?.status;

    if (segmentResponse.status === 200) {
        let receivedSegments: SponsorTime[] = segmentResponse.segments?.filter(segment => segment.cid === cid);

        const uniqueCids = new Set(segmentResponse?.segments?.filter((segment) => durationEquals(segment.videoDuration, getVideo()?.duration, 5)).map(s => s.cid));
        console.log("unique cids from segments", uniqueCids)
        if (uniqueCids.size > 1) {
            const cidMap = await getCidMapFromWindow(bvId);
            console.log("[BSB] Multiple CIDs found, using the one from the window object", cidMap);
            if (cidMap.size == 1) {
                receivedSegments = segmentResponse.segments?.filter(segment => uniqueCids.has(segment.cid));
            }
        }

        if (receivedSegments && receivedSegments.length) {
            contentState.sponsorDataFound = true;

            if (contentState.sponsorTimes !== null && keepOldSubmissions) {
                for (let i = 0; i < contentState.sponsorTimes.length; i++) {
                    if (contentState.sponsorTimes[i].source === SponsorSourceType.Local) {
                        receivedSegments.push(contentState.sponsorTimes[i]);
                    }
                }
            }

            const oldSegments = contentState.sponsorTimes || [];
            contentState.sponsorTimes = receivedSegments;

            if (Config.config.minDuration !== 0) {
                for (const segment of contentState.sponsorTimes) {
                    const duration = segment.segment[1] - segment.segment[0];
                    if (duration > 0 && duration < Config.config.minDuration) {
                        segment.hidden = SponsorHideType.MinimumDuration;
                    }
                }
            }

            if (keepOldSubmissions) {
                for (const segment of oldSegments) {
                    const otherSegment = contentState.sponsorTimes.find((other) => segment.UUID === other.UUID);
                    if (otherSegment) {
                        otherSegment.hidden = segment.hidden;
                        otherSegment.category = segment.category;
                    }
                }
            }

            const downvotedData = Config.local.downvotedSegments[hashPrefix];
            if (downvotedData) {
                for (const segment of contentState.sponsorTimes) {
                    const hashedUUID = await getHash(segment.UUID, 1);
                    const segmentDownvoteData = downvotedData.segments.find((downvote) => downvote.uuid === hashedUUID);
                    if (segmentDownvoteData) {
                        segment.hidden = segmentDownvoteData.hidden;
                    }
                }
            }

            void getContentApp().commands.execute("skip/checkStartSponsors", undefined);

            const { lastPreviewBarUpdate } = getUIState();
            if (
                forceUpdatePreviewBar ||
                lastPreviewBarUpdate == getVideoID() ||
                (lastPreviewBarUpdate == null && !isNaN(getVideo().duration))
            ) {
                void getContentApp().commands.execute("ui/updatePreviewBar", undefined);
            }
        }
    }
    emitSegmentsLoaded("segmentSubmission.sponsorsLookup");

    chrome.runtime.sendMessage({
        message: "infoUpdated",
        found: contentState.sponsorDataFound,
        status: contentState.lastResponseStatus,
        sponsorTimes: contentState.sponsorTimes,
        portVideo: contentState.portVideo,
        time: getVideo()?.currentTime ?? 0,
    });

    if (Config.config.isVip) {
        lockedCategoriesLookup();
    }
}

export async function lockedCategoriesLookup(): Promise<void> {
    const hashPrefix = (await getHash(getVideoID(), 1)).slice(0, 4);
    const response = await asyncRequestToServer("GET", "/api/lockCategories/" + hashPrefix);

    if (response.ok) {
        try {
            const categoriesResponse = JSON.parse(response.responseText).filter(
                (lockInfo) => lockInfo.videoID === getVideoID()
            )[0]?.categories;
            if (Array.isArray(categoriesResponse)) {
                contentState.lockedCategories = categoriesResponse;
                syncContentStateStore("segmentSubmission.lockedCategoriesLookup");
            }
        } catch (e) { } //eslint-disable-line no-empty
    }
}

/** Creates any missing buttons on the player and updates their visiblity. */
export async function updateVisibilityOfPlayerControlsButton(): Promise<void> {
    if (!getVideoID()) return;

    const playerButtons = await getPlayerButton().createButtons();
    patchUIState({ playerButtons: playerButtons ?? {} });

    updateSegmentSubmitting();
}

/** Updates the visibility of buttons on the player related to creating segments. */
export function updateSegmentSubmitting(): void {
    if (!getVideoID()) return;
    getPlayerButton().updateSegmentSubmitting(contentState.sponsorTimesSubmitting);
}

/**
 * Used for submitting. This will use the HTML displayed number when required as the video's
 * current time is out of date while scrubbing or at the end of the getVideo(). This is not needed
 * for sponsor skipping as the video is not playing during these times.
 */
export function getRealCurrentTime(): number {
    const endingDataSelect = document.querySelector(".bpx-player-ending-wrap")?.getAttribute("data-select");

    if (endingDataSelect === "1") {
        return getVideo()?.duration;
    } else {
        return getVideo().currentTime;
    }
}

export function startOrEndTimingNewSegment(): void {
    const roundedTime = Math.round((getRealCurrentTime() + Number.EPSILON) * 1000) / 1000;
    if (!isSegmentCreationInProgress()) {
        contentState.sponsorTimesSubmitting.push({
            cid: getCid(),
            segment: [roundedTime],
            UUID: generateUserID() as SegmentUUID,
            category: Config.config.defaultCategory,
            actionType: ActionType.Skip,
            source: SponsorSourceType.Local,
        });
    } else {
        const existingSegment = getIncompleteSegment();
        const existingTime = existingSegment.segment[0];
        const currentTime = roundedTime;

        existingSegment.segment = [Math.min(existingTime, currentTime), Math.max(existingTime, currentTime)];
    }

    Config.local.unsubmittedSegments[getVideoID()] = contentState.sponsorTimesSubmitting;
    Config.forceLocalUpdate("unsubmittedSegments");

    sponsorsLookup(true, true);

    updateSegmentSubmitting();
    updateSponsorTimesSubmitting(false);
    emitSubmittingChanged(false, "segmentSubmission.startOrEndTimingNewSegment");

    if (
        contentState.lastResponseStatus !== 200 &&
        contentState.lastResponseStatus !== 404 &&
        !contentState.shownSegmentFailedToFetchWarning &&
        Config.config.showSegmentFailedToFetchWarning
    ) {
        showMessage(chrome.i18n.getMessage("segmentFetchFailureWarning"), "warning");

        contentState.shownSegmentFailedToFetchWarning = true;
    }
}

export function getIncompleteSegment(): SponsorTime {
    return contentState.sponsorTimesSubmitting[contentState.sponsorTimesSubmitting.length - 1];
}

/** Is the latest submitting segment incomplete */
export function isSegmentCreationInProgress(): boolean {
    const segment = getIncompleteSegment();
    return segment && segment?.segment?.length !== 2;
}

export function cancelCreatingSegment(): void {
    if (isSegmentCreationInProgress()) {
        if (contentState.sponsorTimesSubmitting.length > 1) {
            contentState.sponsorTimesSubmitting.pop();
            Config.local.unsubmittedSegments[getVideoID()] = contentState.sponsorTimesSubmitting;
        } else {
            resetSponsorSubmissionNotice();
            contentState.sponsorTimesSubmitting = [];
            delete Config.local.unsubmittedSegments[getVideoID()];
        }
        Config.forceLocalUpdate("unsubmittedSegments");
    }

    updateSegmentSubmitting();
    updateSponsorTimesSubmitting(false);
    emitSubmittingChanged(false, "segmentSubmission.cancelCreatingSegment");
}

export function updateSponsorTimesSubmitting(getFromConfig = true): void {
    const segmentTimes = Config.local.unsubmittedSegments[getVideoID()];

    if (getFromConfig && segmentTimes != undefined) {
        contentState.sponsorTimesSubmitting = [];

        for (const segmentTime of segmentTimes) {
            contentState.sponsorTimesSubmitting.push({
                cid: getCid(),
                segment: segmentTime.segment,
                UUID: segmentTime.UUID,
                category: segmentTime.category,
                actionType: segmentTime.actionType,
                source: segmentTime.source,
            });
        }

        if (contentState.sponsorTimesSubmitting.length > 0) {
            contentState.previewedSegment = true;
        }
    }

    void getContentApp().commands.execute("ui/updatePreviewBar", undefined);

    if (getVideo() !== null) {
        void getContentApp().commands.execute("skip/startSchedule", {});
    }

    const { submissionNotice } = getUIState();
    if (submissionNotice !== null) {
        submissionNotice.update();
    }

    checkForPreloadedSegment();
    emitSubmittingChanged(getFromConfig, "segmentSubmission.updateSponsorTimesSubmitting");
}

export function openInfoMenu(): void {
    if (document.getElementById("sponsorBlockPopupContainer") != null) {
        return;
    }

    patchUIState({ popupInitialised: false });

    const popup = document.createElement("div");
    popup.id = "sponsorBlockPopupContainer";

    const frame = document.createElement("iframe");
    frame.width = "374";
    frame.height = "500";
    frame.style.borderRadius = "6px";
    frame.style.margin = "0px auto 20px";
    frame.addEventListener("load", async () => {
        frame.contentWindow.postMessage("", "*");

        const stylusStyle = document.querySelector(".stylus");
        if (stylusStyle) {
            frame.contentWindow.postMessage(
                {
                    type: "style",
                    css: stylusStyle.textContent,
                },
                "*"
            );
        }
    });
    frame.src = chrome.runtime.getURL("popup.html");
    popup.appendChild(frame);

    const container = document.querySelector("#danmukuBox") as HTMLElement;
    container.prepend(popup);
}

export function closeInfoMenu(): void {
    const popup = document.getElementById("sponsorBlockPopupContainer");
    if (popup === null) return;

    popup.remove();

    window.dispatchEvent(new Event("closePopupMenu"));
    getContentApp().bus.emit(CONTENT_EVENTS.UI_POPUP_CLOSED, {}, { source: "segmentSubmission.closeInfoMenu" });
}

export function clearSponsorTimes(): void {
    const currentVideoID = getVideoID();

    const sponsorTimes = Config.local.unsubmittedSegments[currentVideoID];

    if (sponsorTimes != undefined && sponsorTimes.length > 0) {
        resetSponsorSubmissionNotice();

        delete Config.local.unsubmittedSegments[currentVideoID];
        Config.forceLocalUpdate("unsubmittedSegments");

        contentState.sponsorTimesSubmitting = [];

        void getContentApp().commands.execute("ui/updatePreviewBar", undefined);
        updateSegmentSubmitting();
        emitSubmittingChanged(false, "segmentSubmission.clearSponsorTimes");
    }
}

export function importSegments(importedSegments: SponsorTime[]): void {
    let addedSegments = false;

    for (const segment of importedSegments) {
        if (
            !contentState.sponsorTimesSubmitting.some(
                (s) =>
                    Math.abs(s.segment[0] - segment.segment[0]) < 1 &&
                    Math.abs(s.segment[1] - segment.segment[1]) < 1
            )
        ) {
            contentState.sponsorTimesSubmitting.push(segment);
            addedSegments = true;
        }
    }

    if (!addedSegments) {
        return;
    }

    Config.local.unsubmittedSegments[getVideoID()] = contentState.sponsorTimesSubmitting;
    Config.forceLocalUpdate("unsubmittedSegments");

    updateSegmentSubmitting();
    updateSponsorTimesSubmitting(false);
    openSubmissionMenu();
    emitSubmittingChanged(false, "segmentSubmission.importSegments");
}

export async function vote(
    type: number,
    UUID: SegmentUUID,
    category?: Category,
    skipNotice?: SkipNoticeComponent
): Promise<VoteResponse> {
    if (skipNotice !== null && skipNotice !== undefined) {
        skipNotice.addVoteButtonInfo.bind(skipNotice)(chrome.i18n.getMessage("Loading"));
        skipNotice.setNoticeInfoMessage.bind(skipNotice)();
    }

    const response = await voteAsync(type, UUID, category);
        if (response != undefined) {
            if (skipNotice != null) {
                if (response.successType == 1 || (response.successType == -1 && response.statusCode == 429)) {
                    skipNotice.afterVote.bind(skipNotice)(utils.getSponsorTimeFromUUID(contentState.sponsorTimes, UUID), type, category);
                } else if (response.successType == -1) {
                    if (
                        response.statusCode === 403 &&
                        response.responseText.startsWith("Vote rejected due to a tip from a moderator.")
                    ) {
                        openWarningDialog(getSkipNoticeContentContainer);
                    } else {
                        skipNotice.setNoticeInfoMessage.bind(skipNotice)(
                            getErrorMessage(response.statusCode, response.responseText)
                        );
                    }

                skipNotice.resetVoteButtonInfo.bind(skipNotice)();
            }
        }
    }

    return response;
}

export async function voteAsync(type: number, UUID: SegmentUUID, category?: Category): Promise<VoteResponse | undefined> {
    const sponsorIndex = utils.getSponsorIndexFromUUID(contentState.sponsorTimes, UUID);

    if (sponsorIndex == -1 || contentState.sponsorTimes[sponsorIndex].source !== SponsorSourceType.Server)
        return Promise.resolve(undefined);

    const sponsorSkipped = getContentApp().commands.execute("skip/getSponsorSkipped", undefined) as boolean[];
    if ((type === 0 && sponsorSkipped[sponsorIndex]) || (type === 1 && !sponsorSkipped[sponsorIndex])) {
        let factor = 1;
        if (type == 0) {
            factor = -1;

            sponsorSkipped[sponsorIndex] = false;
        }

        Config.config.minutesSaved =
            Config.config.minutesSaved +
            (factor * (contentState.sponsorTimes[sponsorIndex].segment[1] - contentState.sponsorTimes[sponsorIndex].segment[0])) / 60;

        Config.config.skipCount = Config.config.skipCount + factor;
    }

    return new Promise((resolve) => {
        chrome.runtime.sendMessage(
            {
                message: "submitVote",
                type: type,
                UUID: UUID,
                category: category,
            },
            (response) => {
                if (response.successType === 1) {
                    const segment = utils.getSponsorTimeFromUUID(contentState.sponsorTimes, UUID);
                    if (segment) {
                        if (type === 0) {
                            segment.hidden = SponsorHideType.Downvoted;
                        } else if (category) {
                            segment.category = category;
                        } else if (type === 1) {
                            segment.hidden = SponsorHideType.Visible;
                        }

                        if (!category && !Config.config.isVip) {
                            utils.addHiddenSegment(getVideoID(), segment.UUID, segment.hidden);
                        }

                        void getContentApp().commands.execute("ui/updatePreviewBar", undefined);
                    }
                }

                resolve(response);
            }
        );
    });
}

export function closeAllSkipNotices(): void {
    const notices = document.getElementsByClassName("sponsorSkipNotice");
    for (let i = 0; i < notices.length; i++) {
        notices[i].remove();
    }
}

export function dontShowNoticeAgain(): void {
    Config.config.dontShowNotice = true;
    closeAllSkipNotices();
}

/**
 * Helper method for the submission notice to clear itself when it closes
 */
export function resetSponsorSubmissionNotice(callRef = true): void {
    const { submissionNotice } = getUIState();
    submissionNotice?.close(callRef);
    patchUIState({ submissionNotice: null });
}

export function closeSubmissionMenu(): void {
    const { submissionNotice } = getUIState();
    submissionNotice?.close();
    patchUIState({ submissionNotice: null });
}

export function openSubmissionMenu(): void {
    const { submissionNotice } = getUIState();
    if (submissionNotice !== null) {
        closeSubmissionMenu();
        return;
    }

    if (contentState.sponsorTimesSubmitting !== undefined && contentState.sponsorTimesSubmitting.length > 0) {
        patchUIState({
            submissionNotice: new SubmissionNotice(getSkipNoticeContentContainer, sendSubmitMessage),
        });
        document.addEventListener("keydown", seekFrameByKeyPressListener);
    }
}

export function previewRecentSegment(): void {
    if (contentState.sponsorTimesSubmitting !== undefined && contentState.sponsorTimesSubmitting.length > 0) {
        void getContentApp().commands.execute("skip/previewTime", {
            time: contentState.sponsorTimesSubmitting[contentState.sponsorTimesSubmitting.length - 1].segment[0] - defaultPreviewTime,
            unpause: true,
        });

        const { submissionNotice } = getUIState();
        if (submissionNotice) {
            submissionNotice.scrollToBottom();
        }
    }
}

export function submitSegments(): void {
    const { submissionNotice } = getUIState();
    if (contentState.sponsorTimesSubmitting !== undefined && contentState.sponsorTimesSubmitting.length > 0 && submissionNotice !== null) {
        submissionNotice.submit();
    }
}

export async function sendSubmitMessage(): Promise<boolean> {
    if (
        !contentState.previewedSegment &&
        !contentState.sponsorTimesSubmitting.every(
            (segment) =>
                [ActionType.Full, ActionType.Poi].includes(segment.actionType) ||
                segment.segment[1] >= getVideo()?.duration ||
                segment.segment[0] === 0
        )
    ) {
        showMessage(
            `${chrome.i18n.getMessage("previewSegmentRequired")} ${keybindToString(Config.config.previewKeybind)}`,
            "warning"
        );
        return false;
    }

    if (!getUIState().playerButtons.submit) {
        await updateVisibilityOfPlayerControlsButton();
    }

    const submitButtons = getUIState().playerButtons;
    submitButtons.submit.image.src = chrome.runtime.getURL("icons/PlayerUploadIconSponsorBlocker.svg");
    const stopAnimation = AnimationUtils.applyLoadingAnimation(submitButtons.submit.button, 1, () =>
        updateSegmentSubmitting()
    );

    for (let i = 0; i < contentState.sponsorTimesSubmitting.length; i++) {
        if (contentState.sponsorTimesSubmitting[i].segment[1] > getVideo().duration) {
            contentState.sponsorTimesSubmitting[i].segment[1] = getVideo().duration;
        }
    }

    Config.local.unsubmittedSegments[getVideoID()] = contentState.sponsorTimesSubmitting;
    Config.forceLocalUpdate("unsubmittedSegments");

    if (Config.config.minDuration > 0) {
        for (let i = 0; i < contentState.sponsorTimesSubmitting.length; i++) {
            const duration = contentState.sponsorTimesSubmitting[i].segment[1] - contentState.sponsorTimesSubmitting[i].segment[0];
            if (duration > 0 && duration < Config.config.minDuration) {
                const confirmShort =
                    chrome.i18n.getMessage("shortCheck") + "\n\n" + getSegmentsMessage(contentState.sponsorTimesSubmitting);

                if (!confirm(confirmShort)) return false;
            }
        }
    }

    const response = await asyncRequestToServer("POST", "/api/skipSegments", {
        videoID: getBvID(),
        cid: getCid(),
        userID: Config.config.userID,
        segments: contentState.sponsorTimesSubmitting,
        videoDuration: getVideo()?.duration,
        userAgent: `${chrome.runtime.id}/v${chrome.runtime.getManifest().version}`,
    });

    if (response.status === 200) {
        stopAnimation();

        delete Config.local.unsubmittedSegments[getVideoID()];
        Config.forceLocalUpdate("unsubmittedSegments");

        const newSegments = contentState.sponsorTimesSubmitting;
        try {
            const receivedNewSegments = JSON.parse(response.responseText);
            if (receivedNewSegments?.length === newSegments.length) {
                for (let i = 0; i < receivedNewSegments.length; i++) {
                    newSegments[i].UUID = receivedNewSegments[i].UUID;
                    newSegments[i].source = SponsorSourceType.Server;
                }
            }
        } catch (e) { } // eslint-disable-line no-empty

        contentState.sponsorTimes = (contentState.sponsorTimes || []).concat(newSegments).sort((a, b) => a.segment[0] - b.segment[0]);

        Config.config.sponsorTimesContributed = Config.config.sponsorTimesContributed + contentState.sponsorTimesSubmitting.length;

        Config.config.submissionCountSinceCategories = Config.config.submissionCountSinceCategories + 1;

        contentState.sponsorTimesSubmitting = [];

        syncContentStateStore("segmentSubmission.sendSubmitMessage.success");
        emitSegmentsLoaded("segmentSubmission.sendSubmitMessage.success");
        emitSubmittingChanged(false, "segmentSubmission.sendSubmitMessage.success");
        void getContentApp().commands.execute("ui/updatePreviewBar", undefined);

        const fullVideoSegment = contentState.sponsorTimes.filter((time) => time.actionType === ActionType.Full)[0];
        if (fullVideoSegment) {
            waitFor(() => getUIState().categoryPill).then(() => {
                getUIState().categoryPill?.setSegment(fullVideoSegment);
            });
            getVideoLabel(getVideoID(), true);
        }

        return true;
    } else {
        submitButtons.submit.button.style.animation = "unset";
        submitButtons.submit.image.src = chrome.runtime.getURL("icons/PlayerUploadFailedIconSponsorBlocker.svg");

        if (
            response.status === 403 &&
            response.responseText.startsWith("Submission rejected due to a tip from a moderator.")
        ) {
            openWarningDialog(getSkipNoticeContentContainer);
        } else {
            showMessage(getErrorMessage(response.status, response.responseText), "warning");
        }
    }

    return false;
}

export function getSegmentsMessage(sponsorTimes: SponsorTime[]): string {
    let sponsorTimesMessage = "";

    for (let i = 0; i < sponsorTimes.length; i++) {
        for (let s = 0; s < sponsorTimes[i].segment.length; s++) {
            let timeMessage = getFormattedTime(sponsorTimes[i].segment[s]);
            if (s == 1) {
                timeMessage = " " + chrome.i18n.getMessage("to") + " " + timeMessage;
            } else if (i > 0) {
                timeMessage = ", " + timeMessage;
            }

            sponsorTimesMessage += timeMessage;
        }
    }

    return sponsorTimesMessage;
}

export function checkForPreloadedSegment(): void {
    if (loadedPreloadedSegment) return;

    loadedPreloadedSegment = true;
    const hashParams = getHashParams();

    let pushed = false;
    const segments = hashParams.segments;
    if (Array.isArray(segments)) {
        for (const segment of segments) {
            if (Array.isArray(segment.segment)) {
                if (
                    !contentState.sponsorTimesSubmitting.some(
                        (s) => s.segment[0] === segment.segment[0] && s.segment[1] === s.segment[1]
                    )
                ) {
                    contentState.sponsorTimesSubmitting.push({
                        cid: getCid(),
                        segment: segment.segment,
                        UUID: generateUserID() as SegmentUUID,
                        category: segment.category ? segment.category : Config.config.defaultCategory,
                        actionType: segment.actionType ? segment.actionType : ActionType.Skip,
                        source: SponsorSourceType.Local,
                    });

                    pushed = true;
                }
            }
        }
    }

    if (pushed) {
        Config.local.unsubmittedSegments[getVideoID()] = contentState.sponsorTimesSubmitting;
        Config.forceLocalUpdate("unsubmittedSegments");
    }
}
