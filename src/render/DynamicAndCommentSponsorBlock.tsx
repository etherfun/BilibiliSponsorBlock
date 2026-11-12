import Config from "../config";
import { waitForPageReady } from "../content/pageReadiness";
import { getPageLoaded } from "../content/state";
import { DynamicSponsorOption, DynamicSponsorSelection } from "../types";
import { addCleanupListener } from "../utils/cleanup";
import { insertSBIconDefinition } from "../thumbnail-utils/thumbnails";
import { matchSponsorRules } from "../utils/sponsorRegex";
import { getEffectiveSponsorRegexRules } from "../config/sponsorRegexOTA";
import { AICG_CATEGORY, getAicgOption, getAicgTuning, isAicgEnabled, shouldProcessComments } from "../content/aicg/settings";
import { createAicgContext, HeuristicAicgDetector } from "../content/aicg/detector";
import { decideAicgOption, summarizeFeatures } from "../content/aicg/decision";
import type { AicgFeatureId } from "../content/aicg/types";
import { readCommentAuthor, readCommentText } from "../content/aicg/commentText";
import { codePointLength, normalizeCommentText, stripMentionPrefix } from "../content/aicg/text";

export { DynamicListener, CommentListener };

const pendingPageListeners = new Map<() => void, AbortController>();

function pageReadyFor(listener: () => void): boolean {
    if (getPageLoaded()) return true;
    if (!pendingPageListeners.has(listener)) {
        const controller = new AbortController();
        pendingPageListeners.set(listener, controller);
        addCleanupListener(() => controller.abort());
        void waitForPageReady(undefined, controller.signal).then(() => {
            pendingPageListeners.delete(listener);
            if (!controller.signal.aborted) listener();
        }).catch(() => pendingPageListeners.delete(listener));
    }
    return false;
}

let scanDynamics: (() => void) | null = null;

function DynamicListener() {
    if (!pageReadyFor(DynamicListener)) return;
    if (scanDynamics) {
        scanDynamics();
        return;
    }
    const scan = () => {
        if (document.hidden || !Config.config.dynamicAndCommentSponsorBlocker || !Config.config.dynamicSponsorBlock) return;
        for (const element of document.querySelectorAll<HTMLElement>(".bili-dyn-list__items > *")) {
            if (element.querySelector("#dynamicSponsorLabel")) continue;

            let category = isSponsor(element);
            const action = getCategorySelection(category)?.option;
            let dynamicSponsorMatch: string[] = [];
            let meetsKeywordThreshold = true;
            if (category === "dynamicSponsor_suspicion_sponsor") {
                const result = matchSponsorRules(
                    isDynamicSponsorSuspicionSponsor(element),
                    getEffectiveSponsorRegexRules(),
                    Config.config.dynamicAndCommentSponsorRegexFlags,
                    Config.config.dynamicAndCommentSponsorRegexPatternKeywordNumber
                );
                dynamicSponsorMatch = result.matches;
                meetsKeywordThreshold = result.matched;
                category = dynamicSponsorMatch.length > 0 ? "dynamicSponsor_suspicion_sponsor" : null;
            }
            if (category === null || action === DynamicSponsorOption.Disabled) continue;
            const debugMode = category === "dynamicSponsor_suspicion_sponsor" && Config.config.dynamicSponsorBlockerDebug;

            const upId = element.querySelector('.bili-dyn-item__avatar')?.getAttribute('bilisponsor-userid');
            const upIdOrigin = element?.querySelector('.dyn-orig-author__face')?.getAttribute('bilisponsor-userid');
            if ((!(Config.config.whitelistedChannels.some(ch => ch.id === upId) ||
                Config.config.whitelistedChannels?.some(ch => ch.id === upIdOrigin)) ||
                Config.config.dynamicAndCommentSponsorWhitelistedChannels) &&
                !(!Config.config.dynamicSpaceSponsorBlocker &&
                window.location.href.includes("space.bilibili.com"))
            ) {
                const title = element.querySelector<HTMLElement>('.bili-dyn-title__text');
                if (!title) continue;
                labelSponsorStyle("dynamicSponsorLabel", title, category, debugMode, dynamicSponsorMatch);
                if (action !== DynamicSponsorOption.Hide) continue;
                if (!meetsKeywordThreshold) continue;

                const bodyElement = element.querySelector('.bili-dyn-content') as HTMLElement;
                const actionButton = element.querySelectorAll<HTMLElement>('.bili-dyn-item__action')[2];
                if (bodyElement && actionButton) hideSponsorContent(bodyElement, actionButton);
            }
        }
    };
    scanDynamics = scan;
    const containsList = (node: Node) => node instanceof Element &&
        (node.matches(".bili-dyn-list__items") || !!node.querySelector(".bili-dyn-list__items"));
    const observer = new MutationObserver((records) => {
        // Lists can appear after login or be replaced by a feed filter. Existing
        // cards must also be scanned after hydration, without waiting for a click.
        if (records.some((record) => {
            const target = record.target instanceof Element ? record.target : record.target.parentElement;
            if (target?.closest("#dynamicSponsorLabel, #showDynamicSponsor")) return false;
            return !!target?.closest(".bili-dyn-list__items") ||
                [...record.addedNodes, ...record.removedNodes].some(containsList);
        })) scan();
    });
    observer.observe(document.documentElement, {
        childList: true, subtree: true, characterData: true,
        attributes: true, attributeFilter: ["bilisponsor-userid"],
    });
    document.addEventListener("visibilitychange", scan);
    addCleanupListener(() => {
        observer.disconnect();
        document.removeEventListener("visibilitychange", scan);
        scanDynamics = null;
    });
    scan();
}

