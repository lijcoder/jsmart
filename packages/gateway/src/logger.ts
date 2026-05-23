/**
 * Logging abstraction with a pluggable backend.
 *
 * Usage:
 *   import { logger } from "./logger.js";
 *   logger.info("session created");
 *
 * Switch backend at startup:
 *   import { setLoggerImpl } from "./logger.js";
 *   setLoggerImpl(createDebugLogger({ namespace: "pi:gateway" }));
 */

export enum LogLevel {
	Debug = 0,
	Info = 1,
	Warn = 2,
	Error = 3,
	Silent = 4,
}

export interface Logger {
	debug(message: string, ...args: unknown[]): void;
	info(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	error(message: string, ...args: unknown[]): void;
	child(namespace: string): Logger;
}

// ── Singleton ──

let _impl: Logger = createDefaultLogger();

export function setLoggerImpl(impl: Logger): void {
	_impl = impl;
}

export const logger: Logger = {
	debug: (_message, ..._args) => {},
	info: (message, ...args) => _impl.info(message, ...args),
	warn: (message, ...args) => _impl.warn(message, ...args),
	error: (message, ...args) => _impl.error(message, ...args),
	child: (namespace) => _impl.child(namespace),
};

// ── Default implementation: console ──

function createDefaultLogger(): Logger {
	return {
		debug: (message, ...args) => console.debug(message, ...args),
		info: (message, ...args) => console.log(message, ...args),
		warn: (message, ...args) => console.warn(message, ...args),
		error: (message, ...args) => console.error(message, ...args),
		child: () => createDefaultLogger(),
	};
}
