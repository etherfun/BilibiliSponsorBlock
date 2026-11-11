import { expect, test } from "./fixtures/extension";
import type { Page, Worker } from "@playwright/test";
import fs from "fs";
import path from "path";
import { readSyncStorage, writeSyncStorage } from "./support/extensionStorage";

/**
 * 「疑似 AICG 内容」设置的界面与持久化验证。
 *
 * 它现在是「隐藏 动态主页/评论区 的商品链接」类别表里的一行，
 * 处理方式和商品链接类别共用同一个下拉框，微调项挂在它自己那一行下面
 * （和「音乐:非音乐部分」挂着 autoSkipOnMusicVideos 的做法一致）。
 */

const ARTIFACT_DIR = path.resolve(__dirname, "..", "test-results", "aicg-ui");

const AICG_ROW = "#dynamicSponsor_aicgOptionsRow";
// 注意：id 挂在包住下拉框的 <td> 上，所以选择器要再往下取 select。
const AICG_SELECT = "#dynamicSponsor_aicgSkipOption select";

interface Selection { name: string; option: number }

async function readSelections(worker: Worker): Promise<Selection[]> {
    return (await readSyncStorage<Selection[]>(worker, "dynamicSponsorSelections")) ?? [];
}

async function enableCategory(worker: Worker, aicgOption = 0): Promise<void> {
    await writeSyncStorage(worker, {
        dynamicAndCommentSponsorBlocker: true,
        commentSponsorBlock: true,
        dynamicSponsorSelections: [
            { name: "dynamicSponsor_sponsor", option: 2 },
            { name: "dynamicSponsor_forward_sponsor", option: 2 },
            { name: "dynamicSponsor_suspicion_sponsor", option: 0 },
            { name: "dynamicSponsor_aicg", option: aicgOption },
        ],
    });
}

async function openBehaviorOptions(page: Page, extensionId: string): Promise<void> {
    await page.goto(`chrome-extension://${extensionId}/options/options.html#behavior`);
    await expect(page.locator("#options-container")).toBeVisible();
    // 开关本身是被 CSS 收起的 checkbox，这里等它的容器出现。
    await expect(page.locator("[data-sync='dynamicAndCommentSponsorBlocker']")).toBeVisible();
}

test("类别表里多出「疑似 AICG 内容」一行，四个选项齐全且默认禁用", async ({ extensionId, extensionPage: page, extensionServiceWorker }) => {
    await enableCategory(extensionServiceWorker);
    await openBehaviorOptions(page, extensionId);

    await expect(page.locator(AICG_ROW)).toBeVisible();
    const select = page.locator(AICG_SELECT);
    await expect(select).toHaveValue("disable");
    await expect(select.locator("option")).toHaveText(["禁用", "仅添加标签", "隐藏内容", "隐藏卡片"]);

    // 与商品链接类别的下拉框是同一套组件
    await expect(page.locator("#dynamicSponsor_sponsorSkipOption select")).toBeVisible();
});

test("选择处理方式后写入 dynamicSponsorSelections", async ({ extensionId, extensionPage: page, extensionServiceWorker }) => {
    await enableCategory(extensionServiceWorker);
    await openBehaviorOptions(page, extensionId);

    await page.locator(AICG_SELECT).selectOption("Hide_DynamicSponsor");
    await expect.poll(async () => (await readSelections(extensionServiceWorker))
        .find((entry) => entry.name === "dynamicSponsor_aicg")?.option).toBe(2);

    await page.locator(AICG_SELECT).selectOption("HideCard_DynamicSponsor");
    await expect.poll(async () => (await readSelections(extensionServiceWorker))
        .find((entry) => entry.name === "dynamicSponsor_aicg")?.option).toBe(3);

    // 刷新后保持
    await page.reload();
    await expect(page.locator(AICG_SELECT)).toHaveValue("HideCard_DynamicSponsor");

    // 选回禁用
    await page.locator(AICG_SELECT).selectOption("disable");
    await expect.poll(async () => (await readSelections(extensionServiceWorker))
        .find((entry) => entry.name === "dynamicSponsor_aicg")?.option ?? -1).toBe(-1);
});

