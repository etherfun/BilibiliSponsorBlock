/** @jest-environment jsdom */

describe("content message handler", () => {
    function installModuleMocks(): void {
        jest.doMock("../src/config", () => ({
            __esModule: true,
            default: {
                configSyncListeners: [],
            },
        }));
        jest.doMock("../src/utils/video", () => ({
            checkVideoIDChange: jest.fn(),
            getChannelIDInfo: jest.fn(() => ({ id: null, status: 0 })),
            getVideo: jest.fn(() => ({ currentTime: 0, duration: 100 })),
            getVideoID: jest.fn(() => "BV1test"),
        }));
        jest.doMock("../src/utils/parseVideoID", () => ({
            getBilibiliVideoID: jest.fn(async () => "BV1test"),
        }));
        jest.doMock("../src/thumbnail-utils/thumbnailManagement", () => ({
            checkPageForNewThumbnails: jest.fn(),
        }));
    }

    function installChromeMock(): void {
        (global as unknown as { chrome: typeof chrome }).chrome = {
            runtime: {
                onMessage: {
                    addListener: jest.fn(),
                },
                sendMessage: jest.fn(),
                getManifest: jest.fn(() => ({
                    manifest_version: 3,
                    version: "0.1.10",
                })),
                id: "test-extension",
                lastError: null,
            },
            storage: {
                sync: {
                    get: jest.fn((_: unknown, callback: (value: Record<string, unknown>) => void) => callback({})),
                    set: jest.fn(),
                    remove: jest.fn(),
                },
                local: {
                    get: jest.fn((_: unknown, callback: (value: Record<string, unknown>) => void) => callback({})),
                    set: jest.fn((_: unknown, callback?: () => void) => callback?.()),
                    remove: jest.fn(),
                },
                onChanged: {
                    addListener: jest.fn(),
                },
            },
            i18n: {
                getMessage: jest.fn(() => ""),
            },
            extension: {
                inIncognitoContext: false,
            },
            tabs: undefined,
        } as unknown as typeof chrome;
    }

    beforeEach(() => {
        jest.resetModules();
        installChromeMock();
        installModuleMocks();
        document.body.innerHTML = "<div></div>";
    });

    test("sponsorStart dispatches commands and returns current creation state", () => {
        try {
            const { createContentApp } = require("../src/content/app");
            const { handleContentMessage } = require("../src/content/messageHandler");
            const app = createContentApp();

            let toggled = false;
            app.commands.register("segment/toggleCapture", () => {
                toggled = true;
            });
            app.commands.register("segment/isCreationInProgress", () => true);

            const sendResponse = jest.fn();

            handleContentMessage({ message: "sponsorStart" }, null, sendResponse);

            expect(toggled).toBe(true);
            expect(sendResponse).toHaveBeenCalledWith({ creatingSegment: true });
        } catch (error) {
            throw new Error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
        }
    });

    test("submitTimes maps to the open submission command", () => {
        try {
            const { createContentApp } = require("../src/content/app");
            const { handleContentMessage } = require("../src/content/messageHandler");
            const app = createContentApp();

            let opened = false;
            app.commands.register("segment/openSubmissionMenu", () => {
                opened = true;
            });

            const sendResponse = jest.fn();

            handleContentMessage({ message: "submitTimes" }, null, sendResponse);

            expect(opened).toBe(true);
            expect(sendResponse).toHaveBeenCalledWith({});
        } catch (error) {
            throw new Error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
        }
    });
});
