export type StoreListener<State> = (state: State, previousState: State, source: string) => void;

export class ContentStore<State> {
    private state: State;
    private listeners = new Set<StoreListener<State>>();

    constructor(initialState: State) {
        this.state = initialState;
    }

    getState(): State {
        return this.state;
    }

    replaceState(nextState: State, source = "unknown"): void {
        const previousState = this.state;
        this.state = nextState;
        this.listeners.forEach((listener) => listener(this.state, previousState, source));
    }

    setState(updater: Partial<State> | ((state: State) => State), source = "unknown"): void {
        const nextState =
            typeof updater === "function"
                ? (updater as (state: State) => State)(this.state)
                : ({ ...this.state, ...updater } as State);

        this.replaceState(nextState, source);
    }

    subscribe(listener: StoreListener<State>): () => void {
        this.listeners.add(listener);

        return () => {
            this.listeners.delete(listener);
        };
    }

    select<Result>(selector: (state: State) => Result): Result {
        return selector(this.state);
    }
}
