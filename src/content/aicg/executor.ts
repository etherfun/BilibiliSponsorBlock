/**
 * 执行层：把决策应用到评论 DOM。
 *
 * 只负责「怎么改」，不负责「该不该改」；检测与决策在 detector/decision 中完成。
 * 复用现有 DynamicAndCommentSponsorBlock 的评论节点定位方式（多层 ShadowRoot），
 * 并沿用现有的 labelSponsorStyle / hideSponsorContent 视觉与交互。
 */

import { AicgAction, AicgDecision } from "./types";

export interface AicgCommentNode {
    /** 整条评论卡片（隐藏卡片模式的目标） */
    card: HTMLElement;
    /** 评论文本容器（隐藏内容模式的目标） */
    content: HTMLElement;
    /** 插入标签的锚点元素 */
    labelAnchor: HTMLElement;
    /** 评论操作区，用于插入「显示内容」按钮 */
    actions?: HTMLElement | null;
}

const LABEL_ID = "aicgSuspectLabel";
const TOGGLE_ID = "showAicgContent";
const CARD_HIDDEN_ATTR = "data-aicg-card-hidden";
const CONTENT_HIDDEN_ATTR = "data-aicg-content-hidden";

/** 一条评论上一次被应用的状态：用于去重，也用于「模式切换后重新套用」。 */
export interface AicgAppliedState {
    action: AicgAction;
    /** 归一化后的评论文本 */
    text: string;
}

/** 已处理状态。用 WeakMap，节点被移除后自动回收。 */
let appliedState = new WeakMap<HTMLElement, AicgAppliedState>();

export function resetAicgExecutorState(): void {
    appliedState = new WeakMap<HTMLElement, AicgAppliedState>();
}

export function getAppliedState(card: HTMLElement): AicgAppliedState | undefined {
    return appliedState.get(card);
}

/**
 * 对一条评论执行决策。返回是否实际改动过 DOM。
 *
 * 如果这条评论之前用的是另一个模式（例如用户把「仅添加标签」改成「隐藏内容」），
 * 先回滚旧效果再套用新模式，这样改设置能立刻在已渲染的评论上看到结果。
 */
export function applyAicgDecision(
    node: AicgCommentNode,
    decision: AicgDecision,
    textFingerprint: string,
    options: { labelText: string; showText: string; hideText: string; debugText?: string },
): boolean {
    if (decision.action === AicgAction.Disabled) {
        return false;
    }

    const previous = appliedState.get(node.card);
    if (previous && previous.text === textFingerprint && previous.action === decision.action) {
        return false;
    }
    if (previous && previous.action !== decision.action) {
        restoreAicgCard(node);
    }

    let changed = false;

    switch (decision.action) {
        case AicgAction.HideCard:
            changed = hideCard(node) || changed;
            break;
        case AicgAction.HideContent:
            changed = hideContent(node, options) || changed;
            break;
        case AicgAction.Label:
            changed = ensureLabel(node, options) || changed;
            break;
        default:
            break;
    }

    appliedState.set(node.card, { action: decision.action, text: textFingerprint });
    return changed;
}

function hideCard(node: AicgCommentNode): boolean {
    if (node.card.getAttribute(CARD_HIDDEN_ATTR) === "true") return false;
    node.card.setAttribute(CARD_HIDDEN_ATTR, "true");
    // 隐藏整张卡片。用 hidden 属性 + display:none，保留节点本身，便于用户脚本/样式恢复。
    node.card.style.display = "none";
    return true;
}

function hideContent(
    node: AicgCommentNode,
    options: { labelText: string; showText: string; hideText: string },
): boolean {
    let changed = false;
    if (node.content.getAttribute(CONTENT_HIDDEN_ATTR) !== "true") {
        node.content.setAttribute(CONTENT_HIDDEN_ATTR, "true");
        node.content.style.display = "none";
        changed = true;
    }
    // 标签仍然加上，让用户知道为什么内容被隐藏、以及怎么展开。
    ensureLabel(node, { labelText: options.labelText });

    if (node.actions && !node.actions.querySelector(`#${TOGGLE_ID}`)) {
        const button = document.createElement("button");
        button.id = TOGGLE_ID;
        button.className = "bili-dyn-action";
        button.textContent = options.showText;
        button.addEventListener("click", () => {
            const isHidden = node.content.style.display === "none";
            node.content.style.display = isHidden ? "" : "none";
            button.textContent = isHidden ? options.hideText : options.showText;
        });
        node.actions.appendChild(button);
        changed = true;
    }
    return changed;
}

/** 标签样式。评论在多层 ShadowRoot 内，需把样式注入到锚点所在的 shadow root。 */
const AICG_LABEL_STYLE_ID = "aicgSuspectLabelStyle";

