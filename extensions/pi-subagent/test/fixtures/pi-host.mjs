import { writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { relative } from "node:path";

// Model Pi's host-provided module mapping without importing a real SDK or CLI.
registerHooks({
	resolve(specifier, context, nextResolve) {
		return specifier === "@earendil-works/pi-coding-agent"
			? { url: import.meta.url, shortCircuit: true }
			: nextResolve(specifier, context);
	},
});

export function getPackageDir() {
	if (!process.env.PI_PACKAGE_DIR) throw new Error("Test Pi package is absent.");
	return process.env.PI_PACKAGE_DIR;
}

export function useFakePi(root, script) {
	writeFileSync(`${root}/package.json`, JSON.stringify({
		name: "@earendil-works/pi-coding-agent", bin: { pi: relative(root, script) },
	}));
	const previous = process.env.PI_PACKAGE_DIR;
	process.env.PI_PACKAGE_DIR = root;
	return () => {
		if (previous === undefined) delete process.env.PI_PACKAGE_DIR;
		else process.env.PI_PACKAGE_DIR = previous;
	};
}
