/** @jest-environment jsdom */
/**
 * 评论区过滤的整合测试。
 *
 * 「疑似 AICG 内容」与「商品链接」共用同一条执行路径（`SponsorComment`），
 * 处理方式来自同一个 `dynamicSponsorSelections` 表，所以这里直接驱动
 * 真实的 `CommentListener`，和 `commentSponsorBlock.test.ts` 一样，
 * 而不是另测一套 DOM 执行器。
 */

import { DynamicSponsorOption } from "../src/types";

jest.mock("../src/config", () => ({ __esModule: true, default: { config: {} } }));
jest.mock("../src/thumbnail-utils/thumbnails", () => ({ insertSBIconDefinition: jest.fn() }));
jest.mock("../src/utils/cleanup", () => ({ addCleanupListener: jest.fn() }));
jest.mock("../src/content/state", () => ({ getPageLoaded: () => true }));
jest.mock("../src/content/pageReadiness", () => ({ waitForPageReady: jest.fn() }));

let Config: typeof import("../src/config").default;
let addCleanupListener: typeof import("../src/utils/cleanup").addCleanupListener;
let CommentListener: typeof import("../src/render/DynamicAndCommentSponsorBlock").CommentListener;

function component(name: string, parent: Node, html = "") {
    const host = document.createElement(name);
    host.attachShadow({ mode: "open" }).innerHTML = html;
    parent.appendChild(host);
    return host;
}

/** 模板化评论，模拟批量生成的 AI 评论。 */
function templateComment(owner: string, index: number): string {
    return `@${owner} 新版跟源仓库彻底隔离、写操作全原子锁，两个进程同时跑也不撞。看：https://www.bilibili.com/video/BV1JEnn6VE2A (${index})`;
}

const HUMAN_COMMENT = "这个功能我上周也踩过坑，主要是移动端设置页根本点不开，改成右边栏确实顺手不少。";

interface Fixture {
    root: HTMLElement;
    feed: HTMLElement;
    threads: HTMLElement[];
    cards: HTMLElement[];
    contents: HTMLElement[];
    users: HTMLElement[];
    actions: HTMLElement[];
}

/** 每条评论各自一个 thread（与真实 DOM 一致），可指定作者与是否带商品链接。 */
function fixture(
    texts: string[],
    options: { authors?: string[]; goodsIndexes?: number[] } = {},
): Fixture {
    const root = component("bili-comments", document.body, '<div id="feed"></div>');
    const feed = root.shadowRoot.querySelector<HTMLElement>("#feed");
    const threads: HTMLElement[] = [];
    const cards: HTMLElement[] = [];
    const contents: HTMLElement[] = [];
    const users: HTMLElement[] = [];
    const actions: HTMLElement[] = [];

    texts.forEach((text, index) => {
        const thread = component("bili-comment-thread-renderer", feed);
        const author = options.authors?.[index] ?? `author${index}`;
        const card = component(
            "bili-comment-renderer",
            thread.shadowRoot,
            `<div id="content"></div><div id="user-avatar" data-user-profile-id="${author}"></div>`,
        );
        const content = card.shadowRoot.querySelector<HTMLElement>("#content");
        const rich = component("bili-rich-text", content);
        const goods = options.goodsIndexes?.includes(index) ? '<a data-type="goods">product</a>' : "";
        rich.shadowRoot.innerHTML = `${goods}<span>${text}</span>`;
        const user = component("bili-comment-user-info", card.shadowRoot, '<span id="user-level">Lv6</span>');
        const actionBar = component(
            "bili-comment-action-buttons-renderer",
            card.shadowRoot,
            '<button id="reply">reply</button>',
        );

        threads.push(thread);
        cards.push(card);
        contents.push(content);
        users.push(user);
        actions.push(actionBar);
    });

    return { root, feed, threads, cards, contents, users, actions };
}

function labelIn(users: HTMLElement[], labelId: string) {
    return users.flatMap((user) => Array.from(user.shadowRoot.querySelectorAll(`#${labelId}`)));
}