let scanComments: (() => void) | null = null;
let commentCompensationScheduled = false;

function CommentListener() {
    if (!pageReadyFor(CommentListener)) return;
    if (scanComments) {
        scanComments();
        return;
    }

    const observers = new Map<HTMLElement, { shadow: ShadowRoot; observer: MutationObserver }>();
    const scan = () => {
        for (const [root, entry] of observers) {
            if (!root.isConnected) {
                entry.observer.disconnect();
                observers.delete(root);
            }
        }
        if (document.hidden || !shouldProcessComments()) return;

        const observeComments = (host: HTMLElement) => {
            const shadow = host.shadowRoot;
            if (!shadow) return;
            if (observers.get(host)?.shadow !== shadow) {
                observers.get(host)?.observer.disconnect();
                // 自检信息本身写在被观察的 shadow root 里，它的变化不能再触发扫描，
                // 否则「扫描 -> 更新自检文字 -> 触发扫描」会自我循环。
                const observer = new MutationObserver((records) => {
                    if (records.every((record) => isAicgStatusMutation(record))) return;
                    scan();
                });
                observer.observe(shadow, {
                    childList: true,
                    subtree: true,
                    attributes: true,
                    attributeFilter: ["data-type", "data-user-profile-id"],
                });
                observers.set(host, { shadow, observer });
            }
            // MutationObserver does not cross into nested shadow roots.
            for (const child of shadow.querySelectorAll<HTMLElement>(
                "bili-comment-thread-renderer, bili-comment-renderer, bili-rich-text, " +
                "bili-comment-user-info, bili-comment-action-buttons-renderer, " +
                "bili-comment-replies-renderer, bili-text-button"
            )) {
                observeComments(child);
            }
        };
        for (const root of document.querySelectorAll<HTMLElement>("bili-comments")) {
            if (!root.shadowRoot) continue;
            observeComments(root);
            SponsorComment(root);
        }
    };

    scanComments = scan;
    // Discover comment sections opened later or replaced along with their container.
    const pageObserver = new MutationObserver((mutations) => {
        const containsComments = (node: Node) => node instanceof Element &&
            (node.matches("bili-comments") || node.querySelector("bili-comments") !== null);
        if (mutations.some(({ addedNodes, removedNodes }) =>
            [...addedNodes, ...removedNodes].some(containsComments))) {
            scan();
        }
    });
    pageObserver.observe(document.documentElement, { childList: true, subtree: true });
    // Schedule at most one delayed scan per page, even if the listener is restarted.
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (!commentCompensationScheduled) {
        commentCompensationScheduled = true;
        timer = setTimeout(scan, 5000);
    }
    document.addEventListener("visibilitychange", scan);
    addCleanupListener(() => {
        clearTimeout(timer);
        // 页面/视频切换后旧评论的上下文不能再参与判定
        resetAicgPeerCache();
        pageObserver.disconnect();
        document.removeEventListener("visibilitychange", scan);
        for (const { observer } of observers.values()) observer.disconnect();
        observers.clear();
        scanComments = null;
    });
    scan();
}

function getCategorySelection(category: string): DynamicSponsorSelection {
    for (const selection of Config.config.dynamicSponsorSelections) {
        if (selection.name === category) return selection;
    }
    return { name: category, option: DynamicSponsorOption.Disabled } as DynamicSponsorSelection;
}

function hideSponsorContent(
    content: HTMLElement,
    button: HTMLElement,
    inShadeRoot?: boolean,
    options: { toggleId?: string; showText?: string; hideText?: string } = {},
) {
    const toggleId = options.toggleId ?? 'showDynamicSponsor';
    const showText = options.showText ?? 'dynamicSponsorShow';
    const hideText = options.hideText ?? 'dynamicSponsorHide';

    if (inShadeRoot) {
        shadowRootStyle(button);
        insertSBIconDefinition(button);
    }

    content.style.display = 'none';

    const toggleButton = getButton(toggleId);
    toggleButton.textContent = chrome.i18n.getMessage(showText);
    toggleButton.insertBefore(getIcon(), toggleButton.firstChild);
    toggleButton.addEventListener('click', () => {
        const isHidden = content.style.display === 'none' || !content.style.height === null;

        if (isHidden) {
            content.style.display = 'block';
            content.style.overflow = 'hidden';
            content.style.height = '0px';
            content.offsetHeight;

            const targetHeight = content.scrollHeight;
            content.style.transition = 'height 0.5s ease-in-out';
            content.style.height = `${targetHeight}px`;
        } else {
            const targetHeight = content.scrollHeight;
            content.style.height = `${targetHeight}px`;
            content.offsetHeight;

            content.style.transition = 'height 0.5s ease-in-out';
            content.style.height = '0px';
        }
        content.addEventListener('transitionend', () => {
            if (isHidden) {
                content.style.height = '';
            } else {
                content.style.display = 'none';
                content.style.height = '';
            }
        }, { once: true });

        toggleButton.textContent = chrome.i18n.getMessage(isHidden ? hideText : showText);
        toggleButton.insertBefore(getIcon(), toggleButton.firstChild);
    });

    button.parentNode!.insertBefore(toggleButton, button.nextSibling);
}

