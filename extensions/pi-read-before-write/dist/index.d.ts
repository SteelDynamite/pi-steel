import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
/** Compatibility helper. Runtime guards receive native paths from Pi's own resolver. */
export declare function resolveTrackedPath(input: string, cwd: string): Promise<string>;
export default function readBeforeWrite(pi: ExtensionAPI): void;
