/**
 * 决策层：把「检测结果 + 用户在类别表里选的处理方式」翻译成要不要动手。
 *
 * 处理方式直接复用 `DynamicSponsorOption`，和商品链接类别共用同一套枚举与设置，
 * 不再有第二套「AICG 处理模式」。这一层不碰 DOM，便于独立测试。
 */

import { DynamicSponsorOption } from "../../types";
import {
    AicgDetectionResult,
    AicgFeatureEvidence,
    AicgTuning,
    DEFAULT_AICG_MIN_LENGTH,
    DEFAULT_AICG_THRESHOLD,
} from "./types";

export interface AicgDecision {
    /** 实际要执行的动作；Disabled 表示不动这条评论 */
    option: DynamicSponsorOption;
    confidence: number;
    features: AicgFeatureEvidence[];
    threshold: number;
}

/** 从配置对象解析微调参数，缺失或非法时回落到默认值。 */
export function resolveAicgTuning(value: Partial<AicgTuning> | undefined): AicgTuning {
    const threshold = Number(value?.threshold);
    const minLength = Number(value?.minLength);
    return {
        threshold: Number.isFinite(threshold) && threshold >= 0 && threshold <= 1
            ? threshold
            : DEFAULT_AICG_THRESHOLD,
        minLength: Number.isFinite(minLength) && minLength >= 0
            ? Math.round(minLength)
            : DEFAULT_AICG_MIN_LENGTH,
        debug: Boolean(value?.debug),
    };
}

/**
 * 根据类别选项与检测结果给出动作。
 *
 * 注意「仅添加标签」与「隐藏内容/隐藏卡片」共用同一个阈值：
 * 阈值是用来控制「要不要认为它可疑」的，而不是控制「怎么展示」的。
 */
export function decideAicgOption(
    result: Pick<AicgDetectionResult, "confidence" | "features" | "tooShort">,
    option: DynamicSponsorOption,
    tuning: AicgTuning,
): AicgDecision {
    const base: AicgDecision = {
        option: DynamicSponsorOption.Disabled,
        confidence: result.confidence,
        features: result.features,
        threshold: tuning.threshold,
    };

    if (option === DynamicSponsorOption.Disabled) return base;
    if (result.tooShort) return base;
    if (result.confidence < tuning.threshold) return base;

    return { ...base, option };
}

/** 取最强的若干条命中特征，供调试标签显示（调用方再映射成 i18n 文案）。 */
export function summarizeFeatures(features: readonly AicgFeatureEvidence[], max = 3): string[] {
    return features.slice(0, max).map((feature) => feature.id);
}