function getButton(toggleId = 'showDynamicSponsor') {
    const toggleButton = document.createElement('button');
    toggleButton.id = toggleId;
    toggleButton.className = 'bili-dyn-action';
    return toggleButton;
}

function labelSponsorStyle(labelName: string, element: HTMLElement, category: string, debugMode: boolean = false, SponsorMatch?:string[], inShadeRoot?: boolean) {
    if (inShadeRoot) {
        shadowRootStyle(element);
        insertSBIconDefinition(element);
    }

    const Sponsor = document.createElement('div');
    Sponsor.id = labelName;
    Sponsor.appendChild(getIcon());
    const Group = document.createElement('div');
    Group.className = 'Text-Group';

    const SponsorText = document.createElement('span');
    SponsorText.className = "Label";
    SponsorText.textContent = chrome.i18n.getMessage(`category_${category}`);
    Group.appendChild(SponsorText);
    if (debugMode) {
        const SponsorTextMatch = document.createElement('span');
        SponsorTextMatch.className = "Match";
        SponsorTextMatch.textContent =  chrome.i18n.getMessage("DynamicSponsorMatch") + SponsorMatch;
        Group.appendChild(SponsorTextMatch);
    }
    Sponsor.style.setProperty(
        "--category-color",
        `var(--sb-category-${category})`
    );
    Sponsor.style.setProperty(
        "--category-text-color",
        `var(--sb-category-text-${category})`
    );
    Sponsor.appendChild(Group);
    Sponsor.addEventListener('mouseenter', () => {
        Group.style.display = 'flex';
        Sponsor.style.borderRadius = '0.5em';
    });
    Sponsor.addEventListener('mouseleave', () => {
        Group.style.display = null;
        Sponsor.style.borderRadius = null;
    });

    element.parentNode!.insertBefore(Sponsor, element.nextSibling);
}

function isSponsor(element: HTMLElement) {
    const goodsElement = element?.querySelector('.bili-dyn-card-goods');
    const goodsElementOrigin = element?.querySelector('.bili-dyn-card-goods.hide-border');
    if (goodsElementOrigin) {
        return "dynamicSponsor_forward_sponsor";
    } else if (goodsElement) {
        return "dynamicSponsor_sponsor";
    } else {
        return "dynamicSponsor_suspicion_sponsor";
    }
}

function isDynamicSponsorSuspicionSponsor(element: HTMLElement) {
    const contentDivText = element?.querySelectorAll('.bili-rich-text__content span:not(.bili-dyn-item__interaction *)');
    const contentDivOpus = element?.querySelectorAll('.opus-paragraph-children span');
    const contentOpusTitle = element?.querySelectorAll('.dyn-card-opus__title');
    
    const content = [...contentOpusTitle, ...contentDivText, ...contentDivOpus];
    if (!content) return '';

    let combinedText = '';
    content.forEach(span => {
        combinedText += span.textContent;
    });
    return combinedText;
}

function shadowRootStyle(element: HTMLElement) {
    const style = document.createElement('style');
    style.textContent = `
            /*bilibili Dynamic sponsor label */
            #dynamicSponsorLabel {
                display: flex;
                background-color: var(--category-color, #fff);
                border-radius: 2em;
                padding: 0.4em;
                margin: 0.4em;
                align-items: center;
                transition: border-radius 0.4s 0.05s;
	            z-index: 99;
            }

            #dynamicSponsorLabel svg {
                width: 1.5em;
                height: 1.5em;
                fill: var(--category-text-color, #fff);
            }

            #dynamicSponsorLabel .Text-Group {
                display: none;
                flex-direction: column;
                padding-left: 0.25em;
                font-size: 1.2em;
                color: var(--category-text-color, #fff);
            }

            #dynamicSponsorLabel .Label {
                display: inline-block;
            }

            #dynamicSponsorLabel .Match {
                margin-top: 5px;
            }

            #showDynamicSponsor {
                border: none;
                background: transparent;
                cursor: pointer;
                padding: 0;
            }

            #showDynamicSponsor svg {
                margin-right: 4px;
                height: 1.2em;
                width: 1.2em;
                fill: var(--text2);
            }

            /*bilibili Comment sponsor label */
            #commentSponsorLabel {
                display: flex;
                background-color: var(--category-color, #fff);
                border-radius: 1.5em;
                padding: 0.3em;
                margin: 0.3em;
                align-items: center;
                transition: border-radius 0.4s 0.05s;
	            z-index: 99;
            }

            #commentSponsorLabel svg {
                width: 1.1em;
                height: 1.1em;
                fill: var(--category-text-color, #fff);
            }

            #commentSponsorLabel .Text-Group {
                display: none;
                flex-direction: column;
                padding-left: 0.25em;
                font-size: 0.8em;
                color: var(--category-text-color, #fff);
            }

            #commentSponsorLabel .Label {
                display: inline-block;
            }

            #commentSponsorLabel .Match {
                margin-top: 5px;
            }

            /*bilibili Comment AICG label —— 与上面的商品链接标签同一套尺寸，
              否则 SVG 图标没有宽高约束会被撑成满屏。*/
            #commentAicgLabel {
                display: inline-flex;
                background-color: var(--category-color, #fff);
                border-radius: 1.5em;
                padding: 0.3em;
                margin: 0.3em;
                align-items: center;
                transition: border-radius 0.4s 0.05s;
	            z-index: 99;
            }

            #commentAicgLabel svg {
                width: 1.1em;
                height: 1.1em;
                fill: var(--category-text-color, #fff);
            }

            #commentAicgLabel .Text-Group {
                display: none;
                flex-direction: column;
                padding-left: 0.25em;
                font-size: 0.8em;
                color: var(--category-text-color, #fff);
            }

            #commentAicgLabel .Label {
                display: inline-block;
            }

            #commentAicgLabel .Match {
                margin-top: 5px;
            }

            #showAicgContent {
                border: none;
                background: transparent;
                cursor: pointer;
                padding: 0;
            }

            #showAicgContent svg {
                margin-right: 4px;
                height: 1.2em;
                width: 1.2em;
                fill: var(--text2);
            }`;
    element.parentNode!.insertBefore(style, element.nextSibling);
}