const AICG_LABEL_CSS = `
#aicgSuspectLabel {
    display: inline-flex;
    align-items: center;
    gap: 0.35em;
    margin-left: 0.4em;
    padding: 0.1em 0.55em;
    border-radius: 1em;
    font-size: 0.75em;
    line-height: 1.6;
    color: #fff;
    background: linear-gradient(135deg, #8e2de2, #4a00e0);
    cursor: help;
    user-select: none;
    vertical-align: middle;
    white-space: nowrap;
}
/* 标签文字默认就显示：这里没有图标，收起文字会让标签变成看不见的空条。 */
#aicgSuspectLabel .Text-Group {
    display: inline-flex;
    align-items: center;
    gap: 0.5em;
    max-width: 32em;
}
#aicgSuspectLabel .Label {
    display: inline-block;
    font-weight: 600;
}
/* 命中的检测特征只在悬浮时展开，避免常驻把评论行撑高。 */
#aicgSuspectLabel .Match {
    display: none;
    opacity: 0.9;
    font-size: 0.9em;
    overflow: hidden;
    text-overflow: ellipsis;
}
#aicgSuspectLabel:hover .Match {
    display: inline-block;
}
#showAicgContent {
    border: none;
    background: transparent;
    cursor: pointer;
    padding: 0;
    color: inherit;
    font-size: 0.9em;
    text-decoration: underline;
}
`;

function ensureLabelStyle(anchor: HTMLElement) {
    const root = anchor.getRootNode();
    if (root instanceof ShadowRoot) {
        if (root.getElementById(AICG_LABEL_STYLE_ID)) return;
        const style = document.createElement("style");
        style.id = AICG_LABEL_STYLE_ID;
        style.textContent = AICG_LABEL_CSS;
        root.appendChild(style);
    } else {
        if (document.getElementById(AICG_LABEL_STYLE_ID)) return;
        const style = document.createElement("style");
        style.id = AICG_LABEL_STYLE_ID;
        style.textContent = AICG_LABEL_CSS;
        (document.head ?? document.documentElement).appendChild(style);
    }
}

/**
 * 标签是插在锚点元素「后面」的兄弟节点，所以查重与移除都必须在锚点的父级里查，
 * 否则每次重新套用都会再插一个标签、回滚也删不掉。
 */
function labelScope(anchor: HTMLElement | null | undefined): ParentNode | null {
    if (!anchor) return null;
    return (anchor.parentElement as ParentNode | null)
        ?? (anchor.getRootNode() instanceof ShadowRoot ? (anchor.getRootNode() as ParentNode) : null);
}

function ensureLabel(node: AicgCommentNode, options: { labelText: string; debugText?: string }): boolean {
    const anchor = node.labelAnchor;
    const scope = labelScope(anchor);
    if (!anchor || !scope || scope.querySelector(`#${LABEL_ID}`)) return false;

    ensureLabelStyle(anchor);

    // 现有 labelSponsorStyle 是全局函数，这里复刻其 DOM 结构，避免为了新功能改动旧代码。
    const label = document.createElement("div");
    label.id = LABEL_ID;
    label.className = "aicg-suspect-label";
    label.setAttribute("data-aicg-label", "true");

    const group = document.createElement("div");
    group.className = "Text-Group";
    const text = document.createElement("span");
    text.className = "Label";
    text.textContent = options.labelText;
    group.appendChild(text);
    if (options.debugText) {
        const match = document.createElement("span");
        match.className = "Match";
        match.textContent = options.debugText;
        group.appendChild(match);
    }
    label.appendChild(group);

    label.addEventListener("mouseenter", () => {
        group.style.display = "flex";
        label.style.borderRadius = "0.5em";
    });
    label.addEventListener("mouseleave", () => {
        group.style.display = null;
        label.style.borderRadius = null;
    });

    // 标签插在锚点元素之后，不改变原有布局宽度。
    anchor.parentNode?.insertBefore(label, anchor.nextSibling);
    return true;
}

/** 恢复被本执行层隐藏的卡片/内容（用于设置改为禁用后的回滚与测试）。 */
export function restoreAicgCard(node: AicgCommentNode): void {
    if (node.card.getAttribute(CARD_HIDDEN_ATTR) === "true") {
        node.card.removeAttribute(CARD_HIDDEN_ATTR);
        node.card.style.display = "";
    }
    if (node.content.getAttribute(CONTENT_HIDDEN_ATTR) === "true") {
        node.content.removeAttribute(CONTENT_HIDDEN_ATTR);
        node.content.style.display = "";
    }
    node.actions?.querySelector(`#${TOGGLE_ID}`)?.remove();
    labelScope(node.labelAnchor)?.querySelector(`#${LABEL_ID}`)?.remove();

    // 回滚后必须忘掉「已处理」标记：否则用户把设置改回启用时，
    // 这些评论会被当成处理过而跳过，看上去像设置没生效。
    appliedState.delete(node.card);
}
