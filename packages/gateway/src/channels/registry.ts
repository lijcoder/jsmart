import type { Channel, ChannelGeneralConfig } from "./types.js";

/** Factory for creating a Channel instance from its config object */
export interface ChannelFactory<C = Record<string, unknown>> {
	/** Matches config.type — used as the registry key */
	readonly type: string;
	/** Create a Channel instance from a validated config object */
	create(config: C, generalConfig?: ChannelGeneralConfig): Channel;
}

/** Registry that maps channel type strings to factories */
export class ChannelRegistry {
	private factories = new Map<string, ChannelFactory>();

	/** Register a channel factory. Throws if type is already registered. */
	register<C>(factory: ChannelFactory<C>): void {
		if (this.factories.has(factory.type)) {
			throw new Error(`Channel type "${factory.type}" is already registered`);
		}
		this.factories.set(factory.type, factory as ChannelFactory);
	}

	/** Create a Channel instance from a config object based on its type field */
	create(type: string, config: unknown, generalConfig: ChannelGeneralConfig): Channel {
		const factory = this.factories.get(type);
		if (!factory) {
			const known = [...this.factories.keys()];
			throw new Error(`Unknown channel type: "${type}". Registered types: [${known.join(", ")}]`);
		}
		return factory.create(config as Record<string, unknown>, generalConfig);
	}

	/** Check if a channel type is registered */
	has(type: string): boolean {
		return this.factories.has(type);
	}

	/** List all registered channel types */
	types(): string[] {
		return [...this.factories.keys()];
	}
}

/** Global singleton registry — used by auto-registration */
let _globalRegistry: ChannelRegistry | undefined;

export function getGlobalRegistry(): ChannelRegistry {
	if (!_globalRegistry) {
		_globalRegistry = new ChannelRegistry();
	}
	return _globalRegistry;
}

/** Reset global registry (useful for testing) */
export function resetGlobalRegistry(): void {
	_globalRegistry = undefined;
}

/**
 * Register a channel factory to the global registry.
 * Call this at module top-level for auto-registration.
 */
export function registerChannelFactory<C>(factory: ChannelFactory<C>): void {
	getGlobalRegistry().register(factory);
}