function getIcon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 565.15 568");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#SponsorBlockIcon");
    svg.appendChild(use);
    return svg;
}

const expandedReplyThreads = new WeakSet<HTMLElement>();
const wiredReplyButtons = new WeakSet<HTMLButtonElement>();

/** 同一条评论上一次被应用的状态，用于去重，也用于「设置改了要重新套用」。 */
interface CommentAppliedState {
    option: DynamicSponsorOption;
    text: string;
    /** 上次判定得到的疑似度，供自检统计复用（避免为统计重复跑检测） */
    confidence?: number;
    /** 上次命中的证据特征数，同样是为了自检统计 */
    featureCount?: number;
}

/** 每个类别在 DOM 上留下的标记，回滚时据此认定「这是我干的」。 */
const GOODS_HIDDEN_ATTR = "data-dynamic-sponsor-hidden";
const AICG_CONTENT_HIDDEN_ATTR = "data-aicg-content-hidden";
const AICG_CARD_HIDDEN_ATTR = "data-aicg-card-hidden";

/** 键是评论卡片节点，值是上次应用的类别与文本。 */
const appliedComments = new WeakMap<HTMLElement, Map<string, CommentAppliedState>>();

function getApplied(card: HTMLElement, category: string): CommentAppliedState | undefined {
    return appliedComments.get(card)?.get(category);
}

function setApplied(card: HTMLElement, category: string, state: CommentAppliedState | undefined): void {
    let map = appliedComments.get(card);
    if (!map) {
        map = new Map();
        appliedComments.set(card, map);
    }
    if (state) map.set(category, state);
    else map.delete(category);
}

/**
 * 一条评论在 DOM 里的引用。
 *
 * 取法与上游 `SponsorComment` 完全一致（`thread.shadowRoot.querySelector("bili-comment-renderer")`、
 * `#content`、`bili-comment-user-info` 的 `#user-up/#user-level`、`#reply`），
 * 只是把「怎么拿到一条评论」收敛成一个函数，商品链接与 AICG 共用同一份，
 * B 站改版时只需要改这里，不会两份选择器各改一遍。
 */
interface CommentNode {
    card: HTMLElement;
    shadow: ShadowRoot;
    content: HTMLElement | null;
    userInfo: ShadowRoot | undefined;
    labelAnchor: HTMLElement | undefined;
    actions: ShadowRoot | undefined;
    replyButton: HTMLElement | null;
}

function forEachComment(root: HTMLElement, visit: (node: CommentNode) => void): void {
    const shadow = root.shadowRoot;
    if (!shadow) return;

    const visitCard = (card: HTMLElement | null | undefined) => {
        const cardShadow = card?.shadowRoot;
        if (!card || !cardShadow) return;
        const userInfo = cardShadow.querySelector("bili-comment-user-info")?.shadowRoot ?? undefined;
        const actions = cardShadow.querySelector("bili-comment-action-buttons-renderer")?.shadowRoot ?? undefined;
        visit({
            card,
            shadow: cardShadow,
            content: cardShadow.querySelector<HTMLElement>("#content"),
            userInfo,
            labelAnchor: userInfo?.querySelector<HTMLElement>("#user-up, #user-level"),
            actions,
            replyButton: actions?.querySelector<HTMLElement>("#reply") ?? null,
        });
    };

    for (const thread of shadow.querySelectorAll<HTMLElement>("bili-comment-thread-renderer")) {
        const threadShadow = thread.shadowRoot;
        if (!threadShadow) continue;
        visitCard(threadShadow.querySelector<HTMLElement>("bili-comment-renderer"));

        const repliesRoot = threadShadow.querySelector("bili-comment-replies-renderer")?.shadowRoot;
        if (!repliesRoot) continue;
        for (const reply of repliesRoot.querySelectorAll<HTMLElement>("bili-comment-reply-renderer")) {
            visitCard(reply);
        }
    }
}