beforeEach(async () => {
    jest.resetModules();
    Config = (await import("../src/config")).default;
    ({ addCleanupListener } = await import("../src/utils/cleanup"));
    ({ CommentListener } = await import("../src/render/DynamicAndCommentSponsorBlock"));
    jest.useFakeTimers();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    (global as unknown as { chrome: unknown }).chrome = { i18n: { getMessage: (key: string) => key } };
    Object.assign(Config.config, {
        dynamicAndCommentSponsorBlocker: true,
        commentSponsorBlock: true,
        commentSponsorReplyBlock: false,
        dynamicAndCommentSponsorWhitelistedChannels: false,
        whitelistedChannels: [],
        commentAicgThreshold: 0.55,
        commentAicgMinLength: 12,
        commentAicgDebug: false,
        dynamicSponsorSelections: [
            { name: "dynamicSponsor_sponsor", option: DynamicSponsorOption.Hide },
            { name: "dynamicSponsor_aicg", option: DynamicSponsorOption.Disabled },
        ],
        dynamicSponsorTypes: {
            dynamicSponsor_sponsor: { color: "#007800", opacity: "0.7" },
            dynamicSponsor_aicg: { color: "#8e2de2", opacity: "0.7" },
        },
    });
});

afterEach(() => {
    for (const [cleanup] of (addCleanupListener as jest.Mock).mock.calls) cleanup();
    jest.clearAllMocks();
    jest.useRealTimers();
    document.body.replaceChildren();
});

function setAicg(option: DynamicSponsorOption) {
    const entry = Config.config.dynamicSponsorSelections.find((s) => s.name === "dynamicSponsor_aicg");
    if (entry) entry.option = option;
    else Config.config.dynamicSponsorSelections.push({ name: "dynamicSponsor_aicg" as never, option });
}

