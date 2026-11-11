/** @jest-environment jsdom */
/**
 * 疑似 AICG 设置的持久化与兼容性测试。
 *
 * 重点验证：
 * 1. 升级后默认是「禁用」，不改变任何用户现有行为；
 * 2. 设置写入后能读回（等价于刷新页面后仍然有效）；
 * 3. 导入的非法值被纠正为默认值，不会让设置页或检测逻辑崩掉。
 */

jest.mock("../src/utils/", () => ({
    isFirefox: () => false,
    waitFor: jest.fn(),
}));

const STORAGE_KEY_PREFIX = "commentAicg";

type StoredSync = Record<string, unknown>;
function installChromeMock(initial: StoredSync = {}) {
    const sync: StoredSync = JSON.parse(JSON.stringify(initial));
    const local: StoredSync = {};
    let onChanged: ((changes: Record<string, { newValue?: unknown; oldValue?: unknown }>, area: string) => void) | null = null;

    (global as unknown as { chrome: unknown }).chrome = {
        runtime: {},
        i18n: { getMessage: (key: string) => key },
        storage: {
            onChanged: { addListener: (listener: typeof onChanged) => { onChanged = listener; } },
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

describe("commentAicg 默认值", () => {
    test("默认禁用，升级后不改变用户现有体验", async () => {
        const { Config } = await loadConfig();
        expect(Config.config.commentAicgAction).toBe(0);
        expect(Config.config.commentAicgThreshold).toBe(0.55);
        expect(Config.config.commentAicgMinLength).toBe(12);
        expect(Config.config.commentAicgDebug).toBe(false);
    });

    test("已存在其他配置时，新键补齐为默认值且不影响旧键", async () => {
        const { Config } = await loadConfig({
            dynamicAndCommentSponsorBlocker: true,
            commentSponsorBlock: true,
            commentSponsorReplyBlock: true,
        });
        expect(Config.config.dynamicAndCommentSponsorBlocker).toBe(true);
        expect(Config.config.commentSponsorBlock).toBe(true);
        expect(Config.config.commentSponsorReplyBlock).toBe(true);
        expect(Config.config.commentAicgAction).toBe(0);
    });
});

/** 配置写入是 20ms 批量合并的，测试里等它落盘。 */
function flushWrites(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 80));
}

// 让每个用例的批量写在本用例内落盘，避免遗留定时器写进下一个用例的存储假实现。
afterEach(flushWrites);

describe("commentAicg 持久化", () => {
    test("写入后能读回，等价于刷新页面后配置仍然有效", async () => {
        const { Config, sync } = await loadConfig();
        Config.config.commentAicgAction = 2;
        Config.config.commentAicgThreshold = 0.7;
        Config.config.commentAicgMinLength = 20;
        Config.config.commentAicgDebug = true;
        await flushWrites();

        // 存储层已经落下
        expect(sync.commentAicgAction).toBe(2);
        expect(sync.commentAicgThreshold).toBe(0.7);
        expect(sync.commentAicgMinLength).toBe(20);
        expect(sync.commentAicgDebug).toBe(true);

        // 用同一份存储重新加载，模拟刷新页面
        const reloaded = await loadConfig(JSON.parse(JSON.stringify(sync)));
        expect(reloaded.Config.config.commentAicgAction).toBe(2);
        expect(reloaded.Config.config.commentAicgThreshold).toBe(0.7);
        expect(reloaded.Config.config.commentAicgMinLength).toBe(20);
        expect(reloaded.Config.config.commentAicgDebug).toBe(true);
    });

    test("修改设置后立即生效（内存值与存储值同步）", async () => {
        const { Config, sync } = await loadConfig();
        expect(Config.config.commentAicgAction).toBe(0);
        Config.config.commentAicgAction = 1;
        // 内存里立刻可见，检测逻辑下一次扫描就会用新值
        expect(Config.config.commentAicgAction).toBe(1);
        await flushWrites();
        expect(sync.commentAicgAction).toBe(1);
    });
});

describe("commentAicg 兼容性", () => {
    test("导入的非法枚举值回落到禁用", async () => {
        const { Config } = await loadConfig({ commentAicgAction: 99 });
        expect(Config.config.commentAicgAction).toBe(0);
    });

    test("字符串形式的模式值（旧导入文件常见）回落到禁用", async () => {
        const { Config } = await loadConfig({ commentAicgAction: "2" });
        expect(Config.config.commentAicgAction).toBe(0);
    });

    test("越界阈值与负长度回落到默认值", async () => {
        const { Config } = await loadConfig({
            commentAicgThreshold: 5,
            commentAicgMinLength: -3,
        });
        expect(Config.config.commentAicgThreshold).toBe(0.55);
        expect(Config.config.commentAicgMinLength).toBe(12);
    });

    test("合法值被保留，不被迁移逻辑覆盖", async () => {
        const { Config } = await loadConfig({
            commentAicgAction: 3,
            commentAicgThreshold: 0.35,
            commentAicgMinLength: 5,
        });
        expect(Config.config.commentAicgAction).toBe(3);
        expect(Config.config.commentAicgThreshold).toBe(0.35);
        expect(Config.config.commentAicgMinLength).toBe(5);
    });
});
