import { expect, test } from "./fixtures/extension";
import type { Page, Worker } from "@playwright/test";
import fs from "fs";
import path from "path";
import {
    defaultMockBvid,
    routeMockBilibiliVideoPage,
} from "./support/bilibiliPage";
import { writeSyncStorage } from "./support/extensionStorage";
import { waitForBilibiliContentScript } from "./support/submissionNotice";

/**
 * 「疑似 AICG 内容」过滤的端到端验证。
 *
 * 评论 DOM 用真实 B 站的多层 ShadowRoot 结构模拟：
 * bili-comments > bili-comment-thread-renderer > bili-comment-renderer > #content。
 * 每条评论各自一个 thread，与真实页面一致。
 */

const TEMPLATE_PEERS = Array.from({ length: 6 }, (_, index) =>
    `@主人 新版跟源仓库彻底隔离、写操作全原子锁，两个进程同时跑也不撞。看：https://www.bilibili.com/video/BV1JEnn6VE2A (${index})`
);

const HUMAN_COMMENT = "这个功能我上周也踩过坑，主要是移动端设置页根本点不开，改成右边栏确实顺手不少。";

/** 在页面里挂一个评论宿主，并写入若干评论文本。 */
async function mountComments(
    page: Page,
    texts: string[],
    options: { withGoodsLinkOnFirst?: boolean } = {}
): Promise<void> {
    await page.evaluate(
        ({ texts, withGoodsLinkOnFirst }) => {
            const add = (tag: string, parent: Node, html = ""): HTMLElement => {
                const host = document.createElement(tag);
                host.attachShadow({ mode: "open" }).innerHTML = html;
                parent.appendChild(host);
                return host;
            };

            let root = document.querySelector<HTMLElement>("bili-comments");
            if (!root || !root.shadowRoot) {
                root = add("bili-comments", document.body, '<div id="feed"></div>');
            }
            const feed = root.shadowRoot.querySelector("#feed");

            for (const [index, text] of texts.entries()) {
                const thread = add("bili-comment-thread-renderer", feed);
                const comment = add("bili-comment-renderer", thread.shadowRoot, '<div id="content"></div>');
                const rich = add("bili-rich-text", comment.shadowRoot.querySelector("#content"));
                rich.shadowRoot.innerHTML = withGoodsLinkOnFirst && index === 0
                    ? `<a data-type="goods">product</a><span>${text}</span>`
                    : `<span>${text}</span>`;
                add("bili-comment-user-info", comment.shadowRoot, '<span id="user-level">Lv6</span>');
                add("bili-comment-action-buttons-renderer", comment.shadowRoot, '<button id="reply">reply</button><span id="like">3</span>');
            }
        },
        { texts, withGoodsLinkOnFirst: options.withGoodsLinkOnFirst === true }
    );
}

/** 追加若干条评论（模拟滚动加载更多评论）。 */
async function appendComments(page: Page, texts: string[]): Promise<void> {
    await page.evaluate((textsToAdd) => {
        const add = (tag: string, parent: Node, html = ""): HTMLElement => {
            const host = document.createElement(tag);
            host.attachShadow({ mode: "open" }).innerHTML = html;
            parent.appendChild(host);
            return host;
        };
        const root = document.querySelector<HTMLElement>("bili-comments");
        const feed = root.shadowRoot.querySelector("#feed");
        for (const text of textsToAdd) {
            const thread = add("bili-comment-thread-renderer", feed);
            const comment = add("bili-comment-renderer", thread.shadowRoot, '<div id="content"></div>');
            const rich = add("bili-rich-text", comment.shadowRoot.querySelector("#content"));
            rich.shadowRoot.innerHTML = `<span>${text}</span>`;
            add("bili-comment-user-info", comment.shadowRoot, '<span id="user-level">Lv6</span>');
            add("bili-comment-action-buttons-renderer", comment.shadowRoot, '<button id="reply">reply</button><span id="like">3</span>');
        }
    }, texts);
}

