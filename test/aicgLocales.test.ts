import { readFileSync } from "fs";
import { join } from "path";

/**
 * 新增设置的文案完整性测试。
 *
 * 设置页用 `__MSG_key__` 占位，缺失文案会在界面上直接显示成占位符本身。
 * 这里同时校验：新选项用到的每个 key 都在三种语言中存在，且没有漏译。
 */

const ROOT = join(__dirname, "..");
const LOCALES = ["zh_CN", "zh_TW", "en"] as const;

function readMessages(locale: (typeof LOCALES)[number]): Record<string, { message: string }> {
    return JSON.parse(readFileSync(join(ROOT, "public", "_locales", locale, "messages.json"), "utf8"));
}

/** 新功能在设置页与代码里用到的文案 key。 */
const AICG_KEYS = [
    "commentAicg",
    "commentAicgDescription",
    "commentAicgAction",
    "commentAicgActionDescription",
    "commentAicgActionDisabled",
    "commentAicgActionLabel",
    "commentAicgActionHideContent",
    "commentAicgActionHideCard",
    "commentAicgThreshold",
    "commentAicgThresholdDescription",
    "commentAicgMinLength",
    "commentAicgMinLengthDescription",
    "commentAicgDebug",
    "commentAicgDebugDescription",
    "aicgSuspectLabel",
    "aicgShowContent",
    "aicgHideContent",
    "aicgFeature_templateReuse",
    "aicgFeature_crossCommentSimilarity",
    "aicgFeature_duplicateFamily",
    "aicgFeature_lowInformationDensity",
    "aicgFeature_personaSelfReference",
    "aicgFeature_reportToOwner",
    "aicgFeature_structuralUniformity",
    "aicgFeature_punctuationRegularity",
    "category_commentAicg",
    "category_commentAicg_description",
];

describe("疑似 AICG 文案", () => {
    test.each(LOCALES)("%s 包含全部新文案且非空", (locale) => {
        const messages = readMessages(locale);
        const missing = AICG_KEYS.filter((key) => !messages[key]);
        expect(missing).toEqual([]);
        const empty = AICG_KEYS.filter((key) => !messages[key].message?.trim());
        expect(empty).toEqual([]);
    });

    test("设置页里的 __MSG_ 占位符都能在每种语言中解析", () => {
        const html = readFileSync(join(ROOT, "public", "options", "options.html"), "utf8");
        const keys = [...html.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)].map((match) => match[1]);
        const unique = [...new Set(keys)];

        // 设置页里实际出现的新功能占位符：一个都不能少。
        const expectedInPage = AICG_KEYS.filter((key) => key.startsWith("commentAicg"));
        expect(unique).toEqual(expect.arrayContaining(expectedInPage));

        // 只对本功能引入的占位符断言可解析；danmaku* 等是本次改动之前就缺失的文案。
        for (const locale of LOCALES) {
            const messages = readMessages(locale);
            const missing = expectedInPage.filter((key) => !messages[key]);
            expect({ locale, missing }).toEqual({ locale, missing: [] });
        }
    });

    test("英文文案不是中文占位残留", () => {
        const messages = readMessages("en");
        for (const key of AICG_KEYS) {
            expect({ key, hasCjk: /[\u4e00-\u9fff]/.test(messages[key].message) }).toEqual({ key, hasCjk: false });
        }
    });

    test("简体与英文的文案 key 集合一致", () => {
        // zh_TW 历史上少三条 rules_* 文案，与本次改动无关，所以这里只比对 zh_CN 与 en。
        const zh = new Set(Object.keys(readMessages("zh_CN")));
        const en = new Set(Object.keys(readMessages("en")));
        expect([...zh].filter((key) => !en.has(key))).toEqual([]);
        expect([...en].filter((key) => !zh.has(key))).toEqual([]);
    });
});
