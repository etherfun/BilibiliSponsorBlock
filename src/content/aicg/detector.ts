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
    jaccard,
    countOwnerAddress,
    countPersonaSelfReference,
    countReportClosing,
    hasActionNarration,
    hasPromoInstruction,
    hasPromoWithLink,
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
    sharedPhraseCoverage: 1.8,
    duplicateFamily: 1.0,
    // 单条即可成立的「标记」：不依赖评论区里有没有同类评论
    personaSelfReference: 1.4,
    ownerAddress: 1.2,
    actionNarration: 1.3,
    promoInstruction: 1.1,
    reportClosing: 1.1,
    sameAuthorBurst: 1.2,
    // 跨视频记忆：短语本身已经过「>=3 个作者在同一个视频」的检验
    knownPhrase: 1.2,
    // 用户显式教学的自定正则：combine() 里直接判 1，不走加权
    userPattern: 3.0,
    lowInformationDensity: 1.0,
    aiPhraseDensity: 0.6,
    structuralUniformity: 0.8,
    reportToOwner: 0.6,
    punctuationRegularity: 0.5,
};

/**
 * 「单条标记」特征：它们描述的是**内容形态**（扮演人设、称呼主人、舞台指示、
 * 推广行为、交差收尾、同账号连发），不是「写得好不好」，所以单条评论就能成立。
 *
 * 这是实测后最重要的修正：真实场景里 AI 评论是**零散夹杂**在正常评论之间的，
 * 每条独立生成、互不相似，跨评论统计（bigram df、Jaccard、短语跨作者复用）
 * 永远到不了阈值，还会被正常评论稀释 —— 只有成簇一条通道时疑似度恒为 0。
 */
const MARKER_FEATURES = new Set<AicgFeatureId>([
    "personaSelfReference",
    "ownerAddress",
    "actionNarration",
    "promoInstruction",
    "reportClosing",
    "sameAuthorBurst",
    "knownPhrase",
]);

/**
 * 通用书面语/套话套路。刻意只收跨领域的表达，不收任何具体视频的口头禅，
 * 避免检测器只对某一个评论区有效。
 */
const AI_PHRASES = [
    "综上所述", "总而言之", "总的来说", "简而言之", "归根结底",
    "值得注意的是", "值得一提的是", "需要说明的是", "不难看出", "显而易见",
    "毋庸置疑", "由此可见", "可以说", "换言之", "换句话说",
    "首先", "其次", "再次", "最后", "第一点", "第二点", "第三点",
    "一方面", "另一方面", "不仅", "而且", "与此同时", "除此之外", "此外",
    "建议", "总结", "核心", "关键在于", "本质上", "整体来看", "从整体",
    "提升", "赋能", "闭环", "抓手", "维度", "层面", "链路", "范式", "颗粒度",
    "在此基础上", "进一步", "从而", "因此", "所以", "总的来说",
];

/** 统计一条文本命中的通用套话次数（不重复计同一条短语的多次出现，避免刷词）。 */
function countAiPhrases(text: string): number {
    let hits = 0;
    for (const phrase of AI_PHRASES) {
        if (text.includes(phrase)) hits++;
    }
    return hits;
}

/** 特征强度到综合分数的放大系数，用于把 0~1 的证据映射到可操作的疑似程度。 */
const CONFIDENCE_SCALE = 1.25;
/**
 * 跨评论证据需要达到的强度，才能让综合疑似程度超过阈值。
 * 这是「不把规范长评误判为 AI」的关键闸门。
 */
const CROSS_COMMENT_REQUIRED = 0.45;

/** 一个 bigram 出现在多少条评论里就算「模板化」片段。 */
const TEMPLATE_DF_THRESHOLD = 4;
/**
 * bigram 流行度上限（占上下文评论数的比例）：超过它的视为话题词而非模板。
 * 「插件」「视频」这类词在讨论同一话题的评论区里 df 极高，但它们不是批量证据。
 */
