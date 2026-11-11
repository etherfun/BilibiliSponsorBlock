/**
 * 疑似 AICG 内容检测器（第一阶段：纯文本启发式规则）。
 *
 * 设计要点：
 * 1. 只读文本，不读 DOM，不读用户身份信息。
 * 2. 强证据来自「跨评论」的统计（模板复用、相似度、重复家族），
 *    而不是单条评论「写得很工整」——工整本身不是 AI 的证据。
 * 3. 单条结构特征只作为弱证据，避免把规范的真人长评论误判。
 * 4. 输出的是疑似程度与命中特征，不是「AI 身份」判定。
 */

import {
    AicgCommentInput,
    AicgConfidence,
    AicgDetectionResult,
    AicgDetector,
    AicgFeatureEvidence,
    AicgFeatureId,
} from "./types";
import {
    charNgrams,
    coefficientOfVariation,
    cjkCount,
    cjkPunctuationCount,
    codePointLength,
    emojiCount,
    hasAiBoilerplate,
    hasPersonaSelfReference,
    jaccard,
    looksColloquial,
    looksLikeReportToOwner,
    mean,
    normalizeCommentText,
    noveltyRatio,
    punctuationProfile,
    splitSentences,
    startsWithMention,
    stripMentionPrefix,
} from "./text";

/** 单个特征的最大权重。跨评论证据权重明显高于单条结构证据。 */
const FEATURE_WEIGHTS: Record<AicgFeatureId, number> = {
    templateReuse: 2.0,
    crossCommentSimilarity: 2.0,
    duplicateFamily: 1.0,
    lowInformationDensity: 1.0,
    personaSelfReference: 0.8,
    structuralUniformity: 0.8,
    reportToOwner: 0.6,
    punctuationRegularity: 0.5,
};

/** 特征强度到综合分数的放大系数，用于把 0~1 的证据映射到可操作的疑似程度。 */
const CONFIDENCE_SCALE = 1.25;
/**
 * 跨评论证据需要达到的强度，才能让综合疑似程度超过阈值。
 * 这是「不把规范长评误判为 AI」的关键闸门。
 */
const CROSS_COMMENT_REQUIRED = 0.45;

/** 一个 bigram 出现在多少条评论里就算「模板化」片段。 */
const TEMPLATE_DF_THRESHOLD = 5;
/** 计算信息密度时，df 低于该值的 bigram 视为新鲜内容。 */
const NOVELTY_DF_THRESHOLD = 4;
/** 跨评论相似度超过该值才开始产生证据。 */
const SIMILARITY_BASELINE = 0.28;
/** 重复家族至少这么大才开始产生证据。 */
const FAMILY_BASELINE = 2;

export interface AicgContext {
    /** 同一评论集合内的其它评论文本（不含被检测评论自身） */
    peerTexts: readonly string[];
    /** bigram -> 包含它的评论条数 */
    bigramDf: Map<string, number>;
    /** 归一化文本 -> 重复家族键 */
    familyOf: (normalizedText: string) => string;
    /** 家族键 -> 家族大小 */
    familySize: (familyKey: string) => number;
}

/**
 * 预计算跨评论统计，避免对每条评论都做 O(n²) 的两两比较。
 * 调用方对同一屏评论构建一次上下文，然后逐条检测。
 */