/**
 * 跨扫描累积的评论上下文。
 *
 * B 站评论区是滚动逐步加载的：一次扫描往往只有几条评论在 DOM 里，
 * 如果只拿当前这批算「模板复用/相似度」，前期加载的评论永远没有证据。
 * 这里把见过的评论文本按页面累积起来（去重 + 上限），
 * 让判定在评论逐步到达时也能保持稳定。
 */
const PEER_CACHE_LIMIT = 400;
const peerCache = { texts: [] as string[], authors: [] as string[], seen: new Set<string>() };

export function resetAicgPeerCache(): void {
    peerCache.texts = [];
    peerCache.authors = [];
    peerCache.seen.clear();
}

function rememberPeer(text: string, author: string): void {
    if (!text) return;
    // 同一条评论（同作者同文本）只记一次，避免滚动重渲染把权重刷高。
    const key = `${author}\u0000${text}`;
    if (peerCache.seen.has(key)) return;
    peerCache.seen.add(key);
    peerCache.texts.push(text);
    peerCache.authors.push(author);
    if (peerCache.texts.length > PEER_CACHE_LIMIT) {
        const drop = peerCache.texts.length - PEER_CACHE_LIMIT;
        peerCache.texts.splice(0, drop);
        peerCache.authors.splice(0, drop);
        // seen 只用于去重，超出上限时整体重建，避免无限增长。
        peerCache.seen = new Set(peerCache.texts.map((value, index) => `${peerCache.authors[index]}\u0000${value}`));
    }
}

/**
 * 评论区过滤：商品链接与疑似 AICG 共用同一条执行路径。
 *
 * 判定是外置的（`content/aicg/detector`），这里只做三件事：
 * 收集文本 -> 交给判定 -> 用同一套 `labelSponsorStyle` / `hideSponsorContent` 落地。
 */
function SponsorComment(root: HTMLElement) {
    const goodsOption = getCategorySelection("dynamicSponsor_sponsor")?.option ?? DynamicSponsorOption.Disabled;
    const aicgOption = getAicgOption();
    const goodsEnabled = goodsOption !== DynamicSponsorOption.Disabled;
    const aicgEnabled = isAicgEnabled();
    if (!goodsEnabled && !aicgEnabled) return;

    // 第一遍只读文本：疑似 AICG 需要跨评论上下文，一次扫描构建一次。
    const aicgDetector = aicgEnabled ? new HeuristicAicgDetector() : null;
    const aicgTuning = aicgEnabled ? getAicgTuning() : null;
    let aicgContext: ReturnType<typeof createAicgContext> | null = null;
    /** 本次扫描里每个作者发的主评论数（不含子评论）：同账号连发是批量信号。 */
    const authorPostCounts = new Map<string, number>();
    if (aicgEnabled) {
        forEachComment(root, (node) => {
            if (!node.content) return;
            const author = readCommentAuthor(node.card);
            rememberPeer(readCommentText(node.content), author);
            // 只有主评论计入连发统计；真人也可能连发好几条回复，那不算刷屏。
            if (node.card.tagName.toLowerCase() === "bili-comment-renderer" && author) {
                authorPostCounts.set(author, (authorPostCounts.get(author) ?? 0) + 1);
            }
        });
        aicgContext = createAicgContext(peerCache.texts, peerCache.authors);
    }

    // 第二遍落地：两个类别各读自己的选项，复用同一套打标签/隐藏函数。
    const stats: AicgScanStats | null = aicgTuning?.debug
        ? { scanned: 0, eligible: 0, empty: 0, peers: peerCache.texts.length, featureMax: 0, markerMax: 0, hits: 0, top: 0, threshold: aicgTuning.threshold, minLength: aicgTuning.minLength }
        : null;

    forEachComment(root, (node) => {
        const { card, content, labelAnchor, actions, replyButton } = node;
        if (!content) return;

        const author = readCommentAuthor(card);
        const whitelisted = isWhitelistedAuthor(author);
        const target: CommentTarget = {
            card,
            content,
            labelAnchor,
            actions: actions ?? null,
            replyButton,
            author,
            text: readCommentText(content),
            authorPostCount: authorPostCounts.get(author) ?? 0,
        };

        if (goodsEnabled && !whitelisted) {
            applyGoodsCategory(target, goodsOption);
        } else if (getApplied(card, "dynamicSponsor_sponsor")) {
            revertCategory(target, "dynamicSponsor_sponsor");
        }

        if (aicgEnabled && !whitelisted && aicgDetector && aicgTuning && aicgContext) {
            applyAicgCategory(target, aicgOption, aicgDetector, aicgTuning, aicgContext, stats ?? undefined);
        } else if (getApplied(card, AICG_CATEGORY)) {
            // 类别被关掉后，把之前加上的标签/隐藏效果回滚，避免设置改了页面没变。
            revertCategory(target, AICG_CATEGORY);
        }
    });

    if (stats) renderAicgScanStatus(root, stats);

    if (Config.config.commentSponsorReplyBlock && goodsEnabled) {
        hideGoodsReplyThreads(root);
    }
}

