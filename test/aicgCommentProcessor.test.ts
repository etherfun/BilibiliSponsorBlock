/** @jest-environment jsdom */
import { AicgAction } from "../src/content/aicg/types";
import {
    collectCommentNodes,
    processComments,
    readCommentText,
    restoreComments,
} from "../src/content/aicg/commentProcessor";
import { resetAicgExecutorState } from "../src/content/aicg/executor";

jest.mock("../src/utils/logger", () => ({ logDebug: jest.fn(), logWarn: jest.fn() }));

function component(name: string, parent: Node, html = "") {
    const host = document.createElement(name);
    host.attachShadow({ mode: "open" }).innerHTML = html;
    parent.appendChild(host);
    return host;
}

/** 与真实页面一致：正文写在 bili-rich-text 的 shadowRoot 里。 */
function commentNode(parent: Node, text: string) {
    const comment = component("bili-comment-renderer", parent, '<div id="content"></div>');
    const content = comment.shadowRoot.querySelector<HTMLElement>("#content");
    const rich = component("bili-rich-text", content);
    rich.shadowRoot.innerHTML = `<span>${text}</span>`;
    return comment;
}

function contentOf(comment: HTMLElement): HTMLElement {
    return comment.shadowRoot.querySelector<HTMLElement>("#content");
}

/**
 * 构造一个评论宿主：每条评论各自位于一个 bili-comment-thread-renderer 内（与真实 DOM 一致），
 * 最后一条是待测评论。前面若干条模板化评论构成「跨评论上下文」。
 */
function floodFixture(text: string, peerCount = 6) {
    const root = component("bili-comments", document.body, '<div id="feed"></div>');
    const feed = root.shadowRoot.querySelector("#feed");
    for (let i = 0; i < peerCount; i++) {
        const peerThread = component("bili-comment-thread-renderer", feed);
        commentNode(peerThread.shadowRoot, templateComment("owner" + i, i));
    }
    const thread = component("bili-comment-thread-renderer", feed);
    const target = commentNode(thread.shadowRoot, text);
    const user = component("bili-comment-user-info", target.shadowRoot, '<span id="user-level"></span>');
    const actions = component("bili-comment-action-buttons-renderer", target.shadowRoot, '<button id="reply"></button>');
    return { root, thread, target, user, actions };
}

/** 模板化评论：模拟批量生成的 AI 评论。 */
function templateComment(owner: string, index: number): string {
    return `@${owner} 新版跟源仓库彻底隔离、写操作全原子锁，两个进程同时跑也不撞。看：https://www.bilibili.com/video/BV1JEnn6VE2A (${index})`;
}

const labels = { suspect: "疑似 AI", show: "显示内容", hide: "隐藏内容" };
const labelConfig = { action: AicgAction.Label, threshold: 0.5, minLength: 12, debug: false };

beforeEach(() => {
    resetAicgExecutorState();
    document.body.replaceChildren();
});

afterEach(() => {
    resetAicgExecutorState();
    document.body.replaceChildren();
});

describe("collectCommentNodes", () => {
    test("finds main comments and nested replies", () => {
        const root = component("bili-comments", document.body, '<div id="feed"></div>');
        const thread = component("bili-comment-thread-renderer", root.shadowRoot.querySelector("#feed"));
        const main = component("bili-comment-renderer", thread.shadowRoot, '<div id="content"></div>');
        const replies = component("bili-comment-replies-renderer", thread.shadowRoot);
        const reply = component("bili-comment-reply-renderer", replies.shadowRoot, '<div id="content"></div>');

        const nodes = collectCommentNodes(root);
        expect(nodes).toHaveLength(2);
        expect(nodes.map((n) => n.card)).toContain(main);
        expect(nodes.map((n) => n.card)).toContain(reply);
    });

    test("skips comments without a content container", () => {
        const root = component("bili-comments", document.body, '<div id="feed"></div>');
        const feed = root.shadowRoot.querySelector("#feed");
        const goodThread = component("bili-comment-thread-renderer", feed);
        const good = component("bili-comment-renderer", goodThread.shadowRoot, '<div id="content"></div>');
        const bareThread = component("bili-comment-thread-renderer", feed);
        component("bili-comment-renderer", bareThread.shadowRoot, '<div class="no-content"></div>');

        const nodes = collectCommentNodes(root);
        expect(nodes).toHaveLength(1);
        expect(nodes[0].card).toBe(good);
    });

    test("deduplicates repeated discovery of the same comment", () => {
        const f = floodFixture(templateComment("owner", 0));
        const nodes = collectCommentNodes(f.root);
        const unique = new Set(nodes.map((n) => n.card));
        expect(unique.size).toBe(nodes.length);
    });
});