describe("疑似 AICG 类别", () => {
    test("禁用时不添加标签，也不改动评论", () => {
        const f = fixture([...Array.from({ length: 6 }, (_, i) => templateComment("owner", i))]);
        CommentListener();
        jest.advanceTimersByTime(6000);

        expect(labelIn(f.users, "commentAicgLabel")).toHaveLength(0);
        expect(f.contents[0].style.display).toBe("");
    });

    test("仅添加标签：模板评论带上类别标签，人工评论不受影响", () => {
        setAicg(DynamicSponsorOption.ShowOverlay);
        const texts = [
            ...Array.from({ length: 6 }, (_, i) => templateComment("owner", i)),
            HUMAN_COMMENT,
        ];
        const f = fixture(texts);
        CommentListener();
        jest.advanceTimersByTime(6000);

        const labels = labelIn(f.users, "commentAicgLabel");
        expect(labels.length).toBeGreaterThanOrEqual(6);
        // 标签用的是类别文案，不是另起一套
        expect(labels[0].querySelector(".Label").textContent).toBe("category_dynamicSponsor_aicg");
        // 规范的真人评论不被误伤
        expect(labelIn([f.users[6]], "commentAicgLabel")).toHaveLength(0);
        expect(f.contents[6].style.display).toBe("");
    });

    test("隐藏内容：只隐藏正文，容器与交互仍在", () => {
        setAicg(DynamicSponsorOption.Hide);
        const f = fixture(Array.from({ length: 6 }, (_, i) => templateComment("owner", i)));
        CommentListener();
        jest.advanceTimersByTime(6000);

        expect(f.contents[0].style.display).toBe("none");
        expect(f.cards[0].shadowRoot.querySelector("#content")).not.toBeNull();
        expect(f.actions[0].shadowRoot.querySelector("#showAicgContent")).not.toBeNull();
        // 商品链接那一套按钮没有被误加
        expect(f.actions[0].shadowRoot.querySelector("#showDynamicSponsor")).toBeNull();
    });

    test("隐藏卡片：整条评论不显示", () => {
        setAicg(DynamicSponsorOption.HideCard);
        const f = fixture(Array.from({ length: 6 }, (_, i) => templateComment("owner", i)));
        CommentListener();
        jest.advanceTimersByTime(6000);

        expect(f.cards[0].style.display).toBe("none");
        expect(f.cards[0].getAttribute("data-aicg-card-hidden")).toBe("true");
    });

    test("同一条评论不会被重复处理（标签只有一个）", () => {
        setAicg(DynamicSponsorOption.ShowOverlay);
        const f = fixture(Array.from({ length: 6 }, (_, i) => templateComment("owner", i)));
        CommentListener();
        jest.advanceTimersByTime(6000);
        const before = labelIn(f.users, "commentAicgLabel").length;

        CommentListener();
        jest.advanceTimersByTime(10000);
        expect(labelIn(f.users, "commentAicgLabel")).toHaveLength(before);
    });

    test("动态加载的新评论也会被处理", async () => {
        setAicg(DynamicSponsorOption.ShowOverlay);
        const f = fixture(Array.from({ length: 6 }, (_, i) => templateComment("owner", i)));
        CommentListener();
        jest.advanceTimersByTime(6000);

        const late = fixture([templateComment("late", 99)]);
        // 把新评论挂到已有宿主里，模拟滚动加载
        const thread = late.feed.querySelector("bili-comment-thread-renderer") ?? late.feed.firstElementChild;
        f.feed.appendChild(thread);
        await Promise.resolve();
        jest.advanceTimersByTime(1000);

        expect(labelIn([late.users[0]], "commentAicgLabel")).toHaveLength(1);
    });

    test("子评论（回复）也会被处理", () => {
        setAicg(DynamicSponsorOption.ShowOverlay);
        const f = fixture(Array.from({ length: 6 }, (_, i) => templateComment("owner", i)));
        const replies = component("bili-comment-replies-renderer", f.threads[0].shadowRoot);
        const reply = component(
            "bili-comment-reply-renderer",
            replies.shadowRoot,
            '<div id="content"></div><div id="user-avatar" data-user-profile-id="replyAuthor"></div>',
        );
        const content = reply.shadowRoot.querySelector<HTMLElement>("#content");
        const rich = component("bili-rich-text", content);
        rich.shadowRoot.innerHTML = `<span>${templateComment("replyowner", 0)}</span>`;

        CommentListener();
        jest.advanceTimersByTime(6000);

        expect(reply.shadowRoot.querySelector("#commentAicgLabel")).not.toBeNull();
    });

    test("切换处理方式会立刻在已渲染的评论上生效", () => {
        setAicg(DynamicSponsorOption.ShowOverlay);
        const f = fixture(Array.from({ length: 6 }, (_, i) => templateComment("owner", i)));
        CommentListener();
        jest.advanceTimersByTime(6000);
        expect(f.contents[0].style.display).toBe("");

        // 仅添加标签 -> 隐藏卡片
        setAicg(DynamicSponsorOption.HideCard);
        CommentListener();
        jest.advanceTimersByTime(1000);
        expect(f.cards[0].style.display).toBe("none");

        // 隐藏卡片 -> 仅添加标签：恢复显示，且不留下重复标签
        setAicg(DynamicSponsorOption.ShowOverlay);
        CommentListener();
        jest.advanceTimersByTime(1000);
        expect(f.cards[0].style.display).toBe("");
        expect(labelIn([f.users[0]], "commentAicgLabel")).toHaveLength(1);
    });

    test("关闭类别后回滚之前的标签", () => {
        setAicg(DynamicSponsorOption.ShowOverlay);
        const f = fixture(Array.from({ length: 6 }, (_, i) => templateComment("owner", i)));
        CommentListener();
        jest.advanceTimersByTime(6000);
        expect(labelIn(f.users, "commentAicgLabel").length).toBeGreaterThan(0);

        setAicg(DynamicSponsorOption.Disabled);
        CommentListener();
        jest.advanceTimersByTime(1000);
        expect(labelIn(f.users, "commentAicgLabel")).toHaveLength(0);
    });

    test("白名单作者会被跳过", () => {
        setAicg(DynamicSponsorOption.ShowOverlay);
        Config.config.whitelistedChannels = [{ id: "author0" } as { id: string; name: string }];
        const f = fixture(Array.from({ length: 6 }, (_, i) => templateComment("owner", i)));
        CommentListener();
        jest.advanceTimersByTime(6000);

        expect(labelIn([f.users[0]], "commentAicgLabel")).toHaveLength(0);
        expect(labelIn([f.users[1]], "commentAicgLabel")).toHaveLength(1);
    });
    test("关闭「启用评论区隐藏」后，AICG 也不处理（与界面文案一致）", () => {
        setAicg(DynamicSponsorOption.HideCard);
        Config.config.commentSponsorBlock = false;
        const f = fixture(Array.from({ length: 6 }, (_, i) => templateComment("owner", i)));
        CommentListener();
        jest.advanceTimersByTime(6000);

        expect(f.cards[0].style.display).toBe("");
        expect(labelIn(f.users, "commentAicgLabel")).toHaveLength(0);
    });

    test("总开关关闭时 AICG 也不处理", () => {
        setAicg(DynamicSponsorOption.HideCard);
        Config.config.dynamicAndCommentSponsorBlocker = false;
        const f = fixture(Array.from({ length: 6 }, (_, i) => templateComment("owner", i)));
        CommentListener();
        jest.advanceTimersByTime(6000);

        expect(f.cards[0].style.display).toBe("");
        expect(labelIn(f.users, "commentAicgLabel")).toHaveLength(0);
    });
    test("打开「显示命中特征」时在评论区顶部显示自检信息", () => {
        setAicg(DynamicSponsorOption.ShowOverlay);
        Config.config.commentAicgDebug = true;
        const f = fixture(Array.from({ length: 6 }, (_, i) => templateComment("owner", i)));
        CommentListener();
        jest.advanceTimersByTime(6000);

        const status = f.root.shadowRoot.querySelector("#aicgScanStatus");
        expect(status).not.toBeNull();
        expect(status.textContent).toContain("已扫描 6 条评论");
        expect(status.textContent).toContain("命中 6 条");
        // 阈值与最小长度也一并显示，便于用户判断是不是阈值太高
        expect(status.textContent).toContain("0.55");
        expect(status.textContent).toContain("12");
    });

    test("未打开调试时不显示自检信息", () => {
        setAicg(DynamicSponsorOption.ShowOverlay);
        const f = fixture(Array.from({ length: 6 }, (_, i) => templateComment("owner", i)));
        CommentListener();
        jest.advanceTimersByTime(6000);
        expect(f.root.shadowRoot.querySelector("#aicgScanStatus")).toBeNull();
    });

    test("自检信息能反映「扫到了但没命中」", () => {
        setAicg(DynamicSponsorOption.ShowOverlay);
        Config.config.commentAicgDebug = true;
        // 真人风格评论，彼此不相似：应当扫到但命中 0
        const texts = [
            HUMAN_COMMENT,
            "我上周也遇到过，重装一下插件就好了，不过记得先导出配置。",
            "这个功能在手机上确实不好用，我一般用电脑看。",
        ];
        const f = fixture(texts);
        CommentListener();
        jest.advanceTimersByTime(6000);

        const status = f.root.shadowRoot.querySelector("#aicgScanStatus");
        expect(status.textContent).toContain("已扫描 3 条评论");
        expect(status.textContent).toContain("命中 0 条");
    });
});

