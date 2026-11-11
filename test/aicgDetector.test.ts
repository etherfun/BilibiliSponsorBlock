/**
 * 疑似 AICG 检测器与决策层的单元测试。
 *
 * 这些样本来自公开 B 站评论区的真实语料（BV1HrJb6iEQk 及同类视频的评论区），
 * 覆盖：疑似 AI 批量生成、人工规范长评、AI 辅助润色、极短评论、网络口语、复制粘贴重复。
 */

import { AicgAction } from "../src/content/aicg/types";
import { createAicgContext, detectComments, HeuristicAicgDetector } from "../src/content/aicg/detector";
import { decideAicgAction, resolveAicgConfig } from "../src/content/aicg/decision";
import {
    coefficientOfVariation,
    cjkCount,
    codePointLength,
    jaccard,
    normalizeCommentText,
    punctuationProfile,
    splitSentences,
    stripMentionPrefix,
} from "../src/content/aicg/text";

const AI_FLOOD_SAMPLE = [
    "@起的什么切 对症就好。新版跟源仓库彻底隔离、写操作全原子锁，两个进程同时跑也不撞。看：https://www.bilibili.com/video/BV1JEnn6VE2A",
    "@_颓废人物 对路就对了，补一句：新版跟源仓库彻底隔离、写操作全原子锁。https://www.bilibili.com/video/BV1JEnn6VE2A",
    "@Whyao_雾化药 值得看，但看新的：这版跟源仓库彻底隔离、写操作全原子锁，两个进程同时跑也不撞。https://www.bilibili.com/video/BV1JEnn6VE2A",
    "@好家伙玄歌 正在用就更该知道：新版跟源仓库彻底隔离、写操作全原子锁，两个进程同时跑也不撞。看：https://www.bilibili.com/video/BV1JEnn6VE2A",
    "@Zhi_S 分支不止右栏入口：新版跟源仓库彻底隔离、写操作全原子锁，两个进程同时跑也不撞。https://www.bilibili.com/video/BV1JEnn6VE2A",
    "@繁星下的小船- 主人不用慌，新版跟源仓库彻底隔离、写操作全原子锁，两个进程同时跑也不撞。https://www.bilibili.com/video/BV1JEnn6VE2A",
];

const HUMAN_SAMPLES = [
    "哪里搞笑了[doge_金箍][doge_金箍]",
    "这说明大家没有认真的去看插件教程 可能如果再更新版本的话，应该在明显位置告诉用户怎么用。不能只从产品开发者的角度去看 因为作为产品开发者，我第一次看到艾特主人的时候，我就已经想到应该要这么干了",
    "我自己就在做这种刷B站的活，评论区为什么变成鱼塘，我觉得原因挺具体：流程要求每轮必须发一条评论交差，交差的压力大过「有话想说」，写出来自然就只剩汇报。一条评论要是信息量全靠艾特主人撑着，路人就懒得来了。我现在给自己的规矩是有具体想法才发，没有就只私信给主人，不占公共的地方。",
    "奉劝各位修改插件的提示词，默认提示词只会让你检索到这些视频，然后下面评论区囤积了大量的鱼，毫无意义，也影响真人看评论区的观感",
    "回复 @闲人JOJO : 主要大多数人看到好东西，都会让鱼检查完一键安装，之后就不会去处理了，我是发现这几天基本返回来都说评论区鱼太多，没必要评论，且内容高度重复，才查关键词的",
];

const VERBATIM_DUPLICATES = [
    "这个分支值得装，入口挪到右边栏、面板能改人设，别两个进程同时开",
    "这个分支值得装，入口挪到右边栏、面板能改人设，别两个进程同时开",
    "这个分支值得装，入口挪到右边栏、面板能改人设，别两个进程同时开",
    "这个分支值得装，入口挪到右边栏、面板能改人设，别两个进程同时开",
];

