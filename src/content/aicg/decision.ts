/**
 * 决策层：把检测结果 + 用户配置翻译成具体动作。
 * 这一层不碰 DOM，便于独立测试。
 */

import {
    AicgAction,
    AicgConfig,
    AicgDecision,
    AicgDetectionResult,
    DEFAULT_AICG_MIN_LENGTH,
    DEFAULT_AICG_THRESHOLD,
} from "./types";

export function resolveAicgConfig(value: Partial<AicgConfig> | undefined): AicgConfig {
    return {
        action: value?.action ?? AicgAction.Disabled,
        threshold: value?.threshold ?? DEFAULT_AICG_THRESHOLD,
        minLength: value?.minLength ?? DEFAULT_AICG_MIN_LENGTH,
        debug: value?.debug ?? false,
    };
}

export function decideAicgAction(
    result: Pick<AicgDetectionResult, "confidence" | "features" | "tooShort">,
    config: AicgConfig,
): AicgDecision {
    if (config.action === AicgAction.Disabled || result.tooShort) {
        return {
            action: AicgAction.Disabled,
            confidence: result.confidence,
            features: result.features,
            threshold: config.threshold,
        };
    }

    if (result.confidence < config.threshold) {
        return {
            action: AicgAction.Disabled,
            confidence: result.confidence,
            features: result.features,
            threshold: config.threshold,
        };
    }

    let action: AicgAction;
    switch (config.action) {
        case AicgAction.HideCard:
            action = AicgAction.HideCard;
            break;
        case AicgAction.HideContent:
            action = AicgAction.HideContent;
            break;
        case AicgAction.Label:
        default:
            action = AicgAction.Label;
            break;
    }

    return {
        action,
        confidence: result.confidence,
        features: result.features,
        threshold: config.threshold,
    };
}

/** 标签上显示的命中特征（最多保留最强的若干条）。 */
export function summarizeFeatures(features: AicgDecision["features"], max = 3): string[] {
    return features.slice(0, max).map((f) => f.reason);
}