export function createAicgContext(peerTexts: readonly string[]): AicgContext {
    const normalized = peerTexts.map((peer) => normalizeCommentText(stripMentionPrefix(peer)));

    const bigramDf = new Map<string, number>();
    for (const text of normalized) {
        for (const gram of new Set(charNgrams(text, 2))) {
            bigramDf.set(gram, (bigramDf.get(gram) ?? 0) + 1);
        }
    }

    // 并查集：把「归一化后完全相同」或「bigram Jaccard >= 0.5」的评论合并成家族。
    const parent = normalized.map((_, i) => i);
    const find = (i: number): number => {
        let root = i;
        while (parent[root] !== root) root = parent[root];
        let cur = i;
        while (parent[cur] !== root) {
            const next = parent[cur];
            parent[cur] = root;
            cur = next;
        }
        return root;
    };
    const union = (a: number, b: number) => {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) parent[rb] = ra;
    };

    const gramsList = normalized.map((t) => charNgrams(t, 2));
    const lengthList = normalized.map(codePointLength);
    const comparable: Array<{ i: number; grams: Set<string>; len: number }> = [];
    for (let i = 0; i < normalized.length; i++) {
        if (lengthList[i] >= 20) comparable.push({ i, grams: gramsList[i], len: lengthList[i] });
    }
    // 只对长度接近的评论做比较，控制 O(n²) 的常数。
    for (let a = 0; a < comparable.length; a++) {
        for (let b = a + 1; b < comparable.length; b++) {
            const left = comparable[a];
            const right = comparable[b];
            if (Math.abs(left.len - right.len) > 40) continue;
            if (jaccard(left.grams, right.grams) >= 0.5) union(left.i, right.i);
        }
    }

    const sizes = new Map<number, number>();
    for (let i = 0; i < normalized.length; i++) {
        const root = find(i);
        sizes.set(root, (sizes.get(root) ?? 0) + 1);
    }

    const familyKeyToSize = new Map<string, number>();
    const textToRoot = new Map<string, number>();
    for (let i = 0; i < normalized.length; i++) {
        const root = find(i);
        textToRoot.set(normalized[i], root);
        const key = String(root);
        familyKeyToSize.set(key, Math.max(familyKeyToSize.get(key) ?? 0, sizes.get(root) ?? 0));
    }

    return {
        peerTexts,
        bigramDf,
        familyOf: (text) => {
            const root = textToRoot.get(text);
            return root === undefined ? text : String(root);
        },
        familySize: (key) => familyKeyToSize.get(key) ?? 1,
    };
}

export class HeuristicAicgDetector implements AicgDetector {
    detect(input: AicgCommentInput, context?: AicgContext): AicgDetectionResult {
        const rawText = input.text ?? "";
        // 分析正文而不是整条评论：`回复 @某人 :` 这种前缀在评论区里高度重复，
        // 拿它参与 n-gram 统计会把「礼貌地回一句」误判成模板化发言。
        const mentioned = startsWithMention(rawText);
        const body = stripMentionPrefix(rawText);
        const normalizedText = normalizeCommentText(body);
        const textLength = codePointLength(normalizedText);
        const minLength = input.minDetectableLength ?? 12;

        if (textLength === 0) {
            return emptyResult(normalizedText, textLength, true);
        }

        const ctx = context ?? createAicgContext(input.peers ?? []);
        const features: AicgFeatureEvidence[] = [];

        // 口语化/表情化的短评论直接跳过结构判断，这是明确的误判来源。
        const colloquial = looksColloquial(body) && textLength < 40;
        const tooShort = textLength < minLength || colloquial;

        // ---- 强证据 1：模板复用度 ----
        // 该评论中有多少比例的 bigram 是「很多评论都在用」的片段。
        const templateStrength = this.templateReuseStrength(normalizedText, ctx, tooShort);
        if (templateStrength > 0) {
            features.push({
                id: "templateReuse",
                strength: templateStrength,
                reason: `templateReuse:${templateStrength.toFixed(2)}`,
            });
        }

        // ---- 强证据 2：跨评论相似度 ----
        const similarityStrength = this.crossCommentSimilarityStrength(normalizedText, ctx, tooShort);
        if (similarityStrength > 0) {
            features.push({
                id: "crossCommentSimilarity",
                strength: similarityStrength,
                reason: `crossCommentSimilarity:${similarityStrength.toFixed(2)}`,
            });
        }

        // ---- 强证据 3：重复家族 ----
        const familyStrength = this.duplicateFamilyStrength(normalizedText, ctx, tooShort);
        if (familyStrength > 0) {
            features.push({
                id: "duplicateFamily",
                strength: familyStrength,
                reason: `duplicateFamily:${familyStrength.toFixed(2)}`,
            });
        }

        // ---- 弱证据 4：信息密度 ----
        const densityStrength = this.lowInformationStrength(normalizedText, ctx, tooShort);
        if (densityStrength > 0) {
            features.push({
                id: "lowInformationDensity",
                strength: densityStrength,
                reason: `lowInformationDensity:${densityStrength.toFixed(2)}`,
            });
        }

        // ---- 弱证据 5：人设自我指称 ----
        // 单独的「本鲸」可能只是真人玩梗，所以强度按跨评论证据缩放：
        // 没有跨评论证据时不产生特征，有证据时才作为辅助加权。
        const crossEvidence = Math.max(templateStrength, similarityStrength, familyStrength >= 0.2 ? familyStrength : 0);
        if (!tooShort && hasPersonaSelfReference(body) && looksLikeReportToOwner(body, mentioned)
            && crossEvidence > CROSS_COMMENT_REQUIRED * 0.5) {
            features.push({
                id: "personaSelfReference",
                strength: 0.55 * Math.min(1, crossEvidence / CROSS_COMMENT_REQUIRED),
                reason: "personaSelfReference",
            });
        }

        // ---- 弱证据 6：汇报式结构 ----
        if (!tooShort && looksLikeReportToOwner(body, mentioned)) {
            features.push({
                id: "reportToOwner",
                strength: 0.5,
                reason: "reportToOwner",
            });
        }

        // ---- 弱证据 7：句长分布过于均匀 ----
        const uniformity = this.structuralUniformityStrength(body, textLength, tooShort);
        if (uniformity > 0) {
            features.push({
                id: "structuralUniformity",
                strength: uniformity,
                reason: `structuralUniformity:${uniformity.toFixed(2)}`,
            });
        }

        // ---- 弱证据 8：标点使用机械 ----
        const punct = this.punctuationRegularityStrength(body, textLength, tooShort);
        if (punct > 0) {
            features.push({
                id: "punctuationRegularity",
                strength: punct,
                reason: `punctuationRegularity:${punct.toFixed(2)}`,
            });
        }

        // 通用 AI 套话作为极弱的加权修正，不单独成证据。
        const boilerplateBoost = !tooShort && hasAiBoilerplate(body) ? 0.08 : 0;

        const confidence = combine(features, boilerplateBoost);

        features.sort((a, b) => b.strength - a.strength);

        return {
            confidence,
            features,
            normalizedText,
            textLength,
            tooShort,
        };
    }

