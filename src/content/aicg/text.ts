/**
 * 文本归一化与结构度量。所有函数都是纯函数，方便单测。
 */

/** 归一化：去掉所有空白（含全角空格），保留标点与文字，便于跨评论比较。 */
export function normalizeCommentText(text: string): string {
    return (text ?? "").replace(/[\s\u3000\u00A0]+/g, "");
}

/** 按 Unicode 码点计长，避免 emoji 被算成两个字符。 */
export function codePointLength(text: string): number {
    return [...(text ?? "")].length;
}

/** 去掉 @用户名 前缀和「回复 @xxx :」前缀，只留真正的评论内容。 */
export function stripMentionPrefix(text: string): string {
    let t = (text ?? "").trim();
    // 回复 @xxx :
    t = t.replace(/^回复\s*@\S+?\s*[:：]\s*/, "");
    // 开头的 @xxx
    t = t.replace(/^@\S+\s*/, "");
    return t.trim();
}

/**
 * 评论是否以「回复 @某人」或「@某人」开头。
 * 正文会去掉这个前缀再分析，但「是否在回复某人」本身是有意义的上下文。
 */
export function startsWithMention(text: string): boolean {
    return /^(?:回复\s*@\S+?\s*[:：]|@\S+)/.test((text ?? "").trim());
}

const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/g;
/** 中文字符数。 */
export function cjkCount(text: string): number {
    return (text ?? "").match(CJK_RE)?.length ?? 0;
}

const CJK_PUNCT_RE = /[，。！？、；：“”‘’（）《》【】…—·]/g;
/** 中文标点数量。 */
export function cjkPunctuationCount(text: string): number {
    return (text ?? "").match(CJK_PUNCT_RE)?.length ?? 0;
}

const ASCII_PUNCT_RE = /[,.!?;:]/g;
export function asciiPunctuationCount(text: string): number {
    return (text ?? "").match(ASCII_PUNCT_RE)?.length ?? 0;
}

// 只统计 emoji 主体码点；\uFE0F 这类变体选择符是修饰用的组合字符，
// 放进字符类会被 no-misleading-character-class 判为可疑写法，且不该单独计数。
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/gu;
/** emoji 数量，用于识别口语化、拟人化表达。 */
export function emojiCount(text: string): number {
    return (text ?? "").match(EMOJI_RE)?.length ?? 0;
}

const DIGIT_RE = /\d/g;
export function digitCount(text: string): number {
    return (text ?? "").match(DIGIT_RE)?.length ?? 0;
}

const URL_RE = /https?:\/\/\S+|www\.\S+/gi;
export function countUrls(text: string): number {
    return (text ?? "").match(URL_RE)?.length ?? 0;
}

const LATIN_WORD_RE = /[A-Za-z]{2,}/g;
export function latinWordCount(text: string): number {
    return (text ?? "").match(LATIN_WORD_RE)?.length ?? 0;
}

/**
 * 按中文/英文标点切句。中文语境下换行也算一句的边界。
 * 返回的句子保留原始长度，不做 trim 之外的加工。
 */
