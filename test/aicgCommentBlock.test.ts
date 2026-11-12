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
    test("自检信息会带上正文样例，便于判断是不是正文没读到", () => {
        setAicg(DynamicSponsorOption.ShowOverlay);
        Config.config.commentAicgDebug = true;
        const f = fixture(Array.from({ length: 6 }, (_, i) => templateComment("owner", i)));
        CommentListener();
        jest.advanceTimersByTime(6000);

        const status = f.root.shadowRoot.querySelector("#aicgScanStatus");
        expect(status.textContent).toContain("正文为空 0 条");
        expect(status.textContent).toContain("样例：");
        expect(status.textContent).toContain("新版跟源仓库彻底隔离");
    });

    test("正文在 light DOM（slot 组合）时也能读到", () => {
        // 复现真实站点可能的结构：bili-rich-text 的 shadowRoot 里只有一个空的 slot，
        // 正文写在 light DOM 中。只走 shadowRoot 会读出空串。
        const root = component("bili-comments", document.body, '<div id="feed"></div>');
        const thread = component("bili-comment-thread-renderer", root.shadowRoot.querySelector("#feed"));
        const card = component("bili-comment-renderer", thread.shadowRoot, '<div id="content"></div>');
        const content = card.shadowRoot.querySelector<HTMLElement>("#content");
        const rich = component("bili-rich-text", content);
        // 正文放 light DOM；shadow 里只有 slot
        const span = document.createElement("span");
        span.textContent = "light-dom 里的正文内容，长度足够参与判定。";
        rich.appendChild(span);
        rich.shadowRoot.innerHTML = '<div id="contents"><slot></slot></div>';
        component("bili-comment-user-info", card.shadowRoot, '<span id="user-level">Lv6</span>');
        component("bili-comment-action-buttons-renderer", card.shadowRoot, '<button id="reply">reply</button>');

        setAicg(DynamicSponsorOption.ShowOverlay);
        Config.config.commentAicgDebug = true;
        CommentListener();
        jest.advanceTimersByTime(6000);

        const status = root.shadowRoot.querySelector("#aicgScanStatus");
        expect(status.textContent).toContain("正文为空 0 条");
        expect(status.textContent).toContain("light-dom 里的正文内容");
    });
    test("自检信息在「评论太少」时直接给出可操作提示", () => {
        setAicg(DynamicSponsorOption.ShowOverlay);
        Config.config.commentAicgDebug = true;
        // 只有一条评论：必然没有跨评论证据，最高疑似度必然是 0
        const f = fixture([HUMAN_COMMENT]);
        CommentListener();
        jest.advanceTimersByTime(6000);

        const status = f.root.shadowRoot.querySelector("#aicgScanStatus");
        expect(status.textContent).toContain("单条最多命中特征");
        // 没有标记、也凑不出跨评论证据 -> 提示用户多加载评论
        expect(status.textContent).toContain("其中标记 0 个");
        expect(status.textContent).toContain("跨评论证据");
    });

    test("自检信息在「有证据但低于阈值」时给出建议阈值", () => {
        setAicg(DynamicSponsorOption.ShowOverlay);
        Config.config.commentAicgDebug = true;
        Config.config.commentAicgThreshold = 0.99;
        // 三条语改型模板（非逐字重复，有跨作者短语证据但强度有限）+ 三条真人：
        // 有证据但都低于 0.99，应当提示建议阈值
        const f = fixture([
            "@甲 别纠结了，新版跟源仓库彻底隔离、写操作全原子锁，两个进程并行也不踩。",
            "@乙 值得看一眼：新版跟源仓库彻底隔离、写操作全原子锁，并排跑两个也稳。",
            "@丙 我试过了。新版跟源仓库彻底隔离、写操作全原子锁，双开不会冲突。",
            HUMAN_COMMENT,
            "我上周也遇到过，重装一下插件就好了，不过记得先导出配置。",
            "这个功能在手机上确实不好用，我一般用电脑看。",
        ]);
        CommentListener();
        jest.advanceTimersByTime(6000);

        const status = f.root.shadowRoot.querySelector("#aicgScanStatus");
        expect(status.textContent).toContain("低于阈值 0.99");
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

describe("借鉴同类插件的能力（bilibili-cleaner / YouTube 反垃圾工具）", () => {
    test("用户自定义正则命中即标记：单条评论、无需跨评论证据", () => {
        Config.config.commentAicgCustomRules = "彻底隔离|写操作全原子锁";
        setAicg(DynamicSponsorOption.ShowOverlay);
        // 语改型单条评论：没有成簇证据，也没有任何内容标记
        const f = fixture(["这版跟源仓库彻底隔离了，写盘还有锁保护，挺稳的。"], { authors: ["solo"] });
        CommentListener();
        jest.advanceTimersByTime(6000);

        expect(labelIn(f.users, "commentAicgLabel")).toHaveLength(1);
    });

    test("无效的自定义正则被忽略，不影响其它规则", () => {
        Config.config.commentAicgCustomRules = "([彻底隔离\n真的彻底隔离";
        setAicg(DynamicSponsorOption.ShowOverlay);
        const f = fixture(["评论区有人说真的彻底隔离了，我来求证一下。"], { authors: ["solo"] });
        CommentListener();
        jest.advanceTimersByTime(6000);

        expect(labelIn(f.users, "commentAicgLabel")).toHaveLength(1);
    });

    test("UP 主自己的评论不参与 AICG 判定", () => {
        setAicg(DynamicSponsorOption.ShowOverlay);
        const f = fixture(Array.from({ length: 6 }, (_, i) => templateComment("owner", i)));
        // 给第一条评论挂 UP 徽章（真实 DOM 里 UP 徽章只给视频主人）
        f.users[0].shadowRoot.innerHTML = '<span id="user-up">UP主</span><span id="user-level">Lv6</span>';
        CommentListener();
        jest.advanceTimersByTime(6000);

        expect(labelIn(f.users, "commentAicgLabel")).toHaveLength(5);
        expect(f.users[0].shadowRoot.querySelector("#commentAicgLabel")).toBeNull();
    });

    test("跨视频记忆：本视频学到的短语写回 storage.local", () => {
        const written: Array<Record<string, unknown>> = [];
        (global as unknown as { chrome: unknown }).chrome = {
            i18n: { getMessage: (key: string) => key },
            storage: {
                local: {
                    get: (_key: unknown, done: (items: unknown) => void) => done({}),
                    set: (values: Record<string, unknown>) => written.push(values),
                },
            },
        };
        setAicg(DynamicSponsorOption.ShowOverlay);
        const f = fixture(Array.from({ length: 6 }, (_, i) => templateComment("owner", i)));
        CommentListener();
        jest.advanceTimersByTime(6000);

        const phrases = written.flatMap((write) => Object.keys(write.aicgKnownPhrases ?? {}));
        expect(phrases).toContain("跟源仓库彻底隔离");
    });

    test("跨视频记忆：之前视频学到的短语在新视频里参与判定", () => {
        const localStore: Record<string, unknown> = { aicgKnownPhrases: { "跟源仓库彻底隔离": 1 } };
        (global as unknown as { chrome: unknown }).chrome = {
            i18n: { getMessage: (key: string) => key },
            storage: {
                local: {
                    get: (_key: unknown, done: (items: unknown) => void) => done(localStore),
                    set: () => undefined,
                },
            },
        };
        setAicg(DynamicSponsorOption.ShowOverlay);
        // 单条评论同时含已知短语 + 称呼主人：两个标记配对即命中
        const f = fixture(["主人，这版跟源仓库彻底隔离了，写盘有锁，稳。"], { authors: ["solo"] });
        CommentListener();
        jest.advanceTimersByTime(6000);

        expect(labelIn(f.users, "commentAicgLabel")).toHaveLength(1);
    });
});