    private templateReuseStrength(text: string, ctx: AicgContext, tooShort: boolean): number {
        const grams = charNgrams(text, 2);
        if (!grams.size || tooShort) return 0;
        let templateGrams = 0;
        for (const g of grams) {
            // 计入被检测评论自身，df=1；阈值 5 表示「至少 5 条评论都在用」。
            if ((ctx.bigramDf.get(g) ?? 0) >= TEMPLATE_DF_THRESHOLD) templateGrams++;
        }
        const ratio = templateGrams / grams.size;
        // 0.35 起步，0.85 封顶，避免单条短模板直接拉满。
        if (ratio < 0.35) return 0;
        return Math.min(1, (ratio - 0.35) / 0.5);
    }

    private crossCommentSimilarityStrength(text: string, ctx: AicgContext, tooShort: boolean): number {
        if (tooShort) return 0;
        const grams = charNgrams(text, 2);
        if (grams.size < 8) return 0;
        let best = 0;
        let peerCount = 0;
        for (const peer of ctx.peerTexts) {
            const peerNormalized = normalizeCommentText(stripMentionPrefix(peer));
            // 与自身完全相同的文本不算「跨评论」证据。
            if (peerNormalized === text) continue;
            peerCount++;
            if (Math.abs(codePointLength(peerNormalized) - codePointLength(text)) > 40) continue;
            const score = jaccard(grams, charNgrams(peerNormalized, 2));
            if (score > best) best = score;
            if (best >= 1) break;
        }
        // 只有一条评论时不存在跨评论证据。
        if (peerCount === 0) return 0;
        if (best <= SIMILARITY_BASELINE) return 0;
        return Math.min(1, (best - SIMILARITY_BASELINE) / (1 - SIMILARITY_BASELINE));
    }

    private duplicateFamilyStrength(text: string, ctx: AicgContext, tooShort: boolean): number {
        if (tooShort) return 0;
        const size = ctx.familySize(ctx.familyOf(text));
        if (size < FAMILY_BASELINE) return 0;
        // 家族越大越可疑，但对数增长，避免单条超大簇把所有评论拉满。
        return Math.min(1, Math.log2(size) / Math.log2(20));
    }

