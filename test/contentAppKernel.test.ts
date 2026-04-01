import { CommandBus } from "../src/content/app/commandBus";
import { EventBus } from "../src/content/app/eventBus";
import { ContentStore } from "../src/content/app/store";

describe("content app kernel", () => {
    test("event bus emits in subscription order and supports unsubscription", () => {
        const bus = new EventBus<{
            "demo/event": { value: number };
        }>();
        const calls: string[] = [];

        const dispose = bus.on("demo/event", (payload) => {
            calls.push(`first:${payload.value}`);
        });
        bus.on("demo/event", (payload) => {
            calls.push(`second:${payload.value}`);
        });

        bus.emit("demo/event", { value: 1 }, { source: "test" });
        dispose();
        bus.emit("demo/event", { value: 2 }, { source: "test" });

        expect(calls).toEqual(["first:1", "second:1", "second:2"]);
    });

    test("command bus supports sync and async handlers", async () => {
        const commands = new CommandBus<{
            sync: { payload: { value: number }; result: number };
            async: { payload: { value: number }; result: number };
        }>();

        commands.register("sync", ({ value }) => value + 1);
        commands.register("async", async ({ value }) => value + 2);

        expect(commands.execute("sync", { value: 1 })).toBe(2);
        await expect(Promise.resolve(commands.execute("async", { value: 1 }))).resolves.toBe(3);
    });

    test("content store publishes updates and supports selectors", () => {
        const store = new ContentStore({
            count: 0,
            label: "idle",
        });
        const changes: string[] = [];

        store.subscribe((state, previousState, source) => {
            changes.push(`${source}:${previousState.count}->${state.count}`);
        });

        store.setState({ count: 1 }, "first");
        store.setState((state) => ({ ...state, count: state.count + 1, label: "done" }), "second");

        expect(store.select((state) => state.label)).toBe("done");
        expect(store.getState().count).toBe(2);
        expect(changes).toEqual(["first:0->1", "second:1->2"]);
    });
});
