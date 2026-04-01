import SkipNoticeComponent from "../../components/SkipNoticeComponent";
import PreviewBar from "../../js-components/previewBar";
import { SkipButtonControlBar } from "../../js-components/skipButtonControlBar";
import SubmissionNotice from "../../render/SubmissionNotice";
import advanceSkipNotice from "../../render/advanceSkipNotice";
import { CategoryPill } from "../../render/CategoryPill";
import { DescriptionPortPill } from "../../render/DescriptionPortPill";
import { PlayerButton } from "../../render/PlayerButton";
import SkipNotice from "../../render/SkipNotice";
import { StorageChangesObject } from "../../config/config";
import { VoteResponse } from "../../messageTypes";
import { FetchResponse } from "../../requests/type/requestType";
import {
    BVID,
    Category,
    ChannelIDInfo,
    NewVideoID,
    PortVideo,
    SegmentUUID,
    SkipToTimeParams,
    SponsorTime,
    ToggleSkippable,
    VideoInfo,
    YTID,
} from "../../types";

export interface ContentAppState {
    sponsorDataFound: boolean;
    sponsorTimes: SponsorTime[];
    skipNotices: SkipNotice[];
    advanceSkipNotices: advanceSkipNotice | null;
    activeSkipKeybindElement: ToggleSkippable;
    shownSegmentFailedToFetchWarning: boolean;
    previewedSegment: boolean;
    portVideo: PortVideo | null;
    videoInfo: VideoInfo | null;
    lockedCategories: Category[];
    switchingVideos: boolean | null;
    channelWhitelisted: boolean;
    sponsorTimesSubmitting: SponsorTime[];
    lastResponseStatus: number;
    pageLoaded: boolean;
}

export interface ContentUIRegistryState {
    playerButton: PlayerButton | null;
    playerButtons: Record<string, { button: HTMLButtonElement; image: HTMLImageElement }>;
    descriptionPill: DescriptionPortPill | null;
    submissionNotice: SubmissionNotice | null;
    popupInitialised: boolean;
    skipButtonControlBar: SkipButtonControlBar | null;
    categoryPill: CategoryPill | null;
    previewBar: PreviewBar | null;
    selectedSegment: SegmentUUID | null;
    lastPreviewBarUpdate: BVID | null;
}

export interface LastKnownVideoTimeState {
    videoTime: number | null;
    preciseTime: number | null;
    fromPause: boolean;
    approximateDelay: number | null;
}

export interface ContentEventMeta {
    source: string;
    timestamp: number;
}

export interface ContentEventMap {
    "app/pageReady": { pageLoaded: boolean };
    "video/resetRequested": { reason: string };
    "video/idChanged": { videoID: NewVideoID | null };
    "video/elementChanged": { newVideo: boolean; video: HTMLVideoElement | null };
    "video/channelResolved": { channelIDInfo: ChannelIDInfo };
    "config/changed": { changes: StorageChangesObject };
    "segments/loaded": { sponsorTimes: SponsorTime[]; status: number };
    "segments/submittingChanged": { sponsorTimesSubmitting: SponsorTime[]; getFromConfig: boolean };
    "skip/executed": {
        skipTime: [number, number];
        skippingSegments: SponsorTime[];
        autoSkip: boolean;
        openNotice: boolean;
        unskipTime?: number | null;
    };
    "skip/noticeRequested": {
        skippingSegments: SponsorTime[];
        autoSkip: boolean;
        unskipTime?: number | null;
        startReskip: boolean;
    };
    "skip/buttonStateChanged": { enabled: boolean; segment: SponsorTime | null; duration?: number };
    "player/timeUpdated": { time: number };
    "player/videoReady": { video: HTMLVideoElement };
    "player/durationChanged": { video: HTMLVideoElement };
    "player/play": { video: HTMLVideoElement };
    "player/playing": { video: HTMLVideoElement };
    "player/seeking": { video: HTMLVideoElement };
    "player/pause": { video: HTMLVideoElement };
    "player/waiting": { video: HTMLVideoElement };
    "player/rateChanged": { video: HTMLVideoElement; playbackRate: number };
    "ui/popupClosed": Record<string, never>;
}

export interface ContentCommandDefinition<Payload = void, Result = void> {
    payload: Payload;
    result: Result;
}

