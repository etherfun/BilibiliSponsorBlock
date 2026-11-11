/**
 * 评论处理器：把检测层、决策层、执行层串到 B 站评论的 DOM 结构上。
 *
 * 复用 DynamicAndCommentSponsorBlock 已建立的「多层 ShadowRoot 发现」机制，
 * 不新增全局 MutationObserver：由调用方在已有的评论扫描流程里调用本模块。
 * 同一条评论通过 WeakSet + 文本指纹去重，动态加载、子评论、重复刷新都安全。
 */

import { logDebug } from "../../utils/logger";
import { AicgAction, AicgConfig, AicgDecision, AicgDetectionResult } from "./types";
import { createAicgContext, HeuristicAicgDetector } from "./detector";
import { decideAicgAction, summarizeFeatures } from "./decision";
import {
    applyAicgDecision,
    getAppliedState,
    restoreAicgCard,
    type AicgCommentNode,
} from "./executor";
import { codePointLength, normalizeCommentText, stripMentionPrefix } from "./text";

export interface ProcessedComment {
    /** 整条评论卡片节点 */
    card: HTMLElement;
    /** 评论文本容器 */
    content: HTMLElement;
    /** 评论文本，已去除 HTML */
    text: string;
    result: AicgDetectionResult;
    decision: AicgDecision;
    changed: boolean;
}

export interface AicgCommentOptions {
    config: AicgConfig;
    /** i18n 文案，由调用方注入，保持本模块与 chrome.i18n 解耦 */
    labels: {
        suspect: string;
        show: string;
        hide: string;
    };
    /** 调试模式下标签显示命中特征 */
    debug?: boolean;
}

/** 一个评论宿主（bili-comments 或其子 shadow root）下发现的所有评论。 */
export function collectCommentNodes(root: HTMLElement): AicgCommentNode[] {
    const nodes: AicgCommentNode[] = [];
    const seen = new Set<HTMLElement>();

    const visit = (shadow: ShadowRoot) => {
        for (const thread of shadow.querySelectorAll<HTMLElement>("bili-comment-thread-renderer")) {
            const threadShadow = thread.shadowRoot;
            if (!threadShadow) continue;

            // 主评论
            const mainComment = threadShadow.querySelector<HTMLElement>("bili-comment-renderer");
            if (mainComment) {
                pushNode(mainComment, nodes, seen);
            }

            // 子评论 / 回复
            const repliesRenderer = threadShadow.querySelector<HTMLElement>("bili-comment-replies-renderer");
            const repliesShadow = repliesRenderer?.shadowRoot;
            if (repliesShadow) {
                for (const reply of repliesShadow.querySelectorAll<HTMLElement>("bili-comment-reply-renderer")) {
                    pushNode(reply, nodes, seen);
                }
            }
        }
    };

    if (root.shadowRoot) visit(root.shadowRoot);
    return nodes;
}

function pushNode(comment: HTMLElement, out: AicgCommentNode[], seen: Set<HTMLElement>): void {
    const shadow = comment.shadowRoot;
    if (!shadow) return;
    if (seen.has(comment)) return;

    const content = shadow.querySelector<HTMLElement>("#content");
    if (!content) return;

    // 标签锚点：优先用户信息区，其次内容区。
    const userInfo = shadow.querySelector("bili-comment-user-info")?.shadowRoot;
    const labelAnchor = userInfo?.querySelector<HTMLElement>("#user-up, #user-level")
        ?? content;

    const actionsRoot = shadow.querySelector<HTMLElement>("bili-comment-action-buttons-renderer")?.shadowRoot ?? null;
    const actions = actionsRoot as unknown as HTMLElement | null;
    seen.add(comment);
    out.push({ card: comment, content, labelAnchor, actions });
}

/**
 * 处理一组评论：先构建跨评论上下文，再逐条检测、决策、执行。
 * 返回本次实际改动过的评论，便于测试与统计。
 */
export function processComments(
    nodes: readonly AicgCommentNode[],
    options: AicgCommentOptions,
): ProcessedComment[] {
    if (options.config.action === AicgAction.Disabled || !nodes.length) return [];

    const texts = nodes.map((node) => readCommentText(node.content));
    const context = createAicgContext(texts);
    const detector = new HeuristicAicgDetector();
    const processed: ProcessedComment[] = [];

    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        const text = texts[i];
        // 用去掉 @提及 前缀的正文来做长度门限与去重：前缀在评论区里高度重复，
        // 算进来会让一句短回复看起来「很长、很像模板」。
        const body = normalizeCommentText(stripMentionPrefix(text));
        if (!body || codePointLength(body) < options.config.minLength) continue;

        // 已经用当前模式处理过、且文本没变：跳过检测，避免重复扫描时重复计算与重复插标签。
        // 模式变了（用户在设置里切换）或文本变了，则重新检测并重新套用。
        const applied = getAppliedState(node.card);
        if (applied && applied.text === body && applied.action === options.config.action) continue;

        const result = detector.detect(
            { text, minDetectableLength: options.config.minLength },
            context,
        );
        const decision = decideAicgAction(result, options.config);

        if (decision.action === AicgAction.Disabled) continue;

        const changed = applyAicgDecision(
            node,
            decision,
            result.normalizedText,
            {
                labelText: options.labels.suspect,
                showText: options.labels.show,
                hideText: options.labels.hide,
                debugText: options.debug ? summarizeFeatures(decision.features).join(" / ") : undefined,
            },
        );

        processed.push({ card: node.card, content: node.content, text, result, decision, changed });
    }

    logDebug(`aicg processComments total=${nodes.length} candidates=${processed.length} actions=${JSON.stringify(countByAction(processed))}`);

    return processed;
}

/** 设置改为禁用时调用，回滚本功能造成的 DOM 变更。 */
export function restoreComments(nodes: readonly AicgCommentNode[]): void {
    for (const node of nodes) restoreAicgCard(node);
}

function countByAction(processed: readonly ProcessedComment[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const item of processed) {
        counts[AicgAction[item.decision.action]] = (counts[AicgAction[item.decision.action]] ?? 0) + 1;
    }
    return counts;
}

/**
 * 读取评论文本。
 *
 * 真实页面上评论正文在 `#content > bili-rich-text` 的 **shadowRoot** 里，
 * `textContent` 不会跨 shadow 边界，所以必须自己递归进去收集文本节点。
 * 同时跳过「展开」「回复」等操作控件，只保留正文。
 */
export function readCommentText(content: HTMLElement): string {
    if (!content) return "";

    const parts: string[] = [];
    const SKIPPED_TAGS = new Set(["STYLE", "SCRIPT", "BUTTON", "SVG"]);
    const SKIPPED_CLASSES = ["bili-rich-text__action", "bili-comment-action", "reply", "expand"];

    const walk = (node: Node): void => {
        if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent;
            if (text) parts.push(text);
            return;
        }
        if (!(node instanceof Element)) return;
        if (SKIPPED_TAGS.has(node.tagName)) return;
        if (SKIPPED_CLASSES.some((name) => node.classList?.contains(name))) return;
        if (node.getAttribute("data-e2e") === "comment-expand") return;

        // 有 shadowRoot 时正文在那里；否则读 light DOM。
        const shadow = node.shadowRoot;
        if (shadow && shadow.childNodes.length) {
            for (const child of Array.from(shadow.childNodes)) walk(child);
            return;
        }
        for (const child of Array.from(node.childNodes)) walk(child);
    };

    walk(content);
    return parts.join(" ").replace(/\s+/g, " ").trim();
}
