import { BilibiliResponse, BiliPlayInfo, BiliVideoDetail } from "../requests/type/BilibiliRequestType";
import { InjectedScriptMessageSend, sourceId } from "../utils/injectedScriptMessageUtils";
import { getBvid, saveAidFromDetail } from "./aidMap";
import { getFrameRate, playUrlResponseToPlayInfo, savePlayInfo } from "./frameRateUtils";

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

function overwriteFetch() {
    const originalFetch = window.fetch;

    window.fetch = async function (input, init) {
        const urlStr = typeof input === "string" ? input : (input as Request).url;
        const response = await originalFetch(input, init);
        response
            .clone()
            .text()
            .then((res) => processURLRequest(new URL(urlStr, window.location.href), res))
            .catch(() => {});
        return response;
    };
}

function overwriteXHR() {
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.send = function (body?: Document | BodyInit | null) {
        this.addEventListener("loadend", function () {
            if (this.readyState === 4 && this.status >= 200 && this.status < 300) {
                try {
                    const url = new URL(this.responseURL);
                    processURLRequest(url, this.responseText);
                } catch (e) {
                    console.debug("Failed to process request");
                }
            }
        });
        originalSend.call(this, body);
    };
}

function processURLRequest(url: URL, responseText: string): void {
    if (url.pathname.includes("/player/wbi/playurl")) {
        const response = JSON.parse(responseText) as BilibiliResponse<BiliPlayInfo>;
        const cid = url.searchParams.get("cid");
        if (cid && response?.data?.dash?.video) {
            savePlayInfo(cid, playUrlResponseToPlayInfo(response.data));
        }
    } else if (url.pathname.includes("/x/player/wbi/v2")) {
        const response = JSON.parse(responseText) as BilibiliResponse<BiliVideoDetail>;
        saveAidFromDetail(response.data);
    }
}

async function windowMessageListener(message: MessageEvent) {
    const data: InjectedScriptMessageSend = message.data;
    if (!data || !data?.source) {
        return;
    }
    if (data?.source === sourceId && data?.responseType) {
        if (data.type === "getBvID") {
            sendMessageToContent(data, window?.__INITIAL_STATE__?.bvid);
        } else if (data.type === "getFrameRate") {
            sendMessageToContent(data, getFrameRate());
        } else if (data.type === "getChannelID") {
            sendMessageToContent(data, window?.__INITIAL_STATE__?.upData?.mid);
        } else if (data.type === "getDescription") {
            sendMessageToContent(data, window?.__INITIAL_STATE__?.videoData?.desc);
        } else if (data.type === "convertAidToBvid") {
            sendMessageToContent(data, await getBvid(data.payload as string));
        }
    }
}

function init(): void {
    window.addEventListener("message", windowMessageListener);
    overwriteFetch();
    overwriteXHR();
}

init();

function addUserId() {
    if (!document.body) {
        setTimeout(addUserId, 50);
        return;
    }

    let pageObserver = new MutationObserver((mutationList, observer) => {
        for (let el of document.getElementsByClassName("bili-dyn-item")) {
            const {mid, type} = (el as unknown as { __vue__: { author: { mid: number, type: string } } }).__vue__.author;
            if (mid && type == "AUTHOR_TYPE_NORMAL") {
                el.getElementsByClassName("bili-dyn-item__avatar")[0].setAttribute("bilisponsor-userid", mid.toString());
            }
        }
    
        for (let el of document.getElementsByClassName("bili-dyn-title")) {
            const { mid, type } = (el as unknown as { __vue__: { author: { mid: number, type: string } } }).__vue__.author;
            if (mid && type == "AUTHOR_TYPE_NORMAL") {
                el.getElementsByClassName("bili-dyn-title__text")[0].setAttribute("bilisponsor-userid", mid.toString());
            }
        }
    
        for (const el of document.querySelectorAll(".dyn-orig-author__face, .dyn-orig-author__name")) {
            const uid = (el as unknown as { _profile?: { uid: number } })?._profile?.uid;
            if (uid) {
                el.setAttribute("bilisponsor-userid", uid.toString());
            }
        }
    });

    pageObserver.observe(document.body, {
        childList: true,
        subtree: true,
    });
}

addUserId();