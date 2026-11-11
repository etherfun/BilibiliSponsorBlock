import { expect, test } from "./fixtures/extension";
import type { Page, Worker } from "@playwright/test";
import fs from "fs";
import path from "path";
import { readSyncStorage, writeSyncStorage } from "./support/extensionStorage";

/**
 * 「疑似 AICG 内容」设置的界面与持久化验证。
 *
 * 设置项要求放在「隐藏 动态主页/评论区 的商品链接」类别里，因此这里同时校验
 * 位置（DOM 归属）、渲染（下拉框与子选项的联动）以及配置落盘。
 */

const ARTIFACT_DIR = path.resolve(__dirname, "..", "test-results", "aicg-ui");

async function openBehaviorOptions(page: Page, extensionId: string): Promise<void> {
    await page.goto(`chrome-extension://${extensionId}/options/options.html#behavior`);
    await expect(page.locator("#options-container")).toBeVisible();
    // 开关本身是被 CSS 收起的 checkbox，这里等它的容器出现。
    await expect(page.locator("[data-sync='dynamicAndCommentSponsorBlocker']")).toBeVisible();
}

async function enabledMasterSwitch(serviceWorker: Worker): Promise<void> {
    await writeSyncStorage(serviceWorker, {
        dynamicAndCommentSponsorBlocker: true,
        commentSponsorBlock: true,
        commentAicgAction: 0,
    });
}

test("设置位于商品链接类别内，四个模式齐全且默认禁用", async ({ extensionId, extensionPage: page, extensionServiceWorker }) => {
    await enabledMasterSwitch(extensionServiceWorker);
    await openBehaviorOptions(page, extensionId);

    // 位于「隐藏 动态主页/评论区 的商品链接」开关的子树内
    const insideCategory = page.locator("#dynamicAndCommentSponsorBlocker")
        .locator("xpath=ancestor::div[@data-type='toggle'][1]")
        .locator("#commentAicgAction");
    await expect(insideCategory).toHaveCount(1);

    const select = page.locator("#commentAicgAction");
    await expect(select).toHaveValue("0");
    await expect(select.locator("option")).toHaveText(["禁用", "仅添加标签", "隐藏内容", "隐藏卡片"]);
});

test("选择模式后写入配置，刷新后保持", async ({ extensionId, extensionPage: page, extensionServiceWorker }) => {
    await enabledMasterSwitch(extensionServiceWorker);
    await openBehaviorOptions(page, extensionId);

    await page.locator("#commentAicgAction").selectOption("2");
    await expect.poll(() => readSyncStorage<number>(extensionServiceWorker, "commentAicgAction")).toBe(2);

    await page.reload();
    await expect(page.locator("#commentAicgAction")).toHaveValue("2");

    // 其它取值同样可用
    for (const [value, stored] of [["1", 1], ["3", 3], ["0", 0]] as const) {
        await page.locator("#commentAicgAction").selectOption(value);
        await expect.poll(() => readSyncStorage<number>(extensionServiceWorker, "commentAicgAction")).toBe(stored);
        await page.reload();
        await expect(page.locator("#commentAicgAction")).toHaveValue(value);
    }
});

test("阈值与最小长度可编辑并持久化", async ({ extensionId, extensionPage: page, extensionServiceWorker }) => {
    await enabledMasterSwitch(extensionServiceWorker);
    await writeSyncStorage(extensionServiceWorker, { commentAicgAction: 1 });
    await openBehaviorOptions(page, extensionId);

    const threshold = page.locator("[data-sync='commentAicgThreshold'] input");
    await threshold.fill("0.7");
    await expect.poll(() => readSyncStorage<number>(extensionServiceWorker, "commentAicgThreshold")).toBe(0.7);

    const minLength = page.locator("[data-sync='commentAicgMinLength'] input");
    await minLength.fill("20");
    await expect.poll(() => readSyncStorage<number>(extensionServiceWorker, "commentAicgMinLength")).toBe(20);

    await page.reload();
    await expect(page.locator("[data-sync='commentAicgThreshold'] input")).toHaveValue("0.7");
    await expect(page.locator("[data-sync='commentAicgMinLength'] input")).toHaveValue("20");
});

test("子选项随模式联动：禁用时隐藏，启用时显示", async ({ extensionId, extensionPage: page, extensionServiceWorker }) => {
    await enabledMasterSwitch(extensionServiceWorker);
    await openBehaviorOptions(page, extensionId);

    // 禁用（0）时，阈值/长度/调试这些从属选项应当被隐藏
    await expect(page.locator("[data-sync='commentAicgThreshold']")).toHaveClass(/hidden/);

    await page.locator("#commentAicgAction").selectOption("1");
    await expect(page.locator("[data-sync='commentAicgThreshold']")).not.toHaveClass(/hidden/);
    await expect(page.locator("[data-sync='commentAicgMinLength']")).not.toHaveClass(/hidden/);
    await expect(page.locator("[data-sync='commentAicgDebug']")).not.toHaveClass(/hidden/);
});

test("关闭总开关后整个类别被隐藏（既有行为不变）", async ({ extensionId, extensionPage: page, extensionServiceWorker }) => {
    await writeSyncStorage(extensionServiceWorker, {
        dynamicAndCommentSponsorBlocker: false,
        commentSponsorBlock: true,
    });
    await openBehaviorOptions(page, extensionId);

    await expect(page.locator("[data-dependent-on='dynamicAndCommentSponsorBlocker']")).toHaveClass(/hidden/);
    // checkbox 本身被开关样式收起，点 label 才是真实用户的交互路径。
    await page.locator("label[for='dynamicAndCommentSponsorBlocker']").click();
    await expect(page.locator("[data-dependent-on='dynamicAndCommentSponsorBlocker']")).not.toHaveClass(/hidden/);
    await expect(page.locator("#commentAicgAction")).toBeVisible();
});

test("截图存档：设置界面", async ({ extensionId, extensionPage: page, extensionServiceWorker }) => {
    await enabledMasterSwitch(extensionServiceWorker);
    await writeSyncStorage(extensionServiceWorker, { commentAicgAction: 1, commentAicgDebug: true });
    await openBehaviorOptions(page, extensionId);
    await page.waitForTimeout(500);

    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    const block = page.locator(".aicg-settings");
    await expect(block).toBeVisible();
    await block.screenshot({ path: path.join(ARTIFACT_DIR, "options-aicg-block.png") });
    await page.locator("#behavior .aicg-settings").scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(ARTIFACT_DIR, "options-aicg-context.png") });

    expect(fs.existsSync(path.join(ARTIFACT_DIR, "options-aicg-block.png"))).toBe(true);
});