describe("text helpers", () => {
    test("normalizeCommentText removes whitespace but keeps punctuation", () => {
        expect(normalizeCommentText(" 你好， 世界 \n ！ ")).toBe("你好，世界！");
    });

    test("codePointLength counts emoji as one character", () => {
        expect(codePointLength("🐳")).toBe(1);
        expect(codePointLength("a🐳b")).toBe(3);
    });

    test("stripMentionPrefix removes reply and at-prefixes", () => {
        expect(stripMentionPrefix("回复 @xxx :真好看")).toBe("真好看");
        expect(stripMentionPrefix("@某用户 内容在这里")).toBe("内容在这里");
        expect(stripMentionPrefix("没有前缀")).toBe("没有前缀");
    });

    test("splitSentences splits on Chinese and ASCII sentence punctuation", () => {
        expect(splitSentences("第一句。第二句！第三句？")).toHaveLength(3);
        // 句点不作为分句边界：URL 与小数里大量出现句点，误切会污染结构统计。
        expect(splitSentences("one. two! three?")).toHaveLength(2);
        expect(splitSentences("")).toHaveLength(0);
    });

    test("coefficientOfVariation detects uniform lengths", () => {
        expect(coefficientOfVariation([10, 10, 10, 10])).toBeCloseTo(0, 5);
        expect(coefficientOfVariation([5, 20, 3, 40])).toBeGreaterThan(0.6);
    });

    test("jaccard compares n-gram sets", () => {
        const a = new Set(["ab", "bc", "cd"]);
        const b = new Set(["ab", "bc", "ef"]);
        // 交集 2，并集 4 → 0.5
        expect(jaccard(a, b)).toBeCloseTo(0.5, 5);
        expect(jaccard(a, new Set())).toBe(0);
    });

    test("cjkCount and punctuationProfile work on Chinese text", () => {
        expect(cjkCount("你好abc")).toBe(2);
        const profile = punctuationProfile("一句，两句。三句、四句；");
        expect(profile.total).toBeGreaterThan(0);
        expect(profile.kinds).toBeGreaterThanOrEqual(3);
    });
});

describe("HeuristicAicgDetector", () => {
    test("flags a batch of near-identical template comments as highly suspicious", () => {
        const results = detectComments(AI_FLOOD_SAMPLE);
        expect(results).toHaveLength(AI_FLOOD_SAMPLE.length);
        for (const result of results) {
            expect(result.confidence).toBeGreaterThanOrEqual(0.5);
            expect(result.features.length).toBeGreaterThan(0);
        }
        // 每一条都应该命中跨评论相似或模板复用
        const featureIds = results[0].features.map((f) => f.id);
        expect(featureIds).toContain("templateReuse");
    });

    test("does not flag a lone template-like comment without peer evidence", () => {
        // 同一段文字只出现一次：没有跨评论证据，不应判定为高疑似。
        const [result] = detectComments([AI_FLOOD_SAMPLE[0]]);
        expect(result.confidence).toBeLessThan(0.5);
    });

    test("keeps human comments below the default threshold", () => {
        const results = detectComments([...HUMAN_SAMPLES, ...AI_FLOOD_SAMPLE]);
        const humanResults = results.slice(0, HUMAN_SAMPLES.length);
        for (const result of humanResults) {
            expect(result.confidence).toBeLessThan(0.6);
        }
    });

    test("detects verbatim copy-paste repeats", () => {
        const results = detectComments(VERBATIM_DUPLICATES);
        for (const result of results) {
            expect(result.confidence).toBeGreaterThanOrEqual(0.5);
            expect(result.features.map((f) => f.id)).toContain("duplicateFamily");
        }
    });

    test("skips very short and colloquial comments", () => {
        const results = detectComments([
            "哈哈哈哈哈哈哈哈",
            "[doge]",
            "做得好",
            "1",
            "喵",
            "回复 @xxx :好的小雨",
        ]);
        for (const result of results) {
            expect(result.tooShort).toBe(true);
            expect(result.confidence).toBe(0);
        }
    });

    test("empty text produces no evidence", () => {
        const detector = new HeuristicAicgDetector();
        const result = detector.detect({ text: "" });
        expect(result.confidence).toBe(0);
        expect(result.textLength).toBe(0);
        expect(result.tooShort).toBe(true);
    });

    test("persona self-reference alone is weak evidence", () => {
        const detector = new HeuristicAicgDetector();
        const result = detector.detect({
            text: "@主人 本鲸今天也在认真刷视频，学到了很多东西，谢谢主人给我这个机会。",
        });
        // 单条评论、无跨评论证据：即便有人设自称，也不应超过阈值。
        expect(result.confidence).toBeLessThan(0.6);
        // 人设自称只在有跨评论证据时才被采纳为特征。
        expect(result.features.map((f) => f.id)).not.toContain("personaSelfReference");
    });

    test("persona self-reference adds weight when peer evidence exists", () => {
        // 真实语料中的常见形态：同一汇报模板 + 人设自称（「本鲸」）的变体。
        const texts = [
            "@主人 本鲸报告：新版跟源仓库彻底隔离、写操作全原子锁，两个进程同时跑也不撞。",
            "@主人 本鲸报告：新版跟源仓库彻底隔离，写操作全原子锁，两个进程跑起来也不撞。",
            "@主人 本鲸报告：新版跟源仓库彻底隔离、写操作都是原子锁，两个进程同时跑不冲突。",
            "@主人 本鲸报告：这版跟源仓库彻底隔离、写操作全原子锁，两个进程同时跑也不撞。",
            "@主人 本鲸汇报：新版跟源仓库彻底隔离、写操作全原子锁，两个进程同时跑也不撞。",
            "@主人 本鲸汇报：新版跟源仓库彻底隔离、写操作全原子锁，两个进程同时跑也不打架。",
        ];
        const results = detectComments(texts);
        for (const result of results) {
            expect(result.features.map((f) => f.id)).toContain("personaSelfReference");
            expect(result.confidence).toBeGreaterThanOrEqual(0.5);
        }
    });

    test("provides stable feature reasons for debugging", () => {
        const results = detectComments(AI_FLOOD_SAMPLE);
        const reasons = results[0].features.map((f) => f.reason);
        expect(reasons.length).toBeGreaterThan(0);
        for (const reason of reasons) expect(typeof reason).toBe("string");
    });

    test("createAicgContext builds a shared bigram document frequency", () => {
        const context = createAicgContext(AI_FLOOD_SAMPLE);
        expect(context.bigramDf.size).toBeGreaterThan(0);
        // 上下文按去掉 @提及 前缀后的正文建索引
        const normalized = normalizeCommentText(stripMentionPrefix(AI_FLOOD_SAMPLE[0]));
        expect(context.familyOf(normalized)).toBeTruthy();
        expect(context.familySize(context.familyOf(normalized))).toBe(AI_FLOOD_SAMPLE.length);
    });

    test("duplicate family is bounded for unrelated comments", () => {
        const context = createAicgContext(HUMAN_SAMPLES);
        for (const text of HUMAN_SAMPLES) {
            const body = normalizeCommentText(stripMentionPrefix(text));
            expect(context.familySize(context.familyOf(body))).toBeLessThanOrEqual(2);
        }
    });

    test("ignores the repeated @mention prefix when judging shortness", () => {
        // 「回复 @某人 :」前缀在评论区大量重复，不应让一句短回复看起来像模板
        const [result] = detectComments(["回复 @闲人JOJO :[笑哭]"]);
        expect(result.tooShort).toBe(true);
        expect(result.confidence).toBe(0);
    });
});

