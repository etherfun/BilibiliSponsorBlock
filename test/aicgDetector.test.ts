/**
 * 疑似 AICG 检测器与决策层的单元测试。
 *
 * 样本来自公开 B 站评论区的真实语料（含 2026-10「鱼灾」期间的评论区），
 * 覆盖：批量模板、跨作者改写、人工规范长评、极短评论、网络口语、复制粘贴。
 */

import { DynamicSponsorOption } from "../src/types";
import { createAicgContext, detectComments, HeuristicAicgDetector } from "../src/content/aicg/detector";
import { decideAicgOption, resolveAicgTuning, summarizeFeatures } from "../src/content/aicg/decision";
import {
    coefficientOfVariation,
    codePointLength,
    jaccard,
    normalizeCommentText,
    punctuationProfile,
    splitSentences,
    startsWithMention,
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

/**
 * 改写型样本：外框措辞各不相同，但都复制了同一段「事实包」。
 * 这正是真实语料里的形态（原评论区里那段隔离/原子锁的说法被大量照抄），
 * 也是 8 字短语复用特征存在的意义。
 */
const AI_PARAPHRASE_SAMPLE = [
    "@某甲 别纠结了，新版跟源仓库彻底隔离、写操作全原子锁，两个进程并行也不踩。",
    "@某乙 值得看一眼：新版跟源仓库彻底隔离、写操作全原子锁，并排跑两个也稳。",
    "@某丙 我试过了。新版跟源仓库彻底隔离、写操作全原子锁，双开不会冲突。",
    "@某丁 提醒一下啊，新版跟源仓库彻底隔离、写操作全原子锁，两个一起跑没事。",
    "@某戊 结论很清楚：新版跟源仓库彻底隔离、写操作全原子锁，并行也不撞车。",
];

const HUMAN_SAMPLES = [
    "哪里搞笑了[doge_金箍][doge_金箍]",
    "这说明大家没有认真的去看插件教程 可能如果再更新版本的话，应该在明显位置告诉用户怎么用。不能只从开发者的角度去看 因为作为开发者，我第一次看到艾特主人的时候，我就已经想到应该要这么干了",
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

    test("startsWithMention detects reply framing", () => {
        expect(startsWithMention("@某人 内容")).toBe(true);
        expect(startsWithMention("回复 @某人 :内容")).toBe(true);
        expect(startsWithMention("没有前缀")).toBe(false);
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
        expect(jaccard(a, b)).toBeCloseTo(0.5, 5);
        expect(jaccard(a, new Set())).toBe(0);
    });

    test("punctuationProfile reports kinds and entropy", () => {
        const profile = punctuationProfile("一句，两句。三句、四句；");
        expect(profile.total).toBeGreaterThan(0);
        expect(profile.kinds).toBeGreaterThanOrEqual(3);
    });
});