async function openVideoWithAicg(
    page: Page,
    serviceWorker: Worker,
    sendContentMessage: (message: unknown) => Promise<unknown>,
    settings: Record<string, unknown>
): Promise<void> {
    await writeSyncStorage(serviceWorker, {
        dynamicAndCommentSponsorBlocker: true,
        commentSponsorBlock: true,
        dynamicSponsorBlock: false,
        commentSponsorReplyBlock: false,
        // 关闭商品链接过滤，隔离本功能的观察结果
        dynamicSponsorSelections: [{ name: "dynamicSponsor_sponsor", option: 0 }],
        ...settings,
    });
    await routeMockBilibiliVideoPage(page, { currentTime: 0, paused: true });
    await page.goto(`https://www.bilibili.com/video/${defaultMockBvid}/`);
    await waitForBilibiliContentScript(page, sendContentMessage);
    await page.waitForTimeout(2500);
}

test("禁用时不添加任何标签，也不改动评论", async ({ extensionContext, extensionPage: page, extensionServiceWorker, sendContentMessage }) => {
    await openVideoWithAicg(page, extensionServiceWorker, sendContentMessage, { commentAicgAction: 0 });
    await mountComments(page, [...TEMPLATE_PEERS, TEMPLATE_PEERS[0]]);
    await page.waitForTimeout(1200);

    await expect(page.locator("bili-comments #aicgSuspectLabel")).toHaveCount(0);
    await expect(page.locator("bili-comments #content").first()).toBeVisible();
});

test("仅添加标签：评论保持可见并带一个标签", async ({ extensionPage: page, extensionServiceWorker, sendContentMessage }) => {
    await openVideoWithAicg(page, extensionServiceWorker, sendContentMessage, {
        commentAicgAction: 1,
        commentAicgMinLength: 12,
    });
    await mountComments(page, [...TEMPLATE_PEERS, TEMPLATE_PEERS[0]]);
    await page.waitForTimeout(1200);

    expect(await page.locator("bili-comments #aicgSuspectLabel").count()).toBeGreaterThan(0);
    const label = page.locator("bili-comments #aicgSuspectLabel").first();
    await expect(label).toContainText("疑似 AI");
    // 标签必须真的看得见：没有图标，光靠内边距会渲染成一条看不见的细线。
    const box = await label.boundingBox();
    expect(box).not.toBeNull();
    expect(box.width).toBeGreaterThan(40);
    expect(box.height).toBeGreaterThan(12);
    // 标签文字默认可见（不依赖 hover）
    await expect(label.locator(".Label")).toBeVisible();
    // 评论正文仍然可见
    await expect(page.locator("bili-comments #content").first()).toBeVisible();
});

test("隐藏内容：只隐藏正文，容器与交互仍在，可一键恢复", async ({ extensionPage: page, extensionServiceWorker, sendContentMessage }) => {
    await openVideoWithAicg(page, extensionServiceWorker, sendContentMessage, {
        commentAicgAction: 2,
        commentAicgMinLength: 12,
    });
    await mountComments(page, [...TEMPLATE_PEERS, TEMPLATE_PEERS[0]]);
    await page.waitForTimeout(1200);

    await expect(page.locator("bili-comments #content").first()).toBeHidden();
    // 评论卡片本身、用户信息、操作按钮都还在
    await expect(page.locator("bili-comments bili-comment-renderer").first()).toBeVisible();
    await expect(page.locator("bili-comments #user-level").first()).toBeVisible();
    await expect(page.locator("bili-comments #reply").first()).toBeVisible();

    const restore = page.locator("bili-comments #showAicgContent").first();
    await expect(restore).toBeVisible();
    await restore.click();
    await expect(page.locator("bili-comments #content").first()).toBeVisible();
});

test("隐藏卡片：整条评论不显示", async ({ extensionPage: page, extensionServiceWorker, sendContentMessage }) => {
    await openVideoWithAicg(page, extensionServiceWorker, sendContentMessage, {
        commentAicgAction: 3,
        commentAicgMinLength: 12,
    });
    await mountComments(page, [...TEMPLATE_PEERS, TEMPLATE_PEERS[0]]);
    await page.waitForTimeout(1200);

    await expect(page.locator("bili-comments bili-comment-renderer").first()).toBeHidden();
});

