import Config from "../config";
import { addCleanupListener } from "../utils/cleanup";
import { logDebug } from "../utils/logger";
import { getVideoID } from "../utils/video";
import { getContentApp } from "./app";
import { danmakuForSkip } from "./danmakuSkip";
import { contentState } from "./state";

let lastCheckTime = 0;
let lastCheckVideoTime = -1;

export function resetVideoListenerState(): void {
    lastCheckTime = 0;
    lastCheckVideoTime = -1;
}

let playbackRateCheckInterval: NodeJS.Timeout | null = null;
let lastPlaybackSpeed = 1;
let setupVideoListenersFirstTime = true;

function getLastKnownVideoTime() {
    return getContentApp().commands.execute("skip/getLastKnownVideoTime", undefined) as {
        videoTime: number | null;
        preciseTime: number | null;
        fromPause: boolean;
        approximateDelay: number | null;
    };
}

/**
 * Triggered every time the video duration changes.
 * This happens when the resolution changes or at random time to clear memory.
 */
export function durationChangeListener(event?: Event): void {
    const video = (event?.target as HTMLVideoElement) || (document.querySelector("video") as HTMLVideoElement | null);
    if (!video) return;

    getContentApp().bus.emit("player/durationChanged", { video }, { source: "videoListeners.durationChange" });
    void getContentApp().commands.execute("ui/updatePreviewBar", undefined);
}

/**
 * Triggered once the video is ready.
 * This is mainly to attach to embedded players who don't have a video element visible.
 */
export function videoOnReadyListener(event?: Event): void {
    const video = (event?.target as HTMLVideoElement) || (document.querySelector("video") as HTMLVideoElement | null);
    if (!video) return;

    getContentApp().bus.emit("player/videoReady", { video }, { source: "videoListeners.videoOnReady" });
    void getContentApp().commands.execute("ui/createPreviewBar", undefined);
    void getContentApp().commands.execute("ui/updatePreviewBar", undefined);
    void getContentApp().commands.execute("ui/updatePlayerButtons", undefined);
}