describe("HeuristicAicgDetector", () => {
    test("flags a batch of near-identical template comments", () => {
        const results = detectComments(AI_FLOOD_SAMPLE);
        for (const result of results) {
            expect(result.confidence).toBeGreaterThanOrEqual(0.5);
            expect(result.features.map((f) => f.id)).toContain("templateReuse");
        }
    });

    test("does not flag a lone template-like comment without peer evidence", () => {
        const [result] = detectComments([AI_FLOOD_SAMPLE[0]]);
        expect(result.confidence).toBeLessThan(0.5);
    });

    test("keeps human comments below the default threshold", () => {
        const results = detectComments([...HUMAN_SAMPLES, ...AI_FLOOD_SAMPLE]);
        for (const result of results.slice(0, HUMAN_SAMPLES.length)) {
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

    test("catches paraphrased AI comments through cross-author phrase reuse", () => {
        // 每条评论的作者都不同 —— 这是「一批账号共用同一套话术」的形态。
        const authors = AI_PARAPHRASE_SAMPLE.map((_, index) => `author-${index}`);
        const results = detectComments(AI_PARAPHRASE_SAMPLE, { authors });
        const caught = results.filter((result) => result.confidence >= 0.55);
        expect(caught.length).toBeGreaterThanOrEqual(Math.ceil(AI_PARAPHRASE_SAMPLE.length * 0.6));
        // 长片段复用必须被识别为证据
        expect(results[0].features.map((f) => f.id)).toContain("sharedPhraseCoverage");
    });

    test("cross-author phrase statistics ignore a single author posting the same text", () => {
        const authors = AI_PARAPHRASE_SAMPLE.map(() => "same-author");
        const context = createAicgContext(AI_PARAPHRASE_SAMPLE, authors);
        expect(context.sharedPhrases.size).toBe(0);
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

    test("ignores the repeated @mention prefix when judging shortness", () => {
        const [result] = detectComments(["回复 @闲人JOJO :[笑哭]"]);
        expect(result.tooShort).toBe(true);
        expect(result.confidence).toBe(0);
    });

    test("empty text produces no evidence", () => {
        const result = new HeuristicAicgDetector().detect({ text: "" });
        expect(result.confidence).toBe(0);
        expect(result.textLength).toBe(0);
        expect(result.tooShort).toBe(true);
    });

    test("persona self-reference alone is weak evidence", () => {
        const result = new HeuristicAicgDetector().detect({
            text: "@主人 本鲸今天也在认真刷视频，学到了很多东西，谢谢主人给我这个机会。",
        });
        expect(result.confidence).toBeLessThan(0.6);
        expect(result.features.map((f) => f.id)).not.toContain("personaSelfReference");
    });

    test("createAicgContext builds shared statistics", () => {
        const context = createAicgContext(AI_FLOOD_SAMPLE);
        expect(context.bigramDf.size).toBeGreaterThan(0);
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

    test("provides stable feature ids for debugging", () => {
        const results = detectComments(AI_FLOOD_SAMPLE);
        const ids = results[0].features.map((f) => f.id);
        expect(ids.length).toBeGreaterThan(0);
        for (const id of ids) expect(typeof id).toBe("string");
    });
});

describe("decideAicgOption", () => {
    const tuning = resolveAicgTuning({ threshold: 0.55, minLength: 12, debug: false });

    test("disabled category never acts", () => {
        expect(decideAicgOption(
            { confidence: 1, features: [], tooShort: false },
            DynamicSponsorOption.Disabled,
            tuning,
        ).option).toBe(DynamicSponsorOption.Disabled);
    });

    test("below-threshold comments are left alone", () => {
        expect(decideAicgOption(
            { confidence: 0.4, features: [], tooShort: false },
            DynamicSponsorOption.Hide,
            tuning,
        ).option).toBe(DynamicSponsorOption.Disabled);
    });

    test("too-short comments are never acted on", () => {
        expect(decideAicgOption(
            { confidence: 1, features: [], tooShort: true },
            DynamicSponsorOption.HideCard,
            tuning,
        ).option).toBe(DynamicSponsorOption.Disabled);
    });

    test("maps each option straight through", () => {
        const result = { confidence: 0.9, features: [], tooShort: false };
        expect(decideAicgOption(result, DynamicSponsorOption.ShowOverlay, tuning).option).toBe(DynamicSponsorOption.ShowOverlay);
        expect(decideAicgOption(result, DynamicSponsorOption.Hide, tuning).option).toBe(DynamicSponsorOption.Hide);
        expect(decideAicgOption(result, DynamicSponsorOption.HideCard, tuning).option).toBe(DynamicSponsorOption.HideCard);
    });

    test("resolveAicgTuning supplies defaults and clamps invalid values", () => {
        expect(resolveAicgTuning(undefined)).toEqual({ threshold: 0.55, minLength: 12, debug: false });
        expect(resolveAicgTuning({ threshold: 5, minLength: -3 })).toEqual({ threshold: 0.55, minLength: 12, debug: false });
        expect(resolveAicgTuning({ threshold: 0.3, minLength: 20, debug: true })).toEqual({ threshold: 0.3, minLength: 20, debug: true });
    });

    test("summarizeFeatures returns feature ids for i18n mapping", () => {
        const ids = summarizeFeatures([
            { id: "templateReuse", strength: 0.9, reason: "templateReuse:0.90" },
            { id: "duplicateFamily", strength: 0.5, reason: "duplicateFamily:0.50" },
        ]);
        expect(ids).toEqual(["templateReuse", "duplicateFamily"]);
    });
});