/** 自检统计：让用户能区分「没扫到」和「扫了但没命中」。 */
interface AicgScanStats {
    scanned: number;
    eligible: number;
    /** 正文读出来是空串的条数（DOM 选择器失效时会全部为空） */
    empty: number;
    /** 最短/最长正文长度，用来判断是不是都被最小长度挡住了 */
    shortest?: number;
    longest?: number;
    /** 第一条非空正文的样例，用来确认读到的到底是什么 */
    sample?: string;
    /** 跨扫描累积到的评论条数：只有 1~2 条时必然没有跨评论证据 */
    peers: number;
    /** 单条评论最多命中的证据特征数，用来区分「没证据」和「证据被闸门压掉」 */
    featureMax: number;
    /** 单条评论最多出现几个「标记」特征（人设/称呼/动作/推广） */
    markerMax: number;
    hits: number;
    top: number;
    threshold: number;
    minLength: number;
}

const AICG_STATUS_ID = "aicgScanStatus";

/** 与检测器里的「标记特征」保持一致的集合，仅用于自检统计显示。 */
const AICG_MARKER_FEATURES = new Set<AicgFeatureId>([
    "personaSelfReference",
    "ownerAddress",
    "actionNarration",
    "promoInstruction",
    "reportClosing",
    "sameAuthorBurst",
]);

/** 这条 mutation 是否只是自检信息自己的变化（是则不该触发重新扫描）。 */
function isAicgStatusMutation(record: MutationRecord): boolean {
    if (record.target instanceof Element) {
        if (record.target.id === AICG_STATUS_ID) return true;
        return Boolean(record.target.closest(`#${AICG_STATUS_ID}`));
    }
    const parent = record.target.parentElement;
    if (parent) {
        if (parent.id === AICG_STATUS_ID) return true;
        return Boolean(parent.closest(`#${AICG_STATUS_ID}`));
    }
    return false;
}

/**
 * 在评论区顶部显示一行自检信息（仅在「显示命中特征」打开时）。
 *
 * 没有这行字，用户只能看到「没有任何标签」，无法判断是
 * 评论没加载 / 类别没生效 / 阈值太高，排查只能靠猜。
 */
function renderAicgScanStatus(root: HTMLElement, stats: AicgScanStats): void {
    const shadow = root.shadowRoot;
    if (!shadow) return;

    const text =
        `疑似 AICG 自检：已扫描 ${stats.scanned} 条评论`
        + `，正文为空 ${stats.empty} 条`
        + `，够长参与判定 ${stats.eligible} 条`
        + `，命中 ${stats.hits} 条`
        + `\n上下文累积 ${stats.peers} 条 / 单条最多命中特征 ${stats.featureMax} 项 / 其中标记 ${stats.markerMax} 个`
        + `\n最高疑似度 ${stats.top.toFixed(2)} / 当前阈值 ${stats.threshold} / 最小长度 ${stats.minLength}`
        + (stats.shortest !== undefined && stats.shortest !== null
            ? `\n正文长度 ${stats.shortest}~${stats.longest}`
            : "")
        + (stats.sample ? `\n样例：${stats.sample}` : "");

    // 排查提示只在「零命中」时给出：已经有命中的话，用户要的不是排查建议。
    let hint = "";
    if (stats.hits === 0) {
        if (stats.scanned === 0) {
            hint = "→ 没有扫到任何评论，评论区可能还没加载出来。";
        } else if (stats.empty === stats.scanned) {
            hint = "→ 正文没读到，可能是 B 站评论结构变了（请把这行反馈给我）。";
        } else if (stats.eligible === 0) {
            hint = `→ 评论都短于最小长度 ${stats.minLength}，把「最小检测长度」调小试试。`;
        } else if (stats.markerMax >= 2) {
            hint = "→ 已经出现 2 个以上标记特征，本应命中；若没看到标签请把这几行反馈给我。";
        } else if (stats.markerMax === 1) {
            hint = "→ 只出现 1 个标记特征（人设/称呼/动作/推广/收尾/连发），按设计需要 2 个以上才判定。";
        } else if (stats.peers < 3) {
            hint = "→ 上下文只有很少几条评论，既没有标记也凑不出跨评论证据；把评论区往下滚多加载几条。";
        } else if (stats.featureMax === 0) {
            hint = "→ 该批评论没有触发任何特征：它们大概率不是同一套模板/AI 文本。";
        } else if (stats.top === 0) {
            hint = "→ 命中了弱特征，但既没有 2 个以上标记、也没有跨评论证据，按设计不会标记。";
        } else {
            const suggested = Math.max(0.05, Math.floor((stats.top - 0.05) * 20) / 20);
            hint = `→ 有证据但最高只有 ${stats.top.toFixed(2)}，低于阈值 ${stats.threshold}；把阈值调到 ${suggested.toFixed(2)} 左右试试。`;
        }
    }

    const fullText = hint ? `${text}\n${hint}` : text;

    let element = shadow.querySelector<HTMLElement>(`#${AICG_STATUS_ID}`);
    if (!element) {
        element = document.createElement("div");
        element.id = AICG_STATUS_ID;
        element.style.cssText = [
            "margin:8px 0",
            "padding:6px 10px",
            "border-radius:6px",
            "font-size:12px",
            "line-height:1.6",
            "background:rgba(142,45,226,.12)",
            "border:1px solid rgba(142,45,226,.5)",
            "color:inherit",
            "white-space:pre-line",
        ].join(";");
        element.dataset.value = fullText;
        element.textContent = fullText;
        shadow.insertBefore(element, shadow.firstChild);
        return;
    }

    // 内容没变就不要再写 DOM：写 textContent 会产生 childList 变更，
    // 又触发我们自己的扫描、再写一次，不挡住会变成无限扫描循环（实测能卡死页面）。
    if (element.dataset.value === fullText) return;
    element.dataset.value = fullText;
    element.textContent = fullText;
}