export function splitSentences(text: string): string[] {
    return (text ?? "")
        .split(/[。！？!?；;\n]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

export function mean(values: readonly number[]): number {
    if (!values.length) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
}

export function standardDeviation(values: readonly number[]): number {
    if (values.length < 2) return 0;
    const m = mean(values);
    return Math.sqrt(values.reduce((acc, v) => acc + (v - m) ** 2, 0) / values.length);
}

/** 变异系数：句长/长度分布的均匀程度。越接近 0 越机械。 */
export function coefficientOfVariation(values: readonly number[]): number {
    const m = mean(values);
    if (m <= 0) return 0;
    return standardDeviation(values) / m;
}

/**
 * 字符 n-gram 集合。用于跨评论相似度与模板复用度。
 * 中文用 bigram 已经足够区分句式，英文同时保留单词级 bigram。
 */
export function charNgrams(text: string, n = 2): Set<string> {
    const t = normalizeCommentText(text);
    const out = new Set<string>();
    for (let i = 0; i + n <= t.length; i++) out.add(t.slice(i, i + n));
    return out;
}

/** Jaccard 相似度，输入为两个 n-gram 集合。 */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / (a.size + b.size - inter);
}

/**
 * 标点多样性：把分隔符序列转成「归一化熵」。
 * 完全机械的模板往往只有「，。和、」几种分隔，熵接近 1 但分布极偏；
 * 人工写作会混用破折号、省略号、括号、感叹号等。
 * 这里用「每种分隔符出现次数的熵 / 可能的最大熵」衡量均匀度，
 * 再用「分隔符种类数」衡量丰富度，两者结合。
 */
export function punctuationProfile(text: string): { kinds: number; entropyRatio: number; total: number } {
    const seps = (text ?? "").match(/[，。！？、；：“”‘’（）《》【】…—·,.!?;:]/g) ?? [];
    if (!seps.length) return { kinds: 0, entropyRatio: 0, total: 0 };
    const counts = new Map<string, number>();
    for (const s of seps) counts.set(s, (counts.get(s) ?? 0) + 1);
    let entropy = 0;
    for (const c of counts.values()) {
        const p = c / seps.length;
        entropy -= p * Math.log2(p);
    }
    const maxEntropy = Math.log2(counts.size);
    return { kinds: counts.size, entropyRatio: maxEntropy > 0 ? entropy / maxEntropy : 0, total: seps.length };
}

/**
 * 文本信息密度：归一化文本中「只出现一次的中文词/片段」占比的近似。
 * 模板化文本的常用词重复率极高，新鲜度低。
 */
export function noveltyRatio(text: string, df: ReadonlyMap<string, number>, threshold: number): number {
    const grams = charNgrams(text, 2);
    if (!grams.size) return 1;
    let fresh = 0;
    for (const g of grams) if ((df.get(g) ?? 0) < threshold) fresh++;
    return fresh / grams.size;
}

/** 判断文本是否包含网络口语/拟声词/语气词，用于降低误判。 */
const COLLOQUIAL_RE = /哈哈|嘿嘿|hhh|233|666|xswl|yyds|awsl|笑死|绝了|救命|无语|破防|emo|摆烂|摸鱼|躺平|喵|汪|嗷|鸭|捏|哒|嘞|噻|咯|呜|嗯呢|好嘞|行吧|得了|咋|啥|嘛|呗|喽|doge|滑稽|吃瓜|打call|金箍/i;
export function looksColloquial(text: string): boolean {
    if (emojiCount(text) >= 2) return true;
    if (/(.)\1{2,}/.test(text.replace(/\s/g, ""))) return true; // 叠字：哈哈哈
    return COLLOQUIAL_RE.test(text);
}

/** 人设自称：AI 助手常见的自我指称。 */
const PERSONA_RE = /本鲸|本鱼|本奴|本小姐|本宫|人家|僕|咱|你的鱼|你家那只|主人(?!节)/;
export function hasPersonaSelfReference(text: string): boolean {
    return PERSONA_RE.test(text);
}

/**
 * 汇报式结构：以 @某人 开头并汇报某个对象的状态。
 * `mentioned` 由调用方预先判断，因为正文已经去掉了 @ 前缀。
 */
export function looksLikeReportToOwner(text: string, mentioned: boolean = /^@|^回复\s*@/.test((text ?? "").trim())): boolean {
    if (!mentioned) return false;
    return /(插件|分支|版本|更新|升级|隔离|原子锁|判重|仓库|提示词|人设|模型|工作台|日报|汇报)/.test(text ?? "");
}

/** 通用 AI 套话/总结式连接词。单独出现不足以判定，只作为弱证据。 */
const AI_BOILERPLATE_RE = /综上所述|总而言之|总的来说|简而言之|值得注意的是|不难看出|显而易见|毋庸置疑|首先.*其次.*最后|一方面.*另一方面/;
export function hasAiBoilerplate(text: string): boolean {
    return AI_BOILERPLATE_RE.test(text);
}