describe("readCommentText", () => {
    test("reads text that lives inside nested shadow roots (real Bilibili structure)", () => {
        const f = floodFixture(templateComment("owner", 0));
        const content = contentOf(f.target);
        // 正文写在 bili-rich-text 的 shadowRoot 里，而不是 #content 的 light DOM
        const rich = content.querySelector("bili-rich-text") as HTMLElement;
        rich.shadowRoot.innerHTML = "<span>影子里的正文</span>";
        expect(readCommentText(content)).toBe("影子里的正文");
    });

    test("reads light DOM text when there is no shadow text", () => {
        const f = floodFixture(templateComment("owner", 0));
        const content = contentOf(f.target);
        content.querySelector("bili-rich-text").shadowRoot.innerHTML = "";
        content.textContent = "浅层正文";
        expect(readCommentText(content)).toBe("浅层正文");
    });

    test("skips action controls and expand links", () => {
        const f = floodFixture(templateComment("owner", 0));
        const content = contentOf(f.target);
        const rich = content.querySelector("bili-rich-text") as HTMLElement;
        rich.shadowRoot.innerHTML = '<span>正文</span><span class="bili-rich-text__action">展开</span>';
        const button = document.createElement("button");
        button.textContent = "回复";
        content.appendChild(button);
        expect(readCommentText(content)).toBe("正文");
    });

    test("returns empty string for empty content", () => {
        expect(readCommentText(null as unknown as HTMLElement)).toBe("");
    });
});