export function setupVideoListeners(video: HTMLVideoElement): void {
    if (!video) return;

    const app = getContentApp();

    video.addEventListener("loadstart", videoOnReadyListener);
    video.addEventListener("durationchange", durationChangeListener);

    if (setupVideoListenersFirstTime) {
        addCleanupListener(() => {
            video.removeEventListener("loadstart", videoOnReadyListener);
            video.removeEventListener("durationchange", durationChangeListener);
        });
    }

    if (!Config.config.disableSkipping) {
        danmakuForSkip();

        contentState.switchingVideos = false;

        let startedWaiting = false;
        let lastPausedAtZero = true;

        const rateChangeListener = () => {
            void app.commands.execute("skip/updateVirtualTime", undefined);
            void app.commands.execute("skip/clearWaitingTime", undefined);
            app.bus.emit("player/rateChanged", { video, playbackRate: video.playbackRate }, { source: "videoListeners.rateChange" });
            void app.commands.execute("skip/startSchedule", {});
        };
        video.addEventListener("ratechange", rateChangeListener);
        video.addEventListener("videoSpeed_ratechange", rateChangeListener);

        const playListener = () => {
            if (video.readyState <= HTMLMediaElement.HAVE_CURRENT_DATA && video.currentTime === 0) return;

            void app.commands.execute("skip/updateVirtualTime", undefined);
            app.bus.emit("player/play", { video }, { source: "videoListeners.play" });

            if (contentState.switchingVideos || lastPausedAtZero) {
                contentState.switchingVideos = false;
                logDebug("Setting switching videos to false");

                if (contentState.sponsorTimes) {
                    void app.commands.execute("skip/checkStartSponsors", undefined);
                }
            }

            lastPausedAtZero = false;

            if (
                Math.abs(lastCheckVideoTime - video.currentTime) > 0.3 ||
                (lastCheckVideoTime !== video.currentTime && Date.now() - lastCheckTime > 2000)
            ) {
                lastCheckTime = Date.now();
                lastCheckVideoTime = video.currentTime;

                void app.commands.execute("skip/startSchedule", {});
            }
        };
        video.addEventListener("play", playListener);

        const playingListener = () => {
            void app.commands.execute("skip/updateVirtualTime", undefined);
            app.bus.emit("player/playing", { video }, { source: "videoListeners.playing" });
            lastPausedAtZero = false;

            if (startedWaiting) {
                startedWaiting = false;
                logDebug(
                    `[SB] Playing event after buffering: ${Math.abs(lastCheckVideoTime - video.currentTime) > 0.3 ||
                    (lastCheckVideoTime !== video.currentTime && Date.now() - lastCheckTime > 2000)
                    }`
                );
            }

            if (contentState.switchingVideos) {
                contentState.switchingVideos = false;
                logDebug("Setting switching videos to false");

                if (contentState.sponsorTimes) {
                    void app.commands.execute("skip/checkStartSponsors", undefined);
                }
            }

            if (
                Math.abs(lastCheckVideoTime - video.currentTime) > 0.3 ||
                (lastCheckVideoTime !== video.currentTime && Date.now() - lastCheckTime > 2000)
            ) {
                lastCheckTime = Date.now();
                lastCheckVideoTime = video.currentTime;

                void app.commands.execute("skip/startSchedule", {});
            }

            if (playbackRateCheckInterval) clearInterval(playbackRateCheckInterval);
            lastPlaybackSpeed = video.playbackRate;

            if (document.body.classList.contains("vsc-initialized")) {
                playbackRateCheckInterval = setInterval(() => {
                    if ((!getVideoID() || video.paused) && playbackRateCheckInterval) {
                        clearInterval(playbackRateCheckInterval);
                        return;
                    }

                    if (video.playbackRate !== lastPlaybackSpeed) {
                        lastPlaybackSpeed = video.playbackRate;

                        rateChangeListener();
                    }
                }, 2000);
            }
        };
        video.addEventListener("playing", playingListener);

        const seekingListener = () => {
            getLastKnownVideoTime().fromPause = false;
            app.bus.emit("player/seeking", { video }, { source: "videoListeners.seeking" });

            if (!video.paused) {
                lastCheckTime = Date.now();
                lastCheckVideoTime = video.currentTime;

                void app.commands.execute("skip/updateVirtualTime", undefined);
                void app.commands.execute("skip/clearWaitingTime", undefined);

                if (video.loop && video.currentTime < 0.2) {
                    void app.commands.execute("skip/startSchedule", {
                        includeIntersectingSegments: false,
                        currentTime: 0,
                    });
                } else {
                    void app.commands.execute("skip/startSchedule", {
                        includeIntersectingSegments: Config.config.skipOnSeekToSegment,
                    });
                }
            } else {
                void app.commands.execute("ui/updateActiveSegment", { currentTime: video.currentTime });

                if (video.currentTime === 0) {
                    lastPausedAtZero = true;
                }
            }
        };
        video.addEventListener("seeking", seekingListener);

        const stoppedPlayback = () => {
            lastCheckVideoTime = -1;
            lastCheckTime = 0;

            if (playbackRateCheckInterval) clearInterval(playbackRateCheckInterval);

            const lastKnownVideoTime = getLastKnownVideoTime();
            lastKnownVideoTime.videoTime = null;
            lastKnownVideoTime.preciseTime = null;
            void app.commands.execute("skip/updateWaitingTime", undefined);

            void app.commands.execute("skip/cancelSchedule", undefined);
        };
        const pauseListener = () => {
            getLastKnownVideoTime().fromPause = true;
            app.bus.emit("player/pause", { video }, { source: "videoListeners.pause" });

            stoppedPlayback();
        };
        video.addEventListener("pause", pauseListener);
        const waitingListener = () => {
            logDebug("[SB] Not skipping due to buffering");
            startedWaiting = true;
            app.bus.emit("player/waiting", { video }, { source: "videoListeners.waiting" });

            stoppedPlayback();
        };
        video.addEventListener("waiting", waitingListener);

        void app.commands.execute("skip/startSchedule", {});

        if (setupVideoListenersFirstTime) {
            addCleanupListener(() => {
                video.removeEventListener("play", playListener);
                video.removeEventListener("playing", playingListener);
                video.removeEventListener("seeking", seekingListener);
                video.removeEventListener("ratechange", rateChangeListener);
                video.removeEventListener("videoSpeed_ratechange", rateChangeListener);
                video.removeEventListener("pause", pauseListener);
                video.removeEventListener("waiting", waitingListener);

                if (playbackRateCheckInterval) clearInterval(playbackRateCheckInterval);
            });
        }
    }

    setupVideoListenersFirstTime = false;
}