describe("与商品链接类别共存", () => {
    test("两个类别各自独立生效，互不干扰", () => {
        setAicg(DynamicSponsorOption.ShowOverlay);
        const f = fixture(
            [...Array.from({ length: 6 }, (_, i) => templateComment("owner", i))],
            { goodsIndexes: [0] },
        );
        CommentListener();
        jest.advanceTimersByTime(6000);

        // 商品链接类别仍是「隐藏内容」：标签 + 隐藏 + 专用按钮
        expect(f.users[0].shadowRoot.querySelector("#commentSponsorLabel")).not.toBeNull();
        expect(f.contents[0].style.display).toBe("none");
        expect(f.actions[0].shadowRoot.querySelector("#showDynamicSponsor")).not.toBeNull();

        // AICG 类别是「仅添加标签」：只加标签，不动内容
        expect(f.users[0].shadowRoot.querySelector("#commentAicgLabel")).not.toBeNull();
        expect(f.actions[0].shadowRoot.querySelector("#showAicgContent")).toBeNull();

        // 其余评论只命中 AICG
        expect(f.users[1].shadowRoot.querySelector("#commentSponsorLabel")).toBeNull();
        expect(f.users[1].shadowRoot.querySelector("#commentAicgLabel")).not.toBeNull();
    });

    test("商品链接类别禁用时，AICG 仍可独立工作", () => {
        setAicg(DynamicSponsorOption.HideCard);
        Config.config.dynamicSponsorSelections[0].option = DynamicSponsorOption.Disabled;
        const f = fixture(
            [...Array.from({ length: 6 }, (_, i) => templateComment("owner", i))],
            { goodsIndexes: [0] },
        );
        CommentListener();
        jest.advanceTimersByTime(6000);

        expect(f.users[0].shadowRoot.querySelector("#commentSponsorLabel")).toBeNull();
        expect(f.cards[0].style.display).toBe("none");
    });

    test("两个类别都禁用时不改动 DOM", () => {
        Config.config.dynamicSponsorSelections[0].option = DynamicSponsorOption.Disabled;
        const f = fixture(
            [...Array.from({ length: 6 }, (_, i) => templateComment("owner", i))],
            { goodsIndexes: [0] },
        );
        CommentListener();
        jest.advanceTimersByTime(6000);

        expect(f.contents[0].style.display).toBe("");
        expect(f.cards[0].style.display).toBe("");
        expect(labelIn(f.users, "commentAicgLabel")).toHaveLength(0);
    });
});
