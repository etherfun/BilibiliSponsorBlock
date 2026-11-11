/**
 * 疑似 AICG 内容检测：类型定义。
 *
 * 检测层只依赖纯文本与跨评论统计，不接触 DOM。
 * 命中之后**不自己决定怎么展示**：处理方式复用现有 `dynamicSponsor_aicg` 类别的
 * `DynamicSponsorOption`，由 `SponsorComment` 统一执行，与商品链接过滤共用一套机制。
 */

/** 疑似程度：0 表示没有证据，1 表示证据充分。它不是「AI 概率」，也不是身份判定。 */
export type AicgConfidence = number;

export type AicgFeatureId =
    | "templateReuse"
    | "crossCommentSimilarity"
    | "duplicateFamily"
    | "sharedPhraseCoverage"
    | "structuralUniformity"
    | "punctuationRegularity"
    | "lowInformationDensity"
    | "personaSelfReference"
    | "reportToOwner"
    | "aiPhraseDensity";

export interface AicgFeatureEvidence {
    id: AicgFeatureId;
    /** 该特征自身的证据强度，0~1 */
    strength: number;
    /** 人类可读的理由，用于调试标签（i18n key 或原始文本） */
    reason: string;
}

/** 检测器输入：一条评论的文本 + 可选的上下文信息。 */
export interface AicgCommentInput {
    /** 评论正文（已去掉 HTML，保留 @用户名 等文本） */
    text: string;
    /** 是否为回复/子评论 */
    isReply?: boolean;
    /** 同一评论集合内其它评论的文本，用于跨评论相似度与重复家族统计 */
    peers?: readonly string[];
    /** 同一评论集合内其它评论的作者标识，与 peers 一一对应，用于统计跨作者复用 */
    peerAuthors?: readonly string[];
    /** 本条评论的作者标识 */
    author?: string;
    /** 检测时可用的最小文本长度，低于该长度不做结构类判断 */
    minDetectableLength?: number;
}

export interface AicgDetectionResult {
    /** 综合疑似程度 0~1 */
    confidence: AicgConfidence;
    /** 命中的特征，按强度降序 */
    features: AicgFeatureEvidence[];
    /** 归一化后的文本（去空白、去 @提及前缀），供执行层缓存使用 */
    normalizedText: string;
    /** 文本长度（归一化后） */
    textLength: number;
    /** 是否因为太短而无法判断 */
    tooShort: boolean;
}

export interface AicgDetector {
    detect(input: AicgCommentInput, context?: unknown): AicgDetectionResult;
}

/** AICG 类别的可调参数。处理方式本身由 dynamicSponsorSelections 决定，不在这里。 */
export interface AicgTuning {
    /** 达到该疑似程度才执行处理 */
    threshold: number;
    /** 文本短于该长度时跳过结构类检测 */
    minLength: number;
    /** 调试模式：标签中显示命中特征 */
    debug: boolean;
}

/** 疑似 AICG 在设置里的类别名，与动态主页/评论区的其它类别并列。 */
export const AICG_CATEGORY = "dynamicSponsor_aicg";

/** 决策层的默认阈值：证据强度 0.55 以上才动手。 */
export const DEFAULT_AICG_THRESHOLD = 0.55;
export const DEFAULT_AICG_MIN_LENGTH = 12;

