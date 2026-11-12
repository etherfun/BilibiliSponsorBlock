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

/**
 * 真实场景的关键形态：AI 评论**零散夹杂**在正常评论之间，
 * 每条独立生成、彼此不相似，跨评论统计完全无法成簇。
 * 这时必须靠单条标记特征，否则疑似度恒为 0。
 */
const MIXED_REAL_WORLD = [
    "置顶 【人类幸存者集合楼】（机器人来这层我见一个清一个，活人老哥放心聊）：先说结论，这插件值得装。",
    "upup 为什么你的家目录能改到D盘啊",
    "你这大肥鱼不要看这些了看点别的",
    "回复 @茄子舅舅 :你你你你你是谁家的鱼！？",
    "主人，本鱼记下了（尾巴慢悠悠划了个小圈）：入口挪到右栏确实顺手，回头试用一轮再说。",
    "我上周也遇到过，重装一下插件就好了，不过记得先导出配置。",
    "评论区全是鱼有点难绷",
    "能不能让前台的会话那个全部集中到一个会话里啊 不然 一天一个新会话看着也难受 [笑哭]",
    "（把分支名记进本子）谢了——隔离加原子锁这条比功能更值钱，我回头试用一轮再说。",
    "还不错",
];

describe("零散夹杂的真实场景", () => {
    test("互不相似的评论里，扮演人设的那条仍能被标记", () => {
        const results = detectComments(MIXED_REAL_WORLD);
        // 第 4 条同时有人设自称 + 称呼主人 + 括号动作，三种独立标记
        expect(results[4].confidence).toBeGreaterThanOrEqual(0.55);
        const ids = results[4].features.map((f) => f.id);
        expect(ids).toContain("ownerAddress");
        expect(ids).toContain("personaSelfReference");
        expect(ids).toContain("actionNarration");
        // 真人评论一条都不该被标记
        for (const index of [0, 1, 2, 3, 5, 6, 7, 9]) {
            expect(results[index].confidence).toBeLessThan(0.55);
        }
    });

    test("只有「主人」一个标记时不足以标记", () => {
        // 真人也会对着作者喊「主人」，单独一个称呼不能当证据
        const results = detectComments([
            "主人，这期视频讲得挺清楚的，信息量很大。",
            "主人，这插件在手机上真的用不了，设置页点不动。",
        ]);
        for (const result of results) {
            expect(result.confidence).toBeLessThan(0.55);
        }
    });

    test("「主人」+「汇报式收尾」成对出现即标记（AI 鱼评论的固定句式）", () => {
        const results = detectComments([
            "主人，这期视频讲得挺清楚的，我回头再看一遍。",
        ]);
        expect(results[0].confidence).toBeGreaterThanOrEqual(0.55);
    });

    test("人设自称 + 称呼主人 同时出现即标记（AI 鱼评论的典型形态）", () => {
        // 单独一条、没有任何同伴：跨评论证据为 0，只能靠标记通道
        const [flagged] = detectComments([
            "@主人 本鲸今天也在认真刷视频，学到了很多东西，谢谢主人给我这个机会。",
        ]);
        expect(flagged.confidence).toBeGreaterThanOrEqual(0.55);

        // 只有人设自称：一个标记，不越阈值
        const [personaOnly] = detectComments([
            "本鲸今天也在认真刷视频，学到了很多东西，谢谢给我这个机会。",
        ]);
        expect(personaOnly.confidence).toBeLessThan(0.55);
        expect(personaOnly.features.map((f) => f.id)).toContain("personaSelfReference");
    });

    test("普通推销评论不因单条特征被标记", () => {
        const results = detectComments([
            "这个分支值得装，右栏入口救窄屏，面板能改人设和回复提示词，前台还能看它跑。",
            "刷B站插件的分支版：能选模型、面板直接改人设，入口挪到右边栏对移动端友好。",
            "分支把入口挪到右边栏是对的，设置页窄屏根本没法用。",
        ]);
        for (const result of results) {
            expect(result.confidence).toBeLessThan(0.55);
        }
    });
});

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

    test("用户自定义正则命中即判定（显式教学，不需要其它证据）", () => {
        const [hit] = detectComments(["这版把仓库分开、写盘有锁，挺稳。"], { customPatterns: [/写盘有锁/i] });
        expect(hit.confidence).toBe(1);
        expect(hit.features.map((f) => f.id)).toContain("userPattern");

        const [miss] = detectComments(["今天天气不错，出门走走顺便刷视频。"], { customPatterns: [/彻底隔离/] });
        expect(miss.confidence).toBeLessThan(0.55);
    });

    test("已知短语是标记之一：单独出现不判定，配对即判定", () => {
        const known = new Set(["跟源仓库彻底隔离"]);
        const [solo] = detectComments(["这版跟源仓库彻底隔离了，写盘有锁，稳。"], { knownPhrases: known });
        expect(solo.features.map((f) => f.id)).toContain("knownPhrase");
        expect(solo.confidence).toBeLessThan(0.55);

        const [paired] = detectComments(["主人，这版跟源仓库彻底隔离了，写盘有锁，稳。"], { knownPhrases: known });
        expect(paired.confidence).toBeGreaterThanOrEqual(0.55);
    });

    test("empty text produces no evidence", () => {
        const result = new HeuristicAicgDetector().detect({ text: "" });
        expect(result.confidence).toBe(0);
        expect(result.textLength).toBe(0);
        expect(result.tooShort).toBe(true);
    });

    test("only persona self-reference is weak evidence", () => {
        // 只有人设自称、没有其它标记：不构成标记通道的命中
        const result = new HeuristicAicgDetector().detect({
            text: "本鲸今天也在认真刷视频，学到了很多东西，谢谢给我这个机会。",
        });
        expect(result.confidence).toBeLessThan(0.55);
        expect(result.features.map((f) => f.id)).toContain("personaSelfReference");
        expect(result.features.map((f) => f.id)).not.toContain("ownerAddress");
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
