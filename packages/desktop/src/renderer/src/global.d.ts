import type { JSmartAPI } from "../../preload/index.js";

declare global {
	interface Window {
		jsmart: JSmartAPI;
	}
}
