import { CommandPayload } from "./commandBus";
import { ContentEventMeta } from "./types";

declare const process:
    | {
        env?: {
            NODE_ENV?: string;
            JEST_WORKER_ID?: string;
        };
    }
    | undefined;

function isDevelopmentBuild(): boolean {
    if (typeof process !== "undefined" && process?.env?.JEST_WORKER_ID) {
        return false;
    }

    return typeof process !== "undefined" && process?.env?.NODE_ENV !== "production";
}

function summarizeValue(value: unknown): unknown {
    if (Array.isArray(value)) {
        return `[array:${value.length}]`;
    }

    if (value instanceof HTMLVideoElement) {
        return "[video]";
    }

    if (value instanceof HTMLElement) {
        return `[element:${value.tagName.toLowerCase()}]`;
    }

    if (!value || typeof value !== "object") {
        return value;
    }

    const summary: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
        if (nestedValue instanceof HTMLElement || nestedValue instanceof HTMLVideoElement) {
            summary[key] = summarizeValue(nestedValue);
            continue;
        }

        if (Array.isArray(nestedValue)) {
            summary[key] = `[array:${nestedValue.length}]`;
            continue;
        }

        if (nestedValue && typeof nestedValue === "object") {
            summary[key] = "[object]";
            continue;
        }

        summary[key] = nestedValue;
    }

    return summary;
}

export function createContentTrace() {
    const enabled = isDevelopmentBuild();

    return {
        logCommand<K extends PropertyKey>(command: K, payload: CommandPayload<Record<K, { payload: unknown; result: unknown }>, K>): void {
            if (!enabled) {
                return;
            }

            console.debug("[BSB content command]", String(command), summarizeValue(payload));
        },
        logEvent<K extends PropertyKey>(event: K, payload: unknown, meta: ContentEventMeta): void {
            if (!enabled) {
                return;
            }

            console.debug("[BSB content event]", {
                time: new Date(meta.timestamp).toISOString(),
                event: String(event),
                source: meta.source,
                payload: summarizeValue(payload),
            });
        },
    };
}