describe("processComments", () => {
    test("disabled config leaves every comment untouched", () => {
        const f = floodFixture(templateComment("owner", 0));
        const nodes = collectCommentNodes(f.root);
        const processed = processComments(nodes, {
            config: { action: AicgAction.Disabled, threshold: 0.55, minLength: 12, debug: false },
            labels,
        });
        expect(processed).toHaveLength(0);
        expect(contentOf(f.target).style.display).toBe("");
    });

    test("label mode keeps the comment visible and adds exactly one label", () => {
        const f = floodFixture(templateComment("owner", 0));
        const nodes = collectCommentNodes(f.root);
        const processed = processComments(nodes, { config: labelConfig, labels });

        expect(processed.length).toBeGreaterThan(0);
        expect(contentOf(f.target).style.display).toBe("");
        const label = f.user.shadowRoot.querySelector("#aicgSuspectLabel");
        expect(label).not.toBeNull();
        expect(label.textContent).toContain("疑似 AI");
        expect(f.user.shadowRoot.querySelectorAll("#aicgSuspectLabel")).toHaveLength(1);
    });

    test("hide content keeps the container and adds a working restore button", () => {
        const f = floodFixture(templateComment("owner", 0));
        const nodes = collectCommentNodes(f.root);

        processComments(nodes, {
            config: { action: AicgAction.HideContent, threshold: 0.5, minLength: 12, debug: false },
            labels,
        });

        const content = contentOf(f.target);
        expect(content.style.display).toBe("none");
        // 容器本身与用户信息仍在
        expect(contentOf(f.target)).not.toBeNull();
        expect(f.user.shadowRoot.querySelector("#user-level")).not.toBeNull();
        const toggle = f.actions.shadowRoot.querySelector<HTMLButtonElement>("#showAicgContent");
        expect(toggle).not.toBeNull();
        toggle.click();
        expect(content.style.display).toBe("");
        expect(toggle.textContent).toBe("隐藏内容");
    });

    test("hide card removes the whole comment card", () => {
        const f = floodFixture(templateComment("owner", 0));
        const nodes = collectCommentNodes(f.root);

        processComments(nodes, {
            config: { action: AicgAction.HideCard, threshold: 0.5, minLength: 12, debug: false },
            labels,
        });

        expect(f.target.style.display).toBe("none");
        expect(f.target.getAttribute("data-aicg-card-hidden")).toBe("true");
    });

    test("does not process the same comment twice", () => {
        const f = floodFixture(templateComment("owner", 0));
        const nodes = collectCommentNodes(f.root);

        const first = processComments(nodes, { config: labelConfig, labels });
        const second = processComments(nodes, { config: labelConfig, labels });

        expect(first.length).toBeGreaterThan(0);
        expect(second).toHaveLength(0);
        expect(f.user.shadowRoot.querySelectorAll("#aicgSuspectLabel")).toHaveLength(1);
    });

    test("switching modes never leaves duplicate labels", () => {
        const f = floodFixture(templateComment("owner", 0));
        const nodes = collectCommentNodes(f.root);
        const configs = [
            { action: AicgAction.Label, threshold: 0.5, minLength: 12, debug: false },
            { action: AicgAction.HideContent, threshold: 0.5, minLength: 12, debug: false },
            { action: AicgAction.Label, threshold: 0.5, minLength: 12, debug: false },
            { action: AicgAction.HideCard, threshold: 0.5, minLength: 12, debug: false },
            { action: AicgAction.Label, threshold: 0.5, minLength: 12, debug: false },
        ];
        for (const config of configs) {
            processComments(nodes, { config, labels });
            expect(f.user.shadowRoot.querySelectorAll("#aicgSuspectLabel").length).toBeLessThanOrEqual(1);
            expect(f.actions.shadowRoot.querySelectorAll("#showAicgContent").length).toBeLessThanOrEqual(1);
        }
        expect(f.user.shadowRoot.querySelectorAll("#aicgSuspectLabel")).toHaveLength(1);
    });

    test("switching mode re-applies to already processed comments", () => {
        const f = floodFixture(templateComment("owner", 0));
        const nodes = collectCommentNodes(f.root);

        processComments(nodes, { config: labelConfig, labels });
        expect(f.user.shadowRoot.querySelector("#aicgSuspectLabel")).not.toBeNull();
        expect(contentOf(f.target).style.display).toBe("");

        // 用户把「仅添加标签」改成「隐藏内容」
        const hideConfig = { action: AicgAction.HideContent, threshold: 0.5, minLength: 12, debug: false };
        const switched = processComments(nodes, { config: hideConfig, labels });

        expect(switched.length).toBeGreaterThan(0);
        expect(contentOf(f.target).style.display).toBe("none");
        expect(f.actions.shadowRoot.querySelector("#showAicgContent")).not.toBeNull();

        // 再切回「仅添加标签」：内容恢复显示
        processComments(nodes, { config: labelConfig, labels });
        expect(contentOf(f.target).style.display).toBe("");
        expect(f.actions.shadowRoot.querySelector("#showAicgContent")).toBeNull();
    });

    test("disabling restores comments and a later re-enable works again", () => {
        const f = floodFixture(templateComment("owner", 0));
        const nodes = collectCommentNodes(f.root);

        processComments(nodes, {
            config: { action: AicgAction.HideCard, threshold: 0.5, minLength: 12, debug: false },
            labels,
        });
        expect(f.target.style.display).toBe("none");

        // 设置为禁用：回滚
        const disabled = processComments(nodes, {
            config: { action: AicgAction.Disabled, threshold: 0.5, minLength: 12, debug: false },
            labels,
        });
        expect(disabled).toHaveLength(0);

        // 检测逻辑在禁用时由调用方回滚；这里直接驱动一次回滚路径
        restoreComments(nodes);
        expect(f.target.style.display).toBe("");

        // 重新启用后仍能生效
        const reEnabled = processComments(nodes, {
            config: { action: AicgAction.HideCard, threshold: 0.5, minLength: 12, debug: false },
            labels,
        });
        expect(reEnabled.length).toBeGreaterThan(0);
        expect(f.target.style.display).toBe("none");
    });

    test("processes dynamically added comments", () => {
        const root = component("bili-comments", document.body, '<div id="feed"></div>');
        const feed = root.shadowRoot.querySelector("#feed");
        // 初次扫描：评论区是空的
        expect(processComments(collectCommentNodes(root), { config: labelConfig, labels })).toHaveLength(0);

        // 模拟滚动加载：先到 6 条评论，再插入一条新评论
        for (let i = 0; i < 6; i++) {
            const peerThread = component("bili-comment-thread-renderer", feed);
            commentNode(peerThread.shadowRoot, templateComment("owner" + i, i));
        }
        const lateThread = component("bili-comment-thread-renderer", feed);
        const late = commentNode(lateThread.shadowRoot, templateComment("late", 99));

        const processed = processComments(collectCommentNodes(root), { config: labelConfig, labels });
        expect(processed.length).toBeGreaterThan(0);
        expect(late.shadowRoot.querySelector("#aicgSuspectLabel")).not.toBeNull();
    });

    test("processes replies and sub-comments", () => {
        const f = floodFixture(templateComment("owner", 0));
        const replies = component("bili-comment-replies-renderer", f.thread.shadowRoot);
        const reply = component("bili-comment-reply-renderer", replies.shadowRoot, '<div id="content"></div>');
        const replyContent = reply.shadowRoot.querySelector<HTMLElement>("#content");
        replyContent.textContent = templateComment("replyowner", 0);

        const processed = processComments(collectCommentNodes(f.root), { config: labelConfig, labels });

        expect(processed.length).toBeGreaterThan(0);
        expect(replyContent.style.display).toBe("");
        expect(reply.shadowRoot.querySelector("#aicgSuspectLabel")).not.toBeNull();
    });

    test("skips comments shorter than the configured minimum length", () => {
        const f = floodFixture("短");
        const processed = processComments(collectCommentNodes(f.root), {
            config: { action: AicgAction.Label, threshold: 0.1, minLength: 12, debug: false },
            labels,
        });
        // 只处理了那些模板评论；被检测的短评本身不参与
        expect(processed.some((item) => item.card === f.target)).toBe(false);
        expect(f.target.shadowRoot.querySelector("#aicgSuspectLabel")).toBeNull();
    });

    test("does not act on a lone suspicious comment without peer evidence", () => {
        // 只有一条模板化评论：没有跨评论证据，即使文字很像模板也不应处理。
        const root = component("bili-comments", document.body, '<div id="feed"></div>');
        const thread = component("bili-comment-thread-renderer", root.shadowRoot.querySelector("#feed"));
        const comment = commentNode(thread.shadowRoot, templateComment("owner", 0));

        const processed = processComments(collectCommentNodes(root), {
            config: { action: AicgAction.HideCard, threshold: 0.1, minLength: 12, debug: false },
            labels,
        });

        expect(processed).toHaveLength(0);
        expect(comment.style.display).toBe("");
    });

    test("debug mode exposes matched features on the label", () => {
        const f = floodFixture(templateComment("owner", 0));
        processComments(collectCommentNodes(f.root), {
            config: { action: AicgAction.Label, threshold: 0.5, minLength: 12, debug: true },
            labels,
            debug: true,
        });
        const label = f.user.shadowRoot.querySelector("#aicgSuspectLabel");
        expect(label).not.toBeNull();
        expect(label.querySelector(".Match").textContent.length).toBeGreaterThan(0);
    });
});
