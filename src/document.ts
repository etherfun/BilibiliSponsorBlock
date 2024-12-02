import { InjectedScriptMessageSend, sourceId } from "./utils/injectedScriptMessageUtils";

const sendMessageToContent = (messageData: InjectedScriptMessageSend, payload): void => {
    window.postMessage(
        {
            source: sourceId,
            type: messageData.responseType,
            id: messageData.id,
            data: payload,
        },
        "/"
    );
};
interface Video {
    id: number;
    frameRate: number;
}
let VideoData: { data: { dash: { video: Video[] } } };


(function () {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (
        method: string,
        url: string | URL,
        async: boolean = true,
        user?: string | null,
        password?: string | null
    ) {
        this._url = url.toString();
        originalOpen.call(this, method, url, async, user, password);
    };

    XMLHttpRequest.prototype.send = function (body?: Document | BodyInit | null) {
        this.addEventListener('readystatechange', function () {
            if (this.readyState === 4 && this.status >= 200 && this.status < 300) {
                const url = this._url;

                if (url.includes('/player/wbi/playurl') && url.includes(window.__INITIAL_STATE__.cid.toString())) {
                        VideoData = JSON.parse(this.responseText);
                }
            }
        });

        originalSend.call(this, body);
    };
})();

function windowMessageListener(message: MessageEvent) {
    const data: InjectedScriptMessageSend = message.data;
    if (!data || !data?.source) {
        return;
    }
    if (data?.source === sourceId && data?.responseType) {
        if (data.type === "getBvID") {
            sendMessageToContent(data, window?.__INITIAL_STATE__?.bvid);
        } else if (data.type === "getFrameRate") {
            let frameRate: number;
            try {
                frameRate = VideoData.data.dash.video
                .filter((v: { id: number }) => v.id === JSON.parse(window.localStorage.bpx_player_profile).media.quality)[0].frameRate;
            }catch (e) {//初始化的第一次调用会比初始化xhr请求快,返回默认值
                frameRate = 30;
            }
            console.log(frameRate);
            sendMessageToContent(data, frameRate);
        } else if (data.type === "getChannelID") {
            sendMessageToContent(data, window?.__INITIAL_STATE__?.upData?.mid);
        } else if (data.type === "getDescription") {
            sendMessageToContent(data, window?.__INITIAL_STATE__?.videoData?.desc);
        }
    }
}

function init(): void {
    window.addEventListener("message", windowMessageListener);
}

init();