    private lowInformationStrength(text: string, ctx: AicgContext, tooShort: boolean): number {
        if (tooShort || cjkCount(text) < 12) return 0;
        const novelty = noveltyRatio(text, ctx.bigramDf, NOVELTY_DF_THRESHOLD);
        const cjkRatio = cjkCount(text) / Math.max(1, codePointLength(text));
        // 模板化文本：新鲜度低且几乎全是中文（缺少人名、数字、链接等具体信息）。
        const raw = (1 - novelty) * cjkRatio;
        if (raw < 0.25) return 0;
        return Math.min(1, raw / 0.75);
    }

    private structuralUniformityStrength(rawText: string, textLength: number, tooShort: boolean): number {
        if (tooShort || textLength < 40) return 0;
        const sentences = splitSentences(rawText);
        if (sentences.length < 3) return 0;
        const lengths = sentences.map(codePointLength);
        const cv = coefficientOfVariation(lengths);
        // 真人写作句长波动大（CV 通常 0.5+），模板文本往往 0.2~0.4。
        if (cv >= 0.55) return 0;
        return Math.min(1, (0.55 - cv) / 0.4);
    }

    private punctuationRegularityStrength(rawText: string, textLength: number, tooShort: boolean): number {
        if (tooShort || textLength < 40) return 0;
        const profile = punctuationProfile(rawText);
        if (profile.total < 6) return 0;
        // 真人写作会混用多种标点；模板文本常常只有「，。」两种。
        const kindsFactor = Math.min(1, profile.kinds / 5);
        return (1 - kindsFactor) * 0.6 + (1 - profile.entropyRatio) * 0.4;
    }
}

/**
 * 证据合成。
 *
 * 关键设计：只有「跨评论」的强证据才能把疑似程度推过阈值。
 * 单条评论的结构特征（句长均匀、标点机械）只作为辅助证据，
 * 防止把「写得规范的真人长评论」误判为 AI —— 这是最容易造成误伤的地方。
 */
function combine(features: readonly AicgFeatureEvidence[], boost: number): AicgConfidence {
    if (!features.length) return 0;

    let numerator = 0;
    let denominator = 0;
    let strongestCrossComment = 0;
    let hasDuplicateEvidence = false;

    for (const feature of features) {
        const weight = FEATURE_WEIGHTS[feature.id];
        numerator += weight * feature.strength;
        denominator += weight;

        if (feature.id === "crossCommentSimilarity" || feature.id === "templateReuse") {
            strongestCrossComment = Math.max(strongestCrossComment, feature.strength);
        }
        if (feature.id === "duplicateFamily" && feature.strength > 0.2) {
            hasDuplicateEvidence = true;
        }
    }

    if (denominator === 0) return 0;

    const weighted = numerator / denominator;
    // 跨评论证据不足时，整体疑似程度被压到阈值以下：
    // 单条「写得工整」的评论本身不构成 AI 证据。
    const crossCommentCap = hasDuplicateEvidence ? 1 : Math.max(0, strongestCrossComment / CROSS_COMMENT_REQUIRED);
    const capped = weighted * Math.min(1, crossCommentCap);

    return Math.max(0, Math.min(1, capped * CONFIDENCE_SCALE + boost));
}

function emptyResult(normalizedText: string, textLength: number, tooShort: boolean): AicgDetectionResult {
    return { confidence: 0, features: [], normalizedText, textLength, tooShort };
}

/** 便捷函数：一次性检测一组评论并返回每条结果。 */
export function detectComments(
    texts: readonly string[],
    options?: { minDetectableLength?: number },
): AicgDetectionResult[] {
    const context = createAicgContext(texts);
    const detector = new HeuristicAicgDetector();
    return texts.map((text) =>
        detector.detect(
            { text, minDetectableLength: options?.minDetectableLength },
            context,
        ),
    );
}

/** 供测试与调研脚本使用的统计辅助：句子平均长度。 */
export function averageSentenceLength(rawText: string): number {
    const sentences = splitSentences(rawText);
    if (!sentences.length) return 0;
    return mean(sentences.map(codePointLength));
}

export { cjkPunctuationCount, emojiCount, stripMentionPrefix };
