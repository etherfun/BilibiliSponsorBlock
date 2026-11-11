/**
 * 疑似 AICG 内容检测：类型定义。
 *
 * 检测层只依赖纯文本与跨评论统计，不接触 DOM；决策层把检测结果翻译成
 * 「加标签 / 隐藏内容 / 隐藏卡片」；执行层才操作评论节点。三层之间只通过
 * 这里的类型通信，便于单测与后续替换检测器（例如换成 ONNX 分类模型）。
 */

/** 疑似程度：0 表示没有证据，1 表示证据充分。它不是「AI 概率」，也不是身份判定。 */
export type AicgConfidence = number;

export type AicgFeatureId =
    | "templateReuse"
    | "crossCommentSimilarity"
    | "duplicateFamily"
    | "structuralUniformity"
    | "punctuationRegularity"
    | "lowInformationDensity"
    | "personaSelfReference"
    | "reportToOwner";

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
    /** 同一条评论已经被处理过的标记，用于去重 */
    key?: string;
    /** 同一评论集合内其它评论的文本，用于跨评论相似度与重复家族统计 */
    peers?: readonly string[];
    /** 同一作者在本集合内的其它评论文本 */
    sameAuthorPeers?: readonly string[];
    /** 检测时可用的最小文本长度，低于该长度不做结构类判断 */
    minDetectableLength?: number;
}

export interface AicgDetectionResult {
    /** 综合疑似程度 0~1 */
    confidence: AicgConfidence;
    /** 命中的特征，按强度降序 */
    features: AicgFeatureEvidence[];
    /** 归一化后的文本（去空白），供执行层缓存使用 */
    normalizedText: string;
    /** 文本长度（归一化后） */
    textLength: number;
    /** 是否因为太短而无法判断 */
    tooShort: boolean;
}

/** 用户可选的处理模式，与设置项一一对应。 */
export enum AicgAction {
    /** 禁用：不做任何检测 */
    Disabled = 0,
    /** 仅添加标签 */
    Label = 1,
    /** 隐藏评论文本，保留容器与交互 */
    HideContent = 2,
    /** 隐藏整条评论卡片 */
    HideCard = 3,
}

export interface AicgDecision {
    action: AicgAction;
    confidence: AicgConfidence;
    features: AicgFeatureEvidence[];
    /** 触发本次决策的阈值，便于调试 */
    threshold: number;
}

export interface AicgDetector {
    detect(input: AicgCommentInput): AicgDetectionResult;
}

export interface AicgConfig {
    action: AicgAction;
    /** 达到该疑似程度才执行「隐藏」类操作；仅添加标签时同样适用 */
    threshold: number;
    /** 文本短于该长度时跳过结构类检测 */
    minLength: number;
    /** 调试模式：标签中显示命中特征 */
    debug: boolean;
}

/** 决策层的默认阈值：证据强度 0.55 以上才动手。 */
export const DEFAULT_AICG_THRESHOLD = 0.55;
export const DEFAULT_AICG_MIN_LENGTH = 12;

export function isAicgAction(value: unknown): value is AicgAction {
    return value === AicgAction.Disabled
        || value === AicgAction.Label
        || value === AicgAction.HideContent
        || value === AicgAction.HideCard;
}
