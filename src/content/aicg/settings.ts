/**
 * 疑似 AICG 类别的设置读取。
 *
 * 处理方式（禁用 / 仅添加标签 / 隐藏内容 / 隐藏卡片）存放在 dynamicSponsorSelections
 * 的 `dynamicSponsor_aicg` 条目里，与商品链接类别共用同一套存储与设置 UI；
 * 判定阈值、最小长度、调试开关是这个类别自己的微调项。
 */

import Config from "../../config";
import { DynamicSponsorOption } from "../../types";
import { resolveAicgTuning } from "./decision";
import { AICG_CATEGORY, AicgTuning } from "./types";

export { AICG_CATEGORY };

/** 读取「疑似 AICG 内容」这一行在类别表里选中的处理方式。 */
export function getAicgOption(): DynamicSponsorOption {
    const selections = Config.config?.dynamicSponsorSelections ?? [];
    for (const selection of selections) {
        if (selection?.name === AICG_CATEGORY) {
            const option = Number(selection.option);
            return option === DynamicSponsorOption.ShowOverlay
                || option === DynamicSponsorOption.Hide
                || option === DynamicSponsorOption.HideCard
                ? option
                : DynamicSponsorOption.Disabled;
        }
    }
    return DynamicSponsorOption.Disabled;
}

export function isAicgEnabled(): boolean {
    return getAicgOption() !== DynamicSponsorOption.Disabled;
}

/**
 * 读取 AICG 微调参数。
 * 设置页的 number 输入写回的是字符串，resolveAicgTuning 会把它们规范化为数字并校验范围。
 */
export function getAicgTuning(): AicgTuning {
    return resolveAicgTuning({
        threshold: Number(Config.config?.commentAicgThreshold),
        minLength: Number(Config.config?.commentAicgMinLength),
        debug: Boolean(Config.config?.commentAicgDebug),
    });
}

/**
 * 评论区是否需要扫描。
 *
 * AICG 有自己的类别行，因此即使用户没开「启用评论区隐藏」，
 * 只要 AICG 类别不是禁用，也应该扫描评论。总开关仍然必须打开。
 */
export function shouldProcessComments(): boolean {
    if (!Config.config?.dynamicAndCommentSponsorBlocker) return false;
    return Boolean(Config.config.commentSponsorBlock) || isAicgEnabled();
}
