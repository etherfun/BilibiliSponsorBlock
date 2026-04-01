import { ContentEventMap, ContentEventMeta } from "./types";

export type EventHandler<Events, K extends keyof Events> = (payload: Events[K], meta: ContentEventMeta) => void;

export interface EventBusTrace<Events> {
    logEvent?<K extends keyof Events>(event: K, payload: Events[K], meta: ContentEventMeta): void;
}

export class EventBus<Events extends object> {
    private listeners = new Map<keyof Events, Set<EventHandler<Events, keyof Events>>>();
    private trace?: EventBusTrace<Events>;

    constructor(trace?: EventBusTrace<Events>) {
        this.trace = trace;
    }

    on<K extends keyof Events>(event: K, handler: EventHandler<Events, K>): () => void {
        const handlers = this.listeners.get(event) ?? new Set<EventHandler<Events, keyof Events>>();
        handlers.add(handler as EventHandler<Events, keyof Events>);
        this.listeners.set(event, handlers);

        return () => this.off(event, handler);
    }

    off<K extends keyof Events>(event: K, handler: EventHandler<Events, K>): void {
        const handlers = this.listeners.get(event);
        if (!handlers) {
            return;
        }

        handlers.delete(handler as EventHandler<Events, keyof Events>);
        if (handlers.size === 0) {
            this.listeners.delete(event);
        }
    }

    emit<K extends keyof Events>(event: K, payload: Events[K], meta?: Partial<ContentEventMeta>): void {
        const eventMeta: ContentEventMeta = {
            source: meta?.source ?? "unknown",
            timestamp: meta?.timestamp ?? Date.now(),
        };

        this.trace?.logEvent?.(event, payload, eventMeta);

        const handlers = this.listeners.get(event);
        if (!handlers) {
            return;
        }

        handlers.forEach((handler) => handler(payload, eventMeta));
    }
}

export type ContentEventBus = EventBus<ContentEventMap>;
