import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

async function harness(t: TestContext, exercise: unknown = "coherent") {
	const home = await mkdtemp(join(tmpdir(), "pi-mindful-"));
	const originalHome = process.env.HOME;
	const originalUserProfile = process.env.USERPROFILE;
	const originalChild = process.env.PI_ORCHESTRATED_CHILD;
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	delete process.env.PI_ORCHESTRATED_CHILD;
	t.after(async () => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		if (originalChild === undefined) delete process.env.PI_ORCHESTRATED_CHILD;
		else process.env.PI_ORCHESTRATED_CHILD = originalChild;
		await rm(home, { recursive: true, force: true });
	});
	assert.equal(homedir(), home, "tests must not access the real user configuration");
	const configPath = join(home, ".pi", "agent", "mindful.json");
	await mkdir(join(home, ".pi", "agent"), { recursive: true });
	await writeFile(configPath, JSON.stringify({ exercise, delaySeconds: 0 }));
	const { default: extension } = await import(`../src/index.ts?${home}`);
	const handlers = new Map<string, (event: unknown, ctx: any) => Promise<void>>();
	let command!: (args: string, ctx: any) => Promise<void>;
	extension({
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerCommand: (_name: string, definition: any) => { command = definition.handler; },
	} as any);
	const notices: Array<{ message: string; level: string }> = [];
	const widgets: Array<string[] | undefined> = [];
	let selected = "";
	const ctx = {
		hasUI: true,
		ui: {
			setWorkingIndicator: () => {},
			setWidget: (_id: string, lines: string[] | undefined) => widgets.push(lines),
			notify: (message: string, level: string) => notices.push({ message, level }),
			select: async (title: string) => title === "Mindful" ? "exercise" : selected,
		},
	};
	t.after(() => handlers.get("session_shutdown")!({}, ctx));
	return { command: (args: string) => command(args, ctx), notices, widgets, configPath,
		select: (value: string) => { selected = value; },
		start: () => handlers.get("agent_start")!({}, ctx) };
}

test("rejects inherited exercise names in commands and dialogs without saving", async (t) => {
	const h = await harness(t);
	for (const name of ["constructor", "__proto__", "toString"]) {
		await h.command(`exercise ${name}`);
		assert.equal(h.notices.at(-1)?.level, "error");
		h.select(name);
		await h.command("");
		assert.equal(JSON.parse(await readFile(h.configPath, "utf8")).exercise, "coherent");
	}
	await h.command("exercise sigh");
	assert.equal(JSON.parse(await readFile(h.configPath, "utf8")).exercise, "sigh");
});

test("invalid persisted exercises fall back before timer rendering", async (t) => {
	const h = await harness(t);
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	for (const exercise of ["constructor", "__proto__", "toString", ["constructor"], { toString: "box" }]) {
		await writeFile(h.configPath, JSON.stringify({ exercise, delaySeconds: 0 }));
		await h.start();
		t.mock.timers.tick(0);
		t.mock.timers.tick(120);
		assert.match(h.widgets.at(-1)!.join(""), /Coherent breathing/);
	}
});
