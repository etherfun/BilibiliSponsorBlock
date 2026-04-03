describe("parseVideoID player manifest fallback", () => {
    beforeEach(() => {
        jest.resetModules();
    });

    test("getVideoIDFromPlayerManifest returns null when player manifest is unavailable", async () => {
        jest.doMock("../src/utils/injectedScriptMessageUtils", () => ({
            getBvidFromAidFromWindow: jest.fn(),
            getCidFromBvidAndPageFromWindow: jest.fn(),
            getPropertyFromWindow: jest.fn(),
            getVideoInfoFromWindowOnplayerManifest: jest.fn(async () => null),
        }));

        const { getVideoIDFromPlayerManifest } = await import("../src/utils/parseVideoID");

        await expect(getVideoIDFromPlayerManifest()).resolves.toBeNull();
    });

    test("getVideoIDFromPlayerManifest derives bvid from aid when manifest has no bvid", async () => {
        jest.doMock("../src/utils/injectedScriptMessageUtils", () => ({
            getBvidFromAidFromWindow: jest.fn(),
            getCidFromBvidAndPageFromWindow: jest.fn(),
            getPropertyFromWindow: jest.fn(),
            getVideoInfoFromWindowOnplayerManifest: jest.fn(async () => ({
                aid: "170001",
                cid: "12345",
                bvid: null,
                p: 1,
            })),
        }));
        jest.doMock("../src/utils/bvidAvidUtils", () => ({
            CalculateAvidToBvid: jest.fn(() => "BV17x411w7KC"),
        }));

        const { getVideoIDFromPlayerManifest } = await import("../src/utils/parseVideoID");

        await expect(getVideoIDFromPlayerManifest()).resolves.toBe("BV17x411w7KC+12345");
    });
});