/** 应用阶段需要的引用（文本与作者只读一次，避免每条评论重复遍历 DOM）。 */
interface CommentTarget {
    card: HTMLElement;
    content: HTMLElement;
    /** 上游用的标签锚点（用户信息区的 #user-up/#user-level）；子评论可能没有 */
    labelAnchor: HTMLElement | null;
    actions: ShadowRoot | null;
    replyButton: HTMLElement | null;
    author: string;
    text: string;
    /** 本作者在本次扫描里的主评论数（0 表示拿不到作者信息） */
    authorPostCount: number;
}

/** 白名单作者默认跳过；开启「无视白名单」后不再跳过。 */
function isWhitelistedAuthor(author: string): boolean {
    const channels = Config.config.whitelistedChannels;
    if (!channels?.length) return false;
    if (Config.config.dynamicAndCommentSponsorWhitelistedChannels) return false;
    // 头像信息延迟加载时，不能因此把白名单作者的评论隐藏掉。
    if (!author) return true;
    return channels.some((channel) => channel.id === author);
}

function applyGoodsCategory(target: CommentTarget, option: DynamicSponsorOption): void {
    const richText = target.content.querySelector("bili-rich-text")?.shadowRoot;
    const hasGoods = Boolean(richText?.querySelector('a[data-type="goods"]'));
    if (!hasGoods) return;

    const applied = getApplied(target.card, "dynamicSponsor_sponsor");
    if (applied?.option === option && applied.text === target.text) return;

    if (applied) revertCategory(target, "dynamicSponsor_sponsor");

    ensureLabel(target, "commentSponsorLabel", "dynamicSponsor_sponsor", false, null);

    if (option === DynamicSponsorOption.Hide) {
        // 操作区/回复按钮可能比正文晚挂载。此时先不记录「已处理」，
        // 下一次扫描会再试一次，避免评论被永久漏掉。
        if (!target.replyButton) return;
        hideSponsorContent(target.content, target.replyButton, true);
        // 打上本类别自己的标记，回滚时只复原自己造成的隐藏。
        target.content.setAttribute(GOODS_HIDDEN_ATTR, "true");
    }

    setApplied(target.card, "dynamicSponsor_sponsor", { option, text: target.text });
}

function applyAicgCategory(
    target: CommentTarget,
    option: DynamicSponsorOption,
    detector: HeuristicAicgDetector,
    tuning: ReturnType<typeof getAicgTuning>,
    context: ReturnType<typeof createAicgContext>,
    stats?: AicgScanStats,
): void {
    if (stats) stats.scanned++;

    // 过短的评论不参与判定，也不改动 DOM。
    const body = normalizeCommentText(stripMentionPrefix(target.text));
    if (stats) {
        const raw = (target.text ?? "").trim();
        if (!raw) stats.empty++;
        else {
            stats.shortest = stats.shortest === undefined ? codePointLength(body) : Math.min(stats.shortest, codePointLength(body));
            stats.longest = stats.longest === undefined ? codePointLength(body) : Math.max(stats.longest, codePointLength(body));
            if (!stats.sample) stats.sample = `${raw.slice(0, 40)}${raw.length > 40 ? "…" : ""}`;
        }
    }
    if (!body || codePointLength(body) < tuning.minLength) return;
    if (stats) stats.eligible++;

    const applied = getApplied(target.card, AICG_CATEGORY);
    if (applied?.option === option && applied.text === body) {
        // 已经处理过：不重复跑检测，但自检统计仍要把这条算上，
        // 否则第二次扫描会把「命中」显示成 0，看起来像完全没生效。
        if (stats) {
            stats.top = Math.max(stats.top, applied.confidence ?? 0);
            stats.featureMax = Math.max(stats.featureMax, applied.featureCount ?? 0);
            if (applied.option !== DynamicSponsorOption.Disabled) stats.hits++;
        }
        return;
    }

    const result = detector.detect(
        { text: target.text, minDetectableLength: tuning.minLength, peers: [], author: target.author, authorPostCount: target.authorPostCount },
        context,
    );
    if (stats) {
        stats.top = Math.max(stats.top, result.confidence);
        stats.featureMax = Math.max(stats.featureMax, result.features.length);
        stats.markerMax = Math.max(
            stats.markerMax,
            result.features.filter((feature) => AICG_MARKER_FEATURES.has(feature.id)).length,
        );
    }
    const decision = decideAicgOption(result, option, tuning);
    if (stats && decision.option !== DynamicSponsorOption.Disabled) stats.hits++;

    if (decision.option === DynamicSponsorOption.Disabled) {
        // 之前命中过、这次不命中（例如阈值调高了），要把旧效果撤掉。
        if (applied) revertCategory(target, AICG_CATEGORY);
        return;
    }

    if (applied) revertCategory(target, AICG_CATEGORY);

    const debugText = tuning.debug
        ? summarizeFeatures(decision.features).map((id) => chrome.i18n.getMessage(`aicgFeature_${id}`))
        : undefined;
    ensureLabel(target, "commentAicgLabel", AICG_CATEGORY, tuning.debug, debugText);

    if (decision.option === DynamicSponsorOption.HideCard) {
        if (target.card.getAttribute(AICG_CARD_HIDDEN_ATTR) !== "true") {
            target.card.setAttribute(AICG_CARD_HIDDEN_ATTR, "true");
            target.card.style.display = "none";
        }
    } else if (decision.option === DynamicSponsorOption.Hide) {
        // 回复按钮可能晚挂载；没有它就先不记录已处理，下次扫描重试。
        if (!target.replyButton) return;
        hideSponsorContent(target.content, target.replyButton, true, {
            toggleId: "showAicgContent",
            showText: "aicgShowContent",
            hideText: "aicgHideContent",
        });
        target.content.setAttribute(AICG_CONTENT_HIDDEN_ATTR, "true");
    }

    setApplied(target.card, AICG_CATEGORY, { option: decision.option, text: body, confidence: result.confidence, featureCount: result.features.length });
}

