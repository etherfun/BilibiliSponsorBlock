/** @jest-environment jsdom */
/**
 * 「疑似 AICG 内容」设置项的持久化与兼容性测试。
 *
 * 处理方式已经并入 `dynamicSponsorSelections` 的 `dynamicSponsor_aicg` 条目，
 * 所以这里验证三件事：
 * 1. 默认禁用，升级后不改变现有行为；
 * 2. 类别选项与微调参数都能写入并读回（等价于刷新页面后仍然有效）；
 * 3. 旧的独立设置 `commentAicgAction` 会被迁移进类别表，非法值回落到禁用。
 */

jest.mock("../src/utils/", () => ({
    isFirefox: () => false,
    waitFor: jest.fn(),
}));

type StoredSync = Record<string, unknown>;

function installChromeMock(initial: StoredSync = {}) {
    const sync: StoredSync = JSON.parse(JSON.stringify(initial));
    const local: StoredSync = {};

    (global as unknown as { chrome: unknown }).chrome = {
        runtime: {},
        i18n: { getMessage: (key: string) => key },
        storage: {
            onChanged: { addListener: () => undefined },
            sync: {
                get: (_keys: unknown, done: (items: StoredSync) => void) => done(JSON.parse(JSON.stringify(sync))),
                set: (values: StoredSync, done?: () => void) => {
                    Object.assign(sync, JSON.parse(JSON.stringify(values)));
                    done?.();
                    return Promise.resolve();
                },
                remove: (key: string, done?: () => void) => { delete sync[key]; done?.(); },
            },
            local: {
                get: (_keys: unknown, done: (items: StoredSync) => void) => done(JSON.parse(JSON.stringify(local))),
                set: (values: StoredSync, done?: () => void) => { Object.assign(local, values); done?.(); },
                remove: (key: string, done?: () => void) => { delete local[key]; done?.(); },
            },
        },
    };

    return { sync, local };
}

async function loadConfig(initial: StoredSync = {}) {
    jest.resetModules();
    const { sync } = installChromeMock(initial);
    const { default: Config } = await import("../src/config");
    await Config.ready;
    return { Config, sync };
}

/** 配置写入是 20ms 批量合并的，测试里等它落盘。 */
function flushWrites(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 80));
}

// 让每个用例的批量写在本用例内落盘，避免遗留定时器写进下一个用例的存储假实现。
afterEach(flushWrites);

function aicgEntry(Config: Awaited<ReturnType<typeof loadConfig>>["Config"]) {
    return Config.config.dynamicSponsorSelections.find((entry) => entry.name === "dynamicSponsor_aicg");
}

describe("疑似 AICG 默认值", () => {
    test("默认禁用，升级后不改变用户现有体验", async () => {
        const { Config } = await loadConfig();
        expect(aicgEntry(Config)?.option).toBe(0);
        expect(Config.config.commentAicgThreshold).toBe(0.55);
        expect(Config.config.commentAicgMinLength).toBe(12);
        expect(Config.config.commentAicgDebug).toBe(false);
    });

    test("类别表里同时保留原有的三个商品链接类别", async () => {
        const { Config } = await loadConfig();
        const names = Config.config.dynamicSponsorSelections.map((entry) => entry.name);
        expect(names).toEqual(expect.arrayContaining([
            "dynamicSponsor_sponsor",
            "dynamicSponsor_forward_sponsor",
            "dynamicSponsor_suspicion_sponsor",
            "dynamicSponsor_aicg",
        ]));
    });

    test("已存在其他配置时，新类别补齐为默认值且不影响旧键", async () => {
        const { Config } = await loadConfig({
            dynamicAndCommentSponsorBlocker: true,
            commentSponsorBlock: true,
            commentSponsorReplyBlock: true,
        });
        expect(Config.config.dynamicAndCommentSponsorBlocker).toBe(true);
        expect(Config.config.commentSponsorBlock).toBe(true);
        expect(Config.config.commentSponsorReplyBlock).toBe(true);
        expect(aicgEntry(Config)?.option).toBe(0);
    });
});

describe("疑似 AICG 持久化", () => {
    test("类别选项与微调参数写入后能读回", async () => {
        const { Config, sync } = await loadConfig();
        Config.config.dynamicSponsorSelections = Config.config.dynamicSponsorSelections.map((entry) =>
            entry.name === "dynamicSponsor_aicg" ? { ...entry, option: 3 } : entry
        );
        Config.forceSyncUpdate("dynamicSponsorSelections");
        Config.config.commentAicgThreshold = 0.7;
        Config.config.commentAicgMinLength = 20;
        Config.config.commentAicgDebug = true;
        await flushWrites();

        const reloaded = await loadConfig(JSON.parse(JSON.stringify(sync)));
        expect(aicgEntry(reloaded.Config)?.option).toBe(3);
        expect(reloaded.Config.config.commentAicgThreshold).toBe(0.7);
        expect(reloaded.Config.config.commentAicgMinLength).toBe(20);
        expect(reloaded.Config.config.commentAicgDebug).toBe(true);
    });

    test("设置页 number 输入写回的字符串会被规范化为数字", async () => {
        const { Config, sync } = await loadConfig();
        // options 页的 number-change 处理器直接写 input.value（字符串）
        Config.config.commentAicgThreshold = "0.65" as unknown as number;
        Config.config.commentAicgMinLength = "18" as unknown as number;
        await flushWrites();

        expect(Config.config.commentAicgThreshold).toBe(0.65);
        expect(Config.config.commentAicgMinLength).toBe(18);
        expect(sync.commentAicgThreshold).toBe(0.65);
        expect(sync.commentAicgMinLength).toBe(18);
    });
});

describe("疑似 AICG 兼容性", () => {
    test("旧的独立设置被迁移进类别表", async () => {
        const { Config } = await loadConfig({ commentAicgAction: 2 });
        expect(aicgEntry(Config)?.option).toBe(2);
    });

    test("迁移后不再保留旧键", async () => {
        const { Config, sync } = await loadConfig({ commentAicgAction: 1 });
        expect((Config.config as unknown as Record<string, unknown>).commentAicgAction).toBeUndefined();
        await flushWrites();
        expect(sync.commentAicgAction).toBeUndefined();
    });

    test("旧键为禁用时不新增类别项", async () => {
        const { Config } = await loadConfig({ commentAicgAction: 0 });
        expect(aicgEntry(Config)?.option).toBe(0);
    });

    test("越界阈值与负长度回落到默认值", async () => {
        const { Config } = await loadConfig({ commentAicgThreshold: 5, commentAicgMinLength: -3 });
        expect(Config.config.commentAicgThreshold).toBe(0.55);
        expect(Config.config.commentAicgMinLength).toBe(12);
    });

    test("类别表里的非法选项回落到禁用", async () => {
        const { Config } = await loadConfig({
            dynamicSponsorSelections: [{ name: "dynamicSponsor_aicg", option: 99 }],
        });
        expect(aicgEntry(Config)?.option).toBe(0);
    });

    test("合法的类别选项被保留", async () => {
        const { Config } = await loadConfig({
            dynamicSponsorSelections: [{ name: "dynamicSponsor_aicg", option: 3 }],
        });
        expect(aicgEntry(Config)?.option).toBe(3);
    });
});