export interface ContentCommandMap {
    "segment/toggleCapture": ContentCommandDefinition<void, void>;
    "segment/cancelCapture": ContentCommandDefinition<void, void>;
    "segment/submit": ContentCommandDefinition<void, void>;
    "segment/openSubmissionMenu": ContentCommandDefinition<void, void>;
    "segment/previewRecent": ContentCommandDefinition<void, void>;
    "segment/isCreationInProgress": ContentCommandDefinition<void, boolean>;
    "segment/getRealCurrentTime": ContentCommandDefinition<void, number>;
    "segment/resetSubmissionNotice": ContentCommandDefinition<{ callRef?: boolean }, void>;
    "segment/vote": ContentCommandDefinition<{
        type: number;
        UUID: SegmentUUID;
        category?: Category;
        skipNotice?: SkipNoticeComponent;
    }, VoteResponse>;
    "segment/voteAsync": ContentCommandDefinition<{ type: number; UUID: SegmentUUID; category?: Category }, VoteResponse | undefined>;
    "segments/lookup": ContentCommandDefinition<{
        keepOldSubmissions?: boolean;
        ignoreServerCache?: boolean;
        forceUpdatePreviewBar?: boolean;
    }, void>;
    "segments/updateSubmitting": ContentCommandDefinition<{ getFromConfig?: boolean }, void>;
    "segments/import": ContentCommandDefinition<{ importedSegments: SponsorTime[] }, void>;
    "segments/select": ContentCommandDefinition<{ UUID: SegmentUUID | null }, void>;
    "skip/startSchedule": ContentCommandDefinition<{
        includeIntersectingSegments?: boolean;
        currentTime?: number;
        includeNonIntersectingSegments?: boolean;
    }, void>;
    "skip/dontShowNoticeAgain": ContentCommandDefinition<void, void>;
    "skip/checkStartSponsors": ContentCommandDefinition<void, void>;
    "skip/unskip": ContentCommandDefinition<{ segment: SponsorTime; unskipTime?: number; forceSeek?: boolean }, void>;
    "skip/reskip": ContentCommandDefinition<{ segment: SponsorTime; forceSeek?: boolean }, void>;
    "skip/execute": ContentCommandDefinition<SkipToTimeParams, void>;
    "skip/previewTime": ContentCommandDefinition<{ time: number; unpause?: boolean }, void>;
    "skip/updateVirtualTime": ContentCommandDefinition<void, void>;
    "skip/updateWaitingTime": ContentCommandDefinition<void, void>;
    "skip/clearWaitingTime": ContentCommandDefinition<void, void>;
    "skip/cancelSchedule": ContentCommandDefinition<void, void>;
    "skip/getVirtualTime": ContentCommandDefinition<void, number>;
    "skip/getLastKnownVideoTime": ContentCommandDefinition<void, LastKnownVideoTimeState>;
    "skip/getSponsorSkipped": ContentCommandDefinition<void, boolean[]>;
    "skip/isSegmentMarkedNearCurrentTime": ContentCommandDefinition<{ currentTime: number; range?: number }, boolean>;
    "ui/createPreviewBar": ContentCommandDefinition<void, void>;
    "ui/updatePreviewBar": ContentCommandDefinition<void, void>;
    "ui/checkPreviewBarState": ContentCommandDefinition<void, void>;
    "ui/updateActiveSegment": ContentCommandDefinition<{ currentTime: number }, void>;
    "ui/updatePlayerButtons": ContentCommandDefinition<void, void>;
    "ui/setupDescriptionPill": ContentCommandDefinition<void, void>;
    "ui/setupCategoryPill": ContentCommandDefinition<void, void>;
    "ui/setupSkipButtonControlBar": ContentCommandDefinition<void, void>;
    "popup/openInfoMenu": ContentCommandDefinition<void, void>;
    "popup/closeInfoMenu": ContentCommandDefinition<void, void>;
    "port/submitVideo": ContentCommandDefinition<{ ytbID: YTID }, PortVideo>;
    "port/voteVideo": ContentCommandDefinition<{ UUID: string; vote: number }, void>;
    "port/updateSegments": ContentCommandDefinition<{ UUID: string }, FetchResponse>;
    "config/applyCategoryColors": ContentCommandDefinition<void, void>;
}
