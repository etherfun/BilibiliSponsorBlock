import { ContentContainer } from "../ContentContainerTypes";
import { getChannelIDInfo, getVideoID } from "../utils/video";
import { getContentApp } from "./app";
import { contentState } from "./state";

export const getSkipNoticeContentContainer: ContentContainer = () => ({
    vote: (type, UUID, category, skipNotice) =>
        getContentApp().commands.execute("segment/vote", { type, UUID, category, skipNotice }),
    dontShowNoticeAgain: () => {
        void getContentApp().commands.execute("skip/dontShowNoticeAgain", undefined);
    },
    unskipSponsorTime: (segment, unskipTime, forceSeek) =>
        getContentApp().commands.execute("skip/unskip", { segment, unskipTime, forceSeek }),
    sponsorTimes: contentState.sponsorTimes,
    sponsorTimesSubmitting: contentState.sponsorTimesSubmitting,
    skipNotices: contentState.skipNotices,
    advanceSkipNotices: contentState.advanceSkipNotices,
    sponsorVideoID: getVideoID(),
    reskipSponsorTime: (segment, forceSeek) =>
        getContentApp().commands.execute("skip/reskip", { segment, forceSeek }),
    updatePreviewBar: () => {
        void getContentApp().commands.execute("ui/updatePreviewBar", undefined);
    },
    sponsorSubmissionNotice: getContentApp().ui.getState().submissionNotice,
    resetSponsorSubmissionNotice: (callRef?: boolean) => {
        void getContentApp().commands.execute("segment/resetSubmissionNotice", { callRef });
    },
    updateEditButtonsOnPlayer: () => {
        void getContentApp().commands.execute("ui/updatePlayerButtons", undefined);
    },
    previewTime: (time: number, unpause?: boolean) =>
        getContentApp().commands.execute("skip/previewTime", { time, unpause }),
    videoInfo: contentState.videoInfo,
    getRealCurrentTime: () => getContentApp().commands.execute("segment/getRealCurrentTime", undefined) as number,
    lockedCategories: contentState.lockedCategories,
    channelIDInfo: getChannelIDInfo(),
});
