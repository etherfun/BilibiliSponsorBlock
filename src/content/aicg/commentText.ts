/**
 * 评论正文提取（DOM 相关，但从检测器里拆出来单独可测）。
 *
 * 真实页面上评论正文在 `#content > bili-rich-text` 的 shadowRoot 里，
 * `textContent` 不会跨 shadow 边界，所以必须自己递归收集文本节点。
 */

const SKIPPED_TAGS = new Set(["STYLE", "SCRIPT", "BUTTON", "SVG"]);
const SKIPPED_CLASSES = ["bili-rich-text__action", "bili-comment-action", "reply", "expand"];

export function readCommentText(content: HTMLElement | null | undefined): string {
    if (!content) return "";

    const parts: string[] = [];

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

        // 有 shadowRoot 时正文通常在那里；但如果组件用 <slot> 组合，
        // 正文其实在 light DOM 里，shadow 里只有一个空的 slot 元素，
        // 这时必须再回到 light DOM 找，否则读出来是空串（真实站点就踩过）。
        const shadow = node.shadowRoot;
        if (shadow && shadow.childNodes.length) {
            const before = parts.length;
            for (const child of Array.from(shadow.childNodes)) walk(child);
            if (parts.length > before) return;
        }
        for (const child of Array.from(node.childNodes)) walk(child);
    };

    walk(content);
    return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** 读取评论作者标识；拿不到时返回空串（不参与跨作者统计）。 */
export function readCommentAuthor(comment: HTMLElement | null | undefined): string {
    if (!comment) return "";
    const avatar = comment.shadowRoot?.querySelector<HTMLElement>("#user-avatar");
    return avatar?.getAttribute("data-user-profile-id") ?? "";
}