test("动态加载的新评论同样被处理，且不会重复插入标签", async ({ extensionPage: page, extensionServiceWorker, sendContentMessage }) => {
    await openVideoWithAicg(page, extensionServiceWorker, sendContentMessage, {
        commentAicgAction: 1,
        commentAicgMinLength: 12,
    });
    await mountComments(page, TEMPLATE_PEERS);
    await page.waitForTimeout(1000);
    const before = await page.locator("bili-comments #aicgSuspectLabel").count();

    await appendComments(page, [TEMPLATE_PEERS[0]]);
    await page.waitForTimeout(1200);
    const after = await page.locator("bili-comments #aicgSuspectLabel").count();
    expect(after).toBeGreaterThan(before);

    // 再触发一轮扫描，标签数量不应继续增长
    await page.evaluate(() => {
        const root = document.querySelector("bili-comments").shadowRoot;
        root.querySelector("#feed").appendChild(document.createElement("div"));
    });
    await page.waitForTimeout(1200);
    expect(await page.locator("bili-comments #aicgSuspectLabel").count()).toBe(after);
});

test("子评论（回复）也会被处理", async ({ extensionPage: page, extensionServiceWorker, sendContentMessage }) => {
    await openVideoWithAicg(page, extensionServiceWorker, sendContentMessage, {
        commentAicgAction: 1,
        commentAicgMinLength: 12,
    });
    await mountComments(page, TEMPLATE_PEERS);
    await page.evaluate(() => {
        const add = (tag: string, parent: Node, html = ""): HTMLElement => {
            const host = document.createElement(tag);
            host.attachShadow({ mode: "open" }).innerHTML = html;
            parent.appendChild(host);
            return host;
        };
        const root = document.querySelector<HTMLElement>("bili-comments");
        const thread = root.shadowRoot.querySelector("bili-comment-thread-renderer");
        const replies = add("bili-comment-replies-renderer", thread.shadowRoot);
        const reply = add("bili-comment-reply-renderer", replies.shadowRoot, '<div id="content"></div>');
        const rich = add("bili-rich-text", reply.shadowRoot.querySelector("#content"));
        rich.shadowRoot.innerHTML = "<span>@主人 新版跟源仓库彻底隔离、写操作全原子锁，两个进程同时跑也不撞。</span>";
        add("bili-comment-user-info", reply.shadowRoot, '<span id="user-level">Lv6</span>');
    });
    await page.waitForTimeout(1500);

    await expect(page.locator("bili-comments bili-comment-reply-renderer #aicgSuspectLabel")).toHaveCount(1);
});

test("修改设置后立即生效：从禁用切到隐藏卡片", async ({ extensionPage: page, extensionServiceWorker, sendContentMessage }) => {
    await openVideoWithAicg(page, extensionServiceWorker, sendContentMessage, { commentAicgAction: 0 });
    await mountComments(page, [...TEMPLATE_PEERS, TEMPLATE_PEERS[0]]);
    await page.waitForTimeout(1200);
    await expect(page.locator("bili-comments #aicgSuspectLabel")).toHaveCount(0);

    await writeSyncStorage(extensionServiceWorker, { commentAicgAction: 3 });
    // 触发一次扫描（真实页面里由滚动/新评论触发）
    await appendComments(page, []);
    await page.evaluate(() => {
        const root = document.querySelector("bili-comments").shadowRoot;
        root.querySelector("#feed").appendChild(document.createElement("div"));
    });
    await page.waitForTimeout(1500);

    await expect(page.locator("bili-comments bili-comment-renderer").first()).toBeHidden();
});

test("修改设置后立即生效：在两种已启用模式之间切换", async ({ extensionPage: page, extensionServiceWorker, sendContentMessage }) => {
    await openVideoWithAicg(page, extensionServiceWorker, sendContentMessage, {
        commentAicgAction: 1,
        commentAicgMinLength: 12,
    });
    await mountComments(page, [...TEMPLATE_PEERS, TEMPLATE_PEERS[0]]);
    await page.waitForTimeout(1200);
    await expect(page.locator("bili-comments #aicgSuspectLabel").first()).toBeVisible();
    await expect(page.locator("bili-comments #content").first()).toBeVisible();

    // 仅添加标签 -> 隐藏内容：已渲染的评论要立刻跟着变
    await writeSyncStorage(extensionServiceWorker, { commentAicgAction: 2 });
    await page.evaluate(() => {
        document.querySelector("bili-comments").shadowRoot.querySelector("#feed").appendChild(document.createElement("div"));
    });
    await page.waitForTimeout(1500);
    await expect(page.locator("bili-comments #content").first()).toBeHidden();
    await expect(page.locator("bili-comments #showAicgContent").first()).toBeVisible();

    // 隐藏内容 -> 隐藏卡片
    await writeSyncStorage(extensionServiceWorker, { commentAicgAction: 3 });
    await page.evaluate(() => {
        document.querySelector("bili-comments").shadowRoot.querySelector("#feed").appendChild(document.createElement("div"));
    });
    await page.waitForTimeout(1500);
    await expect(page.locator("bili-comments bili-comment-renderer").first()).toBeHidden();
});