const UBIQUITOUS_BIGRAM_RATIO = 0.35;
/** 模板证据不再随长度打折的正文长度：低于它的评论即使复述模板，证据也按比例折减。 */
const TEMPLATE_FULL_EVIDENCE_LENGTH = 60;
/** 计算信息密度时，df 低于该值的 bigram 视为新鲜内容。 */
const NOVELTY_DF_THRESHOLD = 4;
/** 跨评论相似度超过该值才开始产生证据。 */
const SIMILARITY_BASELINE = 0.28;
/** 重复家族至少这么大才开始产生证据。 */
const FAMILY_BASELINE = 2;
/**
 * 跨评论特征（模板复用 / 相似度 / 短语覆盖）要求的最小正文长度。
 * 太短的评论 bigram 数量少，一个常用词就能把比例刷高，造成一对一误伤
 * （例如「不错不错，可以给你在强化一下」这种真人短句）。
 */
const MIN_CROSS_EVIDENCE_LENGTH = 20;

/**
 * 短语复用：长度固定为 PHRASE_LEN 个字符、且被至少 PHRASE_AUTHOR_DF 个
 * **不同作者**用过的片段。要求跨作者，是为了把「同一个人刷屏」和
 * 「一批账号共用同一套话术」区分开 —— 后者才是批量生成的强证据。
 *
 * 8 字中文片段 + 3 个不同作者已经足够特异（8 字偶然重合率极低）；
 * 之前要求 4 个，在「AI 评论零散夹杂、正常评论稀释」的真实评论区里
 * 经常凑不齐，是命中率偏低的原因之一。
 */
const PHRASE_LEN = 8;
const PHRASE_AUTHOR_DF = 3;

/** 同一作者的主评论数达到该值即视为批量行为（真人极少在一个视频下连发 3 条主评论）。 */
const SAME_AUTHOR_BURST_MIN = 3;

/**
 * 数一条评论命中了多少个「跨视频已知短语」（去重）。
 * 已知短语是 8 字片段的集合，滑窗逐位查询，O(评论长度)。
 */
function countKnownPhraseWindows(normalizedText: string, known?: ReadonlySet<string>): number {
    if (!known?.size || normalizedText.length < PHRASE_LEN) return 0;
    const hit = new Set<string>();
    for (let at = 0; at + PHRASE_LEN <= normalizedText.length; at++) {
        const phrase = normalizedText.slice(at, at + PHRASE_LEN);
        if (known.has(phrase)) hit.add(phrase);
    }
    return hit.size;
}

export interface AicgContext {
    /** 同一评论集合内的其它评论文本（不含被检测评论自身） */
    peerTexts: readonly string[];
    /** bigram -> 包含它的评论条数 */
    bigramDf: Map<string, number>;
    /** bigram -> 包含它的不同作者数 */
    bigramAuthorDf: Map<string, number>;
    /** 归一化文本 -> 重复家族键 */
    familyOf: (normalizedText: string) => string;
    /** 家族键 -> 家族大小 */
    familySize: (familyKey: string) => number;
    /** 跨作者共享短语（固定长度字符片段），用于计算短语覆盖度 */
    sharedPhrases: Set<string>;
}

/**
 * 预计算跨评论统计，避免对每条评论都做 O(n²) 的两两比较。
 * 调用方对同一屏评论构建一次上下文，然后逐条检测。
 *
 * `peerAuthors` 可选，与 `peerTexts` 一一对应；拿不到作者时退化为按评论数统计。
 */
