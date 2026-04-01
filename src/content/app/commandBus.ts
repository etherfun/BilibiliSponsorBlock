export type CommandPayload<Commands, K extends keyof Commands> =
    Commands[K] extends { payload: infer Payload } ? Payload : never;

export type CommandResult<Commands, K extends keyof Commands> =
    Commands[K] extends { result: infer Result } ? Result : never;

export type CommandHandler<Commands, K extends keyof Commands> =
    (payload: CommandPayload<Commands, K>) => CommandResult<Commands, K> | Promise<CommandResult<Commands, K>>;

export interface CommandBusTrace<Commands> {
    logCommand?<K extends keyof Commands>(command: K, payload: CommandPayload<Commands, K>): void;
}

export class CommandBus<Commands extends object> {
    private handlers = new Map<keyof Commands, CommandHandler<Commands, keyof Commands>>();
    private trace?: CommandBusTrace<Commands>;

    constructor(trace?: CommandBusTrace<Commands>) {
        this.trace = trace;
    }

    register<K extends keyof Commands>(command: K, handler: CommandHandler<Commands, K>): () => void {
        this.handlers.set(command, handler as CommandHandler<Commands, keyof Commands>);

        return () => {
            if (this.handlers.get(command) === handler) {
                this.handlers.delete(command);
            }
        };
    }

    execute<K extends keyof Commands>(
        command: K,
        payload: CommandPayload<Commands, K>
    ): CommandResult<Commands, K> | Promise<CommandResult<Commands, K>> {
        const handler = this.handlers.get(command);
        if (!handler) {
            throw new Error(`No handler registered for command "${String(command)}".`);
        }

        this.trace?.logCommand?.(command, payload);

        return handler(payload as CommandPayload<Commands, keyof Commands>) as CommandResult<Commands, K>;
    }
}