test("人工撰写的规范评论不会被误伤", async ({ extensionPage: page, extensionServiceWorker, sendContentMessage }) => {
    await openVideoWithAicg(page, extensionServiceWorker, sendContentMessage, {
        commentAicgAction: 3,
        commentAicgMinLength: 12,
    });
    await mountComments(page, [HUMAN_COMMENT]);
    await page.waitForTimeout(1200);

    await expect(page.locator("bili-comments bili-comment-renderer").first()).toBeVisible();
    await expect(page.locator("bili-comments #aicgSuspectLabel")).toHaveCount(0);
});

test("商品链接过滤不受影响，可与 AICG 过滤同时工作", async ({ extensionContext, extensionPage: page, extensionServiceWorker, sendContentMessage }) => {
    await writeSyncStorage(extensionServiceWorker, {
        dynamicAndCommentSponsorBlocker: true,
        commentSponsorBlock: true,
        dynamicSponsorBlock: false,
        commentSponsorReplyBlock: false,
        dynamicSponsorSelections: [{ name: "dynamicSponsor_sponsor", option: 2 }],
        commentAicgAction: 1,
        commentAicgMinLength: 12,
    });
    await routeMockBilibiliVideoPage(page, { currentTime: 0, paused: true });
    await page.goto(`https://www.bilibili.com/video/${defaultMockBvid}/`);
    await waitForBilibiliContentScript(page, sendContentMessage);
    await page.waitForTimeout(2500);

    // 第一条是带商品链接的模板评论，其余是纯模板评论
    await mountComments(page, [...TEMPLATE_PEERS, TEMPLATE_PEERS[0]], { withGoodsLinkOnFirst: true });
    await page.waitForTimeout(1500);

    // 原有商品链接过滤仍然生效
    await expect(page.locator("bili-comments #commentSponsorLabel")).toHaveCount(1);
    // AICG 标签也在
    expect(await page.locator("bili-comments #aicgSuspectLabel").count()).toBeGreaterThan(0);
});

/** 视觉存档：把三种处理效果截下来，方便人工复核。 */
test("截图存档：标签、隐藏内容、隐藏卡片三种效果", async ({ extensionPage: page, extensionServiceWorker, sendContentMessage }) => {
    const artifactDir = path.resolve(__dirname, "..", "test-results", "aicg-ui");
    fs.mkdirSync(artifactDir, { recursive: true });

    await openVideoWithAicg(page, extensionServiceWorker, sendContentMessage, {
        commentAicgAction: 1,
        commentAicgMinLength: 12,
        commentAicgDebug: true,
    });

    const stamp = async (name: string) => {
        await page.waitForTimeout(900);
        const box = await page.locator("bili-comments").first().boundingBox();
        if (box) {
            await page.screenshot({
                path: path.join(artifactDir, `${name}.png`),
                clip: { x: box.x, y: box.y, width: Math.min(box.width, 900), height: Math.min(box.height, 620) },
            });
        }
    };

    await mountComments(page, [...TEMPLATE_PEERS.slice(0, 3), TEMPLATE_PEERS[0], HUMAN_COMMENT]);
    await stamp("comments-label-mode");

    await writeSyncStorage(extensionServiceWorker, { commentAicgAction: 2 });
    await appendComments(page, []);
    await page.evaluate(() => {
        document.querySelector("bili-comments").shadowRoot.querySelector("#feed").appendChild(document.createElement("div"));
    });
    await stamp("comments-hide-content-mode");

    await writeSyncStorage(extensionServiceWorker, { commentAicgAction: 3 });
    await page.evaluate(() => {
        document.querySelector("bili-comments").shadowRoot.querySelector("#feed").appendChild(document.createElement("div"));
    });
    await stamp("comments-hide-card-mode");

    expect(fs.existsSync(path.join(artifactDir, "comments-label-mode.png"))).toBe(true);
});