export function createAicgContext(
    peerTexts: readonly string[],
    peerAuthors?: readonly string[],
): AicgContext {
    const normalized = peerTexts.map((peer) => normalizeCommentText(stripMentionPrefix(peer)));
    const authors = peerTexts.map((_, index) => peerAuthors?.[index] || `#${index}`);

    const bigramDf = new Map<string, number>();
    /** 每个 bigram 被哪些作者用过 */
    const bigramAuthors = new Map<string, Set<string>>();
    for (let i = 0; i < normalized.length; i++) {
        for (const gram of new Set(charNgrams(normalized[i], 2))) {
            bigramDf.set(gram, (bigramDf.get(gram) ?? 0) + 1);
            let set = bigramAuthors.get(gram);
            if (!set) {
                set = new Set();
                bigramAuthors.set(gram, set);
            }
            set.add(authors[i]);
        }
    }
    const bigramAuthorDf = new Map<string, number>();
    const sharedPhrases = new Set<string>();
    for (const [gram, set] of bigramAuthors) {
        bigramAuthorDf.set(gram, set.size);
    }

    // 短语按固定长度重新统计：bigram 太短，不能代表「一套话术」。
    const phraseAuthors = new Map<string, Set<string>>();
    for (let i = 0; i < normalized.length; i++) {
        const text = normalized[i];
        for (let at = 0; at + PHRASE_LEN <= text.length; at++) {
            const phrase = text.slice(at, at + PHRASE_LEN);
            let set = phraseAuthors.get(phrase);
            if (!set) {
                set = new Set();
                phraseAuthors.set(phrase, set);
            }
            set.add(authors[i]);
        }
    }
    for (const [phrase, set] of phraseAuthors) {
        if (set.size >= PHRASE_AUTHOR_DF) sharedPhrases.add(phrase);
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
        bigramAuthorDf,
        familyOf: (text) => {
            const root = textToRoot.get(text);
            return root === undefined ? text : String(root);
        },
        familySize: (key) => familyKeyToSize.get(key) ?? 1,
        sharedPhrases,
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

        // ---- 强证据 4：跨作者共享短语覆盖度 ----
        // 改写过措辞的 AI 评论 bigram 相似度可能不高，但「同一套事实包」的长片段
        // 仍会被多个不同作者复用。这一项专门补改写型的召回。
        // 先算它：模板复用是否打折取决于有没有长片段复用（见下）。
        const phraseStrength = this.sharedPhraseCoverageStrength(normalizedText, ctx, tooShort);
        if (phraseStrength > 0) {
            features.push({
                id: "sharedPhraseCoverage",
                strength: phraseStrength,
                reason: `sharedPhraseCoverage:${phraseStrength.toFixed(2)}`,
            });
        }

        // ---- 强证据 1：模板复用度 ----
        // 该评论中有多少比例的 bigram 是「很多评论都在用」的片段。
        // 有长片段复用时按原强度计入；没有时按长度折减——
        // 通用短评（30 字聊天的常见词占比高）不构成模板证据。
        const templateStrength = this.templateReuseStrength(normalizedText, ctx, tooShort)
            * (phraseStrength > 0 ? 1 : Math.min(1, textLength / TEMPLATE_FULL_EVIDENCE_LENGTH));
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

        // ---- 弱证据 5：信息密度 ----
        const densityStrength = this.lowInformationStrength(normalizedText, ctx, tooShort);
        if (densityStrength > 0) {
            features.push({
                id: "lowInformationDensity",
                strength: densityStrength,
                reason: `lowInformationDensity:${densityStrength.toFixed(2)}`,
            });
        }

        // ---- 弱证据 6：通用 AI 套话密度 ----
        // 这是「关键词」层面的通用特征（不是本数据集特有的口头禅），单独很弱，
        // 但在跨评论证据存在时能帮改写型文本过线。
        const phraseDensity = this.aiPhraseDensityStrength(body, textLength, tooShort);
        if (phraseDensity > 0) {
            features.push({
                id: "aiPhraseDensity",
                strength: phraseDensity,
                reason: `aiPhraseDensity:${phraseDensity.toFixed(2)}`,
            });
        }

        // ---- 标记证据（单条即可成立，不依赖评论区有没有同类评论）----
        // 真实场景里 AI 评论零散夹杂在正常评论之间，成簇证据经常完全不存在，
        // 所以必须有这条独立通道，否则疑似度会恒为 0。
        const personaCount = countPersonaSelfReference(body);
        if (!tooShort && personaCount > 0) {
            features.push({
                id: "personaSelfReference",
                strength: Math.min(1, 0.7 + 0.15 * (personaCount - 1)),
                reason: `personaSelfReference:${personaCount}`,
            });
        }

        const ownerCount = countOwnerAddress(body);
        if (!tooShort && ownerCount > 0) {
            features.push({
                id: "ownerAddress",
                strength: Math.min(1, 0.6 + 0.15 * (ownerCount - 1)),
                reason: `ownerAddress:${ownerCount}`,
            });
        }

        if (!tooShort && hasActionNarration(body)) {
            features.push({
                id: "actionNarration",
                strength: 0.8,
                reason: "actionNarration",
            });
        }

        if (!tooShort && (hasPromoInstruction(body) || hasPromoWithLink(rawText))) {
            features.push({
                id: "promoInstruction",
                strength: 0.75,
                reason: "promoInstruction",
            });
        }

        // ---- 标记 5：汇报式收尾 ----
        const closingCount = countReportClosing(body);
        if (!tooShort && closingCount > 0) {
            features.push({
                id: "reportClosing",
                strength: Math.min(1, 0.7 + 0.1 * (closingCount - 1)),
                reason: `reportClosing:${closingCount}`,
            });
        }

        // ---- 标记 6：同账号连发 ----
        // 真人极少在一个视频下连发 3 条以上主评论；这是纯元数据信号，
        // 不依赖文本内容，对「每条都改写」的批量账号尤其有效。
        const burstCount = input.authorPostCount ?? 0;
        if (!tooShort && burstCount >= SAME_AUTHOR_BURST_MIN) {
            features.push({
                id: "sameAuthorBurst",
                strength: Math.min(1, 0.6 + 0.1 * (burstCount - SAME_AUTHOR_BURST_MIN)),
                reason: `sameAuthorBurst:${burstCount}`,
            });
        }

        // ---- 标记 7：跨视频记忆的已知短语 ----
        // 短语在被学习时已经过「同一个视频里 >=3 个不同作者在用」的检验，
        // 新视频里再次出现说明同一批内容蔓延了过来。8 字滑窗 O(n)。
        const knownHits = countKnownPhraseWindows(normalizedText, input.knownPhrases);
        if (knownHits > 0) {
            features.push({
                id: "knownPhrase",
                strength: Math.min(1, 0.7 + 0.15 * (knownHits - 1)),
                reason: `knownPhrase:${knownHits}`,
            });
        }

        // ---- 用户自定义规则：显式教学，命中即判定 ----
        // 不受 tooShort/口语闸门限制——用户写的规则就是用户自己的判定标准。
        // 正则同时匹配正文和原始文本（规则可能想匹配 @昵称 这类被剥掉的前缀）。
        if (input.customPatterns?.length) {
            for (const pattern of input.customPatterns) {
                pattern.lastIndex = 0;
                if (pattern.test(body) || pattern.test(rawText)) {
                    features.push({
                        id: "userPattern",
                        strength: 1,
                        reason: "userPattern",
                    });
                    break;
                }
                pattern.lastIndex = 0;
            }
        }

        // ---- 弱证据 7：汇报式结构 ----
        // 这是本评论区特有的词汇表（插件/分支/原子锁…），只作为辅助标记，
        // 单独不构成通道 A 的计数标记（它不在 MARKER_FEATURES 里）。
        // @ 提及在任何位置都算——AI 评论常把「收件人」放在结尾。
        if (!tooShort && looksLikeReportToOwner(body, mentioned || /@[\w\u4e00-\u9fff]/.test(rawText))) {
            features.push({
                id: "reportToOwner",
                strength: 0.5,
                reason: "reportToOwner",
            });
        }

        // ---- 弱证据 9：句长分布过于均匀 ----
        const uniformity = this.structuralUniformityStrength(body, textLength, tooShort);
        if (uniformity > 0) {
            features.push({
                id: "structuralUniformity",
                strength: uniformity,
                reason: `structuralUniformity:${uniformity.toFixed(2)}`,
            });
        }

        // ---- 弱证据 10：标点使用机械 ----
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

    /**
     * 跨作者共享短语覆盖度：该评论有多少比例的字符被「多个不同作者都用过的片段」覆盖。
     *
     * 与 bigram 相似度的区别：相似度要求整体重合，这里只看「事实包」是否被复用，
     * 所以改写句式的 AI 评论也能被抓到。
     */
    private sharedPhraseCoverageStrength(text: string, ctx: AicgContext, tooShort: boolean): number {
        if (tooShort || text.length < MIN_CROSS_EVIDENCE_LENGTH || ctx.sharedPhrases.size === 0) return 0;

        // 滑动窗口逐位判断，复杂度 O(n)，不用对每个短语做 indexOf。
        const covered = new Array<boolean>(text.length).fill(false);
        let coveredCount = 0;
        for (let at = 0; at + PHRASE_LEN <= text.length; at++) {
            if (!ctx.sharedPhrases.has(text.slice(at, at + PHRASE_LEN))) continue;
            for (let k = at; k < at + PHRASE_LEN; k++) {
                if (!covered[k]) {
                    covered[k] = true;
                    coveredCount++;
                }
            }
        }

        const ratio = coveredCount / text.length;
        // 0.25 起步：真人偶尔也会蹭到一两个流行短语，不到这个比例不算证据。
        if (ratio < 0.25) return 0;
        return Math.min(1, (ratio - 0.25) / 0.55);
    }

    /**
     * 通用 AI 套话密度。
     *
     * 这里用的是**跨领域**的书面语套路（总结词、连接词、拔高句），
     * 不是某个视频特有的口头禅，所以不会只对某一个评论区有效。
     */
    private aiPhraseDensityStrength(text: string, textLength: number, tooShort: boolean): number {
        if (tooShort || textLength < 30) return 0;
        const hits = countAiPhrases(text);
        if (hits === 0) return 0;
        // 每 40 字命中 1 次算满强度，避免长评论按绝对次数压制短评论。
        const density = hits / Math.max(1, textLength / 40);
        return Math.min(1, density);
    }

    private templateReuseStrength(text: string, ctx: AicgContext, tooShort: boolean): number {
        const grams = charNgrams(text, 2);
        // 短评论的 bigram 太少，随便一个常用词就能把比例刷高，因此不参与模板判定。
        if (!grams.size || tooShort || text.length < MIN_CROSS_EVIDENCE_LENGTH) return 0;
        // 流行度上限：出现在远超半数评论里的 bigram 是话题词/停用词（「插件」「视频」「一下」），
        // 不是模板证据——不加这条，讨论同一话题的正常短评会被整体判成模板。
        // 但只在上下文足够大（≥30 条）时才适用：几条评论的小样本里
        // 「大家都用」本来就说明是同一套话术，不能套比例上限。
        const total = ctx.peerTexts.length;
        const ubiquitousCap = total >= 30
            ? Math.floor(UBIQUITOUS_BIGRAM_RATIO * total)
            : Number.MAX_SAFE_INTEGER;
        let templateGrams = 0;
        for (const g of grams) {
            const df = ctx.bigramDf.get(g) ?? 0;
            // 计入被检测评论自身；下限 = 至少几条评论在用，上限 = 还没普遍到成为话题词。
            if (df >= TEMPLATE_DF_THRESHOLD && df <= ubiquitousCap) templateGrams++;
        }
        const ratio = templateGrams / grams.size;
        // 0.35 起步，0.85 封顶，避免单条短模板直接拉满。
        // 长度折减在 detect() 里做：是否折减取决于有没有长片段复用。
        if (ratio < 0.35) return 0;
        return Math.min(1, (ratio - 0.35) / 0.5);
    }

    private crossCommentSimilarityStrength(text: string, ctx: AicgContext, tooShort: boolean): number {
        if (tooShort || text.length < MIN_CROSS_EVIDENCE_LENGTH) return 0;
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
 *
 * 强度低于 NOISE_FLOOR 的特征直接不参与计算：否则一堆接近 0 的弱特征会把
 * 真正可疑的评论拉低到阈值以下（早期版本就吃过这个亏）。
 */
const NOISE_FLOOR = 0.15;

/**
 * 通道 A（单条标记）的判定口径：
 * 至少 MARKER_COUNT_FOR_HIT 个互相独立的标记同时成立才开始计分，
 * 达到这个数量即 MARKER_BASE，之后每多一个加 MARKER_STEP。
 *
 * 之所以要求「两个以上」：单一标记都有合理的真人解释
 * （跟作者开玩笑叫主人、排版习惯用括号），两个同时命中才基本只剩扮演人设的生成文本。
 */
const MARKER_MIN_STRENGTH = 0.5;
const MARKER_COUNT_FOR_HIT = 2;
const MARKER_BASE = 0.62;
const MARKER_STEP = 0.12;

function combine(features: readonly AicgFeatureEvidence[], boost: number): AicgConfidence {
    if (!features.length) return 0;

    // 用户自定义规则是显式教学：命中即判 1，不参与加权（同类净化扩展的黑名单语义）。
    if (features.some((feature) => feature.id === "userPattern")) return 1;

    let numerator = 0;
    let denominator = 0;
    let strongestCrossComment = 0;
    let hasDuplicateEvidence = false;
    let markerCount = 0;

    for (const feature of features) {
        if (feature.strength < NOISE_FLOOR) continue;

        const weight = FEATURE_WEIGHTS[feature.id];
        numerator += weight * feature.strength;
        denominator += weight;

        if (feature.id === "crossCommentSimilarity"
            || feature.id === "templateReuse"
            || feature.id === "sharedPhraseCoverage") {
            strongestCrossComment = Math.max(strongestCrossComment, feature.strength);
        }
        if (feature.id === "duplicateFamily" && feature.strength > 0.2) {
            hasDuplicateEvidence = true;
        }
        if (MARKER_FEATURES.has(feature.id) && feature.strength >= MARKER_MIN_STRENGTH) {
            markerCount++;
        }
    }

    // ---- 通道 A：标记特征（单条即可成立）----
    // 两个及以上**互相独立**的标记同时出现才算数：只出现「主人」可能是在跟作者开玩笑，
    // 只出现一个括号动作也可能是排版习惯；两者同时出现基本只能是扮演人设的生成文本。
    const markerScore = markerCount >= MARKER_COUNT_FOR_HIT
        ? Math.min(1, MARKER_BASE + MARKER_STEP * (markerCount - MARKER_COUNT_FOR_HIT))
        : 0;

    // ---- 通道 B：成簇证据 ----
    // 跨评论证据不足时被闸门压到阈值以下：单条「写得工整」不构成 AI 证据。
    let clusterScore = 0;
    if (denominator > 0) {
        const weighted = numerator / denominator;
        const crossCommentCap = hasDuplicateEvidence
            ? 1
            : Math.max(0, strongestCrossComment / CROSS_COMMENT_REQUIRED);
        clusterScore = weighted * Math.min(1, crossCommentCap) * CONFIDENCE_SCALE;
    }

    return Math.max(0, Math.min(1, Math.max(markerScore, clusterScore) + boost));
}

function emptyResult(normalizedText: string, textLength: number, tooShort: boolean): AicgDetectionResult {
    return { confidence: 0, features: [], normalizedText, textLength, tooShort };
}

/** 便捷函数：一次性检测一组评论并返回每条结果。 */
export function detectComments(
    texts: readonly string[],
    options?: {
        minDetectableLength?: number;
        authors?: readonly string[];
        customPatterns?: readonly RegExp[];
        knownPhrases?: ReadonlySet<string>;
    },
): AicgDetectionResult[] {
    const context = createAicgContext(texts, options?.authors);
    // 单元测试路径没有「主评论/子评论」之分，全部按主评论计数。
    const postCounts = new Map<string, number>();
    (options?.authors ?? []).forEach((author) => {
        if (!author) return;
        postCounts.set(author, (postCounts.get(author) ?? 0) + 1);
    });
    const detector = new HeuristicAicgDetector();
    return texts.map((text, index) =>
        detector.detect(
            {
                text,
                minDetectableLength: options?.minDetectableLength,
                author: options?.authors?.[index],
                authorPostCount: postCounts.get(options?.authors?.[index] ?? ""),
                customPatterns: options?.customPatterns,
                knownPhrases: options?.knownPhrases,
            },
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