test("微调项挂在 AICG 那一行下面，可编辑并持久化", async ({ extensionId, extensionPage: page, extensionServiceWorker }) => {
    await enableCategory(extensionServiceWorker, 1);
    await openBehaviorOptions(page, extensionId);

    // 与「音乐:非音乐部分」挂 autoSkipOnMusicVideos 同构：额外的 tr 紧跟在类别行之后
    const thresholdCell = page.locator("#dynamicSponsor_aicg_commentAicgThreshold");
    await expect(thresholdCell).toBeVisible();
    await expect(page.locator("#dynamicSponsor_aicg_commentAicgMinLength")).toBeVisible();

    const threshold = thresholdCell.locator("input");
    await threshold.fill("0.7");
    await expect.poll(() => readSyncStorage<number>(extensionServiceWorker, "commentAicgThreshold")).toBe(0.7);

    await page.locator("#dynamicSponsor_aicg_commentAicgMinLength input").fill("20");
    await expect.poll(() => readSyncStorage<number>(extensionServiceWorker, "commentAicgMinLength")).toBe(20);

    // 开关的 checkbox 被样式收起，点它的 label 才是真实交互路径
    await page.locator("label[for=\x27commentAicgDebug\x27]").click();
    await expect.poll(() => readSyncStorage<boolean>(extensionServiceWorker, "commentAicgDebug")).toBe(true);

    await page.reload();
    await expect(page.locator("#dynamicSponsor_aicg_commentAicgThreshold input")).toHaveValue("0.7");
    await expect(page.locator("#dynamicSponsor_aicg_commentAicgMinLength input")).toHaveValue("20");
});

test("关闭总开关后整个类别被隐藏（既有行为不变）", async ({ extensionId, extensionPage: page, extensionServiceWorker }) => {
    await writeSyncStorage(extensionServiceWorker, { dynamicAndCommentSponsorBlocker: false });
    await openBehaviorOptions(page, extensionId);

    await expect(page.locator("[data-dependent-on='dynamicAndCommentSponsorBlocker']")).toHaveClass(/hidden/);
    // checkbox 本身被开关样式收起，点 label 才是真实用户的交互路径。
    await page.locator("label[for='dynamicAndCommentSponsorBlocker']").click();
    await expect(page.locator("[data-dependent-on='dynamicAndCommentSponsorBlocker']")).not.toHaveClass(/hidden/);
    await expect(page.locator(AICG_SELECT)).toBeVisible();
});

test("旧的独立设置会被迁移到类别表", async ({ extensionId, extensionPage: page, extensionServiceWorker }) => {
    // 模拟已经设置过旧版 commentAicgAction: 2（隐藏内容）
    await writeSyncStorage(extensionServiceWorker, {
        dynamicAndCommentSponsorBlocker: true,
        commentSponsorBlock: true,
        commentAicgAction: 2,
    });
    await openBehaviorOptions(page, extensionId);

    await expect(page.locator(AICG_SELECT)).toHaveValue("Hide_DynamicSponsor");
    await expect.poll(async () => (await readSelections(extensionServiceWorker))
        .find((entry) => entry.name === "dynamicSponsor_aicg")?.option).toBe(2);
    // 旧键应当被清掉
    await expect.poll(() => readSyncStorage<unknown>(extensionServiceWorker, "commentAicgAction")).toBeUndefined();
});

test("截图存档：设置界面", async ({ extensionId, extensionPage: page, extensionServiceWorker }) => {
    await enableCategory(extensionServiceWorker, 1);
    await writeSyncStorage(extensionServiceWorker, { commentAicgDebug: true });
    await openBehaviorOptions(page, extensionId);
    await page.waitForTimeout(500);

    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    const table = page.locator("#DynamicSponsor");
    await expect(table).toBeVisible();
    await table.scrollIntoViewIfNeeded();
    await table.screenshot({ path: path.join(ARTIFACT_DIR, "options-category-table.png") });
    await page.screenshot({ path: path.join(ARTIFACT_DIR, "options-aicg-context.png") });

    expect(fs.existsSync(path.join(ARTIFACT_DIR, "options-category-table.png"))).toBe(true);
});
