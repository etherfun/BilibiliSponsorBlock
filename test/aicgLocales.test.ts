import { readFileSync } from "fs";
import { join } from "path";

/**
 * 「疑似 AICG 内容」相关文案的完整性测试。
 *
 * 这个功能现在完全长在「隐藏 动态主页/评论区 的商品链接」类别表里，
 * 所以除了自己那几条文案，还要保证类别名、选项名、特征名在三种语言里都存在。
 */

const ROOT = join(__dirname, "..");
const LOCALES = ["zh_CN", "zh_TW", "en"] as const;

function readMessages(locale: (typeof LOCALES)[number]): Record<string, { message: string }> {
    return JSON.parse(readFileSync(join(ROOT, "public", "_locales", locale, "messages.json"), "utf8"));
}

/** 类别行、选项、微调项、标签、调试特征用到的文案 key。 */
const AICG_KEYS = [
    // 类别行（React 类别表）
    "category_dynamicSponsor_aicg",
    "category_dynamicSponsor_aicg_description",
    // 选项
    "showOverlay_DynamicSponsor",
    "Hide_DynamicSponsor",
    "HideCard_DynamicSponsor",
    // 挂在该类别行下面的微调项
    "commentAicgThresholdShort",
    "commentAicgMinLengthShort",
    "commentAicgDebug",
    "commentAicgDebugDescription",
    // 评论上的按钮
    "aicgShowContent",
    "aicgHideContent",
    // 调试标签里显示的特征名
    "aicgFeature_templateReuse",
    "aicgFeature_crossCommentSimilarity",
    "aicgFeature_sharedPhraseCoverage",
    "aicgFeature_duplicateFamily",
    "aicgFeature_lowInformationDensity",
    "aicgFeature_aiPhraseDensity",
    "aicgFeature_personaSelfReference",
    "aicgFeature_ownerAddress",
    "aicgFeature_actionNarration",
    "aicgFeature_promoInstruction",
    "aicgFeature_reportClosing",
    "aicgFeature_sameAuthorBurst",
    "aicgFeature_knownPhrase",
    "aicgFeature_userPattern",
    "commentAicgCustomRulesShort",
    "aicgFeature_reportToOwner",
    "aicgFeature_structuralUniformity",
    "aicgFeature_punctuationRegularity",
];

describe("疑似 AICG 文案", () => {
    test.each(LOCALES)("%s 包含全部相关文案且非空", (locale) => {
        const messages = readMessages(locale);
        expect(AICG_KEYS.filter((key) => !messages[key])).toEqual([]);
        expect(AICG_KEYS.filter((key) => !messages[key].message?.trim())).toEqual([]);
    });

    test("本次新增的英文文案不是中文占位残留", () => {
        // showOverlay_DynamicSponsor 等选项名是项目原有的 key，英文文件里本来就是中文，
        // 不属于本次改动，所以只检查这次新增的文案。
        const addedKeys = AICG_KEYS.filter((key) => ![
            "showOverlay_DynamicSponsor",
            "Hide_DynamicSponsor",
        ].includes(key));
        const messages = readMessages("en");
        for (const key of addedKeys) {
            expect({ key, hasCjk: /[\u4e00-\u9fff]/.test(messages[key].message) }).toEqual({ key, hasCjk: false });
        }
    });

    test("简体与英文的文案 key 集合一致", () => {
        // zh_TW 历史上少三条 rules_* 文案，与本次改动无关，所以只比对 zh_CN 与 en。
        const zh = new Set(Object.keys(readMessages("zh_CN")));
        const en = new Set(Object.keys(readMessages("en")));
        expect([...zh].filter((key) => !en.has(key))).toEqual([]);
        expect([...en].filter((key) => !zh.has(key))).toEqual([]);
    });

    test("不再保留已经废弃的独立设置文案", () => {
        // 处理方式已经并入类别表，这些 key 不应再出现在任何语言里。
        const obsolete = [
            "commentAicgAction",
            "commentAicgActionDisabled",
            "commentAicgActionLabel",
            "commentAicgActionHideContent",
            "commentAicgActionHideCard",
            "category_commentAicg",
            "category_commentAicg_description",
        ];
        for (const locale of LOCALES) {
            const messages = readMessages(locale);
            expect({ locale, obsolete: obsolete.filter((key) => messages[key]) }).toEqual({ locale, obsolete: [] });
        }
    });

    test("类别表里每个 dynamicSponsor 类别都有名称与说明文案", () => {
        const messages = readMessages("zh_CN");
        for (const category of [
            "dynamicSponsor_sponsor",
            "dynamicSponsor_forward_sponsor",
            "dynamicSponsor_suspicion_sponsor",
            "dynamicSponsor_aicg",
        ]) {
            expect(messages[`category_${category}`]).toBeDefined();
            expect(messages[`category_${category}_description`]).toBeDefined();
        }
    });
});