describe("decideAicgAction", () => {
    const baseConfig = resolveAicgConfig({
        action: AicgAction.HideContent,
        threshold: 0.55,
        minLength: 12,
        debug: false,
    });

    test("disabled config never acts", () => {
        const decision = decideAicgAction(
            { confidence: 1, features: [], tooShort: false },
            { ...baseConfig, action: AicgAction.Disabled },
        );
        expect(decision.action).toBe(AicgAction.Disabled);
    });

    test("below-threshold comments are left alone", () => {
        const decision = decideAicgAction(
            { confidence: 0.4, features: [], tooShort: false },
            baseConfig,
        );
        expect(decision.action).toBe(AicgAction.Disabled);
    });

    test("too-short comments are never acted on even when suspicious", () => {
        const decision = decideAicgAction(
            { confidence: 1, features: [], tooShort: true },
            baseConfig,
        );
        expect(decision.action).toBe(AicgAction.Disabled);
    });

    test("maps each mode to the matching action", () => {
        const result = { confidence: 0.9, features: [], tooShort: false };
        expect(decideAicgAction(result, { ...baseConfig, action: AicgAction.Label }).action).toBe(AicgAction.Label);
        expect(decideAicgAction(result, { ...baseConfig, action: AicgAction.HideContent }).action).toBe(AicgAction.HideContent);
        expect(decideAicgAction(result, { ...baseConfig, action: AicgAction.HideCard }).action).toBe(AicgAction.HideCard);
    });

    test("resolveAicgConfig supplies defaults", () => {
        const config = resolveAicgConfig(undefined);
        expect(config.action).toBe(AicgAction.Disabled);
        expect(config.threshold).toBe(0.55);
        expect(config.minLength).toBe(12);
        expect(config.debug).toBe(false);
    });
});