/** 打标签；标签是插在锚点元素后面的兄弟节点，所以查重要在锚点父级里做。 */
function ensureLabel(
    target: CommentTarget,
    labelId: string,
    category: string,
    debugMode: boolean,
    debugText?: string[] | null,
    anchor: HTMLElement | null = target.labelAnchor ?? target.content,
): void {
    if (!anchor) return;
    const scope = (anchor.parentElement as ParentNode | null)
        ?? (anchor.getRootNode() instanceof ShadowRoot ? (anchor.getRootNode() as ParentNode) : null);
    if (!scope || scope.querySelector(`#${labelId}`)) return;

    labelSponsorStyle(labelId, anchor, category, debugMode, debugText ?? null, true);
}

/** 回滚单个类别在一条评论上留下的效果，绝不动别的类别。 */
function revertCategory(target: CommentTarget, category: string): void {
    const isAicg = category === AICG_CATEGORY;
    const labelId = isAicg ? "commentAicgLabel" : "commentSponsorLabel";
    const toggleId = isAicg ? "showAicgContent" : "showDynamicSponsor";

    const anchor = target.labelAnchor;
    const scope = (anchor.parentElement as ParentNode | null)
        ?? (anchor.getRootNode() instanceof ShadowRoot ? (anchor.getRootNode() as ParentNode) : null);
    scope?.querySelector(`#${labelId}`)?.remove();
    target.actions?.querySelector(`#${toggleId}`)?.remove();

    // 只有本类别打过的标记才复原，避免把另一个类别的隐藏状态清掉。
    const contentAttr = isAicg ? AICG_CONTENT_HIDDEN_ATTR : GOODS_HIDDEN_ATTR;
    if (target.content.getAttribute(contentAttr) === "true") {
        target.content.removeAttribute(contentAttr);
        target.content.style.display = "";
    }
    if (isAicg && target.card.getAttribute(AICG_CARD_HIDDEN_ATTR) === "true") {
        target.card.removeAttribute(AICG_CARD_HIDDEN_ATTR);
        target.card.style.display = "";
    }

    setApplied(target.card, category, undefined);
}

/** 隐藏被判定为商品链接的评论下的默认子评论，保留「展开全部」入口。 */
function hideGoodsReplyThreads(root: HTMLElement): void {
    for (const thread of root.shadowRoot.querySelectorAll<HTMLElement>("bili-comment-thread-renderer")) {
        if (expandedReplyThreads.has(thread)) continue;
        const repliesRoot = thread.shadowRoot?.querySelector("bili-comment-replies-renderer")?.shadowRoot;
        if (!repliesRoot) continue;
        for (const reply of repliesRoot.querySelectorAll<HTMLElement>("bili-comment-reply-renderer")) {
            if (reply.style.display !== "none") reply.style.display = "none";
        }
        const expandButton = repliesRoot.querySelector("bili-text-button")?.shadowRoot?.querySelector("button");
        if (expandButton && !wiredReplyButtons.has(expandButton)) {
            wiredReplyButtons.add(expandButton);
            expandButton.addEventListener("click", () => {
                expandedReplyThreads.add(thread);
                for (const reply of repliesRoot.querySelectorAll<HTMLElement>("bili-comment-reply-renderer")) {
                    reply.style.display = "";
                }
            }, { once: true });
        }
    }
}
