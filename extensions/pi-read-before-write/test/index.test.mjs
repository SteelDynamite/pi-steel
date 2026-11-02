import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import test from "node:test";
import readBeforeWrite, { resolveTrackedPath } from "../dist/index.js";

async function harness(t) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-rbw-test-"));
	t.after(() => fs.rm(cwd, { recursive: true, force: true }));
	const tools = new Map();
	const handlers = new Map();
	readBeforeWrite({
		registerTool: tool => tools.set(tool.name, tool),
		on: (name, handler) => handlers.set(name, handler),
	});
	return {
		cwd, tools,
		reset: (event = "session_start") => handlers.get(event)({}, { cwd }),
		file: (name = "file.txt") => path.join(cwd, name),
		async run(name, input, signal) {
			const tool = tools.get(name);
			return tool.execute("test-id", input, signal, undefined, { cwd });
		},
		read(name = "file.txt", extra = {}) { return this.run("read", { path: name, ...extra }); },
		write(content = "two", name = "file.txt") { return this.run("write", { path: name, content }); },
		edit(oldText = "one", newText = "two", name = "file.txt") {
			return this.run("edit", { path: name, edits: [{ oldText, newText }] });
		},
	};
}

for (const tool of ["edit", "write"]) {
	test(`${tool} requires read, blocks changes, then permits a reread`, async t => {
		const h = await harness(t);
		await fs.writeFile(h.file(), "one");
		const mutate = () => tool === "write" ? h.write("three") : h.edit("two", "three");
		await assert.rejects(mutate(), /has not been read/);
		await h.read();
		await fs.writeFile(h.file(), "two");
		await assert.rejects(mutate(), /changed on disk/);
		await h.read();
		await mutate();
		assert.equal(await fs.readFile(h.file(), "utf8"), "three");
	});
	test(`${tool} trusts produced bytes, not a post-write replacement`, async t => {
		const h = await harness(t);
		await fs.writeFile(h.file(), "one");
		await h.read();
		const original = fs.writeFile;
		t.mock.method(fs, "writeFile", async (file, ...args) => {
			await original(file, ...args);
			if (file === h.file()) await original(file, "external");
		});
		await (tool === "write" ? h.write() : h.edit());
		await assert.rejects(h.write(), /changed on disk/);
		assert.equal(await fs.readFile(h.file(), "utf8"), "external");
	});
}

test("read captures returned bytes, not an external replacement before result", async t => {
	const h = await harness(t);
	await fs.writeFile(h.file(), "one");
	const original = fs.readFile;
	let replace = true;
	t.mock.method(fs, "readFile", async (file, ...args) => {
		const bytes = await original(file, ...args);
		if (replace && file === h.file()) { replace = false; await fs.writeFile(file, "external"); }
		return bytes;
	});
	assert.equal((await h.read()).content[0].text, "one");
	await assert.rejects(h.write(), /changed on disk/);
});

test("a concurrent reread cannot authorize an edit computed from older bytes", async t => {
	const h = await harness(t);
	await fs.writeFile(h.file(), "one");
	await h.read();
	const original = fs.readFile;
	let reads = 0;
	t.mock.method(fs, "readFile", async (file, ...args) => {
		if (file === h.file() && ++reads === 2) {
			await fs.writeFile(file, "newer");
			await h.read();
		}
		return original(file, ...args);
	});
	await assert.rejects(h.edit(), /changed on disk/);
	assert.equal(await original(h.file(), "utf8"), "newer");
});

test("aborted mutations retain negative history rather than authorizing produced bytes", async t => {
	const h = await harness(t);
	await fs.writeFile(h.file(), "one");
	await h.read();
	const abort = new AbortController(), original = fs.writeFile;
	t.mock.method(fs, "writeFile", async (...args) => { await original(...args); abort.abort(); });
	await assert.rejects(h.run("write", { path: "file.txt", content: "two" }, abort.signal), /aborted/);
	await assert.rejects(h.write(), /changed on disk/);
});

test("own new writes and edits authorize subsequent edits; BOM and CRLF remain host-owned", async t => {
	const h = await harness(t);
	await h.write("\ufeffone\r\nline\r\n");
	await h.edit("one", "two");
	await h.edit("two", "three");
	assert.equal(await fs.readFile(h.file(), "utf8"), "\ufeffthree\r\nline\r\n");
});

for (const event of ["session_start", "session_tree", "session_compact", "session_shutdown"]) {
	test(`${event} clears authorization including in-flight reads`, async t => {
		const h = await harness(t);
		await fs.writeFile(h.file(), "one");
		await h.read();
		h.reset(event);
		await assert.rejects(h.write(), /has not been read/);
		const original = fs.readFile;
		let enter, release;
		const entered = new Promise(resolve => { enter = resolve; });
		const paused = new Promise(resolve => { release = resolve; });
		let pause = true;
		t.mock.method(fs, "readFile", async (...args) => {
			const bytes = await original(...args);
			if (pause) { pause = false; enter(); await paused; }
			return bytes;
		});
		const pending = h.read();
		await entered;
		h.reset(event);
		release();
		await pending;
		await assert.rejects(h.write(), /has not been read/);
	});
}

test("extension instances do not share authorization", async t => {
	const first = await harness(t), second = await harness(t);
	await fs.writeFile(first.file(), "one");
	await first.read();
	await assert.rejects(second.write("two", first.file()), /has not been read/);
});

test("partial and truncated reads authorize the whole observed file", async t => {
	const h = await harness(t);
	await fs.writeFile(h.file(), Array.from({ length: 2100 }, (_, i) => `line ${i}`).join("\n"));
	const result = await h.read("file.txt", { offset: 2, limit: 1 });
	assert.match(result.content[0].text, /^line 1/);
	await h.write();
	await fs.writeFile(h.file(), "one\n".repeat(2100));
	assert.equal((await h.read()).details.truncation.truncated, true);
	await h.write();
});

test("image reads preserve host image output and authorize original bytes", async t => {
	const h = await harness(t);
	const chunk = (type, bytes) => {
		const payload = Buffer.concat([Buffer.from(type), bytes]);
		const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
		length.writeUInt32BE(bytes.length); checksum.writeUInt32BE(crc32(payload));
		return Buffer.concat([length, payload, checksum]);
	};
	const header = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
	await fs.writeFile(h.file("pixel.png"), Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
		chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk("IEND", Buffer.alloc(0)),
	]));
	const result = await h.read("pixel.png");
	assert(result.content.some(block => block.type === "image"), JSON.stringify(result));
	await h.write("replacement", "pixel.png");
});

for (const alias of ["@file.txt", "file-url", "space\u202ffile.txt"]) {
	test(`host path normalization: ${alias}`, async t => {
		const h = await harness(t);
		const name = alias.startsWith("space") ? "space file.txt" : "file.txt";
		await fs.writeFile(h.file(name), "one");
		await h.read(alias === "file-url" ? pathToFileURL(h.file()).href : alias);
		await h.write("two", name);
	});
}

for (const [actual, requested] of [["cafe\u0301.txt", "caf\u00e9.txt"], ["shot 1\u202fPM.png", "shot 1 PM.png"], ["l\u2019image.txt", "l'image.txt"]]) {
	test(`host alternative filename ${actual}`, async t => {
		const h = await harness(t);
		await fs.writeFile(h.file(actual), "one");
		assert.equal((await h.read(requested)).content[0].text, "one");
		await h.write("two", actual);
		// A fallback read must not authorize a different, subsequently created candidate.
		if (actual !== requested) {
			await fs.writeFile(h.file(requested), "other");
			await assert.rejects(h.write("bad", requested), /has not been read|changed on disk/);
		}
	});
}

test("deleted history follows unrecorded directory aliases and dangling file links", async t => {
	const h = await harness(t);
	await fs.mkdir(h.file("real"));
	await fs.symlink(h.file("real"), h.file("alias"), "dir");
	await fs.writeFile(h.file("real/f"), "one");
	await fs.symlink(h.file("real/f"), h.file("link"));
	await h.read("real/f");
	await fs.rm(h.file("real/f"));
	for (const name of ["real/f", "alias/f", "link"]) await assert.rejects(h.write("bad", name), /deleted since the last read/);
	assert.equal(await resolveTrackedPath("alias/f", h.cwd), h.file("real/f"));
});

test("retargeted aliases cannot borrow authorization from the old target", async t => {
	const h = await harness(t);
	await fs.writeFile(h.file("first"), "one");
	await fs.writeFile(h.file("second"), "one");
	await fs.symlink(h.file("first"), h.file("link"));
	await h.read("link");
	await fs.rm(h.file("link"));
	await fs.symlink(h.file("second"), h.file("link"));
	await assert.rejects(h.write("bad", "link"), /changed on disk|has not been read/);
});

test("failed and aborted reads never create authorization", async t => {
	const h = await harness(t);
	await fs.writeFile(h.file(), "one");
	await assert.rejects(h.read("file.txt", { offset: 99 }), /beyond end/);
	const abort = new AbortController(); abort.abort();
	await assert.rejects(h.run("read", { path: "file.txt" }, abort.signal), /aborted/);
	await assert.rejects(h.write(), /has not been read/);
});

test("failed partial mutation preserves bounded deletion history but revokes authorization", async t => {
	const h = await harness(t);
	await fs.writeFile(h.file(), "one");
	await h.read();
	const original = fs.writeFile;
	t.mock.method(fs, "writeFile", async (file, ...args) => {
		if (file !== h.file()) return original(file, ...args);
		await fs.rm(file);
		throw Object.assign(new Error("failed write"), { code: "EIO" });
	});
	await assert.rejects(h.write(), /failed write/);
	await assert.rejects(h.write(), /deleted since the last read/);
});

test("failed reread does not erase deleted history", async t => {
	const h = await harness(t);
	await fs.writeFile(h.file(), "one");
	await h.read();
	await fs.rm(h.file());
	await assert.rejects(h.read());
	await assert.rejects(h.write(), /deleted since the last read/);
});

test("filesystem inspection failure fails closed", async t => {
	const h = await harness(t);
	await fs.writeFile(h.file(), "one");
	t.mock.method(fs, "readFile", async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); });
	await assert.rejects(h.write(), /denied/);
});

test("100-file LRU includes negative history; eviction requires reread of existing files", async t => {
	const h = await harness(t);
	for (let i = 0; i < 100; i++) { await fs.writeFile(h.file(String(i)), "one"); await h.read(String(i)); }
	await h.edit("one", "two", "0");
	await h.write("one", "100");
	await assert.rejects(h.write("bad", "1"), /has not been read/);
	await h.write("three", "0");
});

test("real Pi pipeline rejects read/result and mutation/result replacement races", async t => {
	const h = await harness(t);
	const home = path.join(h.cwd, "home"), agent = path.join(home, "agent");
	await fs.mkdir(agent, { recursive: true });
	await fs.writeFile(path.join(agent, "settings.json"), JSON.stringify({
		defaultProvider: "rbw-local", defaultModel: "fixture", compaction: { enabled: false }, retry: { enabled: false },
	}));
	const guard = path.join(h.cwd, "deny-network.mjs");
	await fs.writeFile(guard, `
		import net from 'node:net'; import http from 'node:http'; import https from 'node:https';
		const deny = () => { throw new Error('Network forbidden in RBW test'); };
		globalThis.fetch = deny; net.Socket.prototype.connect = deny; http.request = deny; https.request = deny;
	`);
	const host = getPackageDir();
	const manifest = JSON.parse(await fs.readFile(path.join(host, "package.json"), "utf8"));
	const result = spawnSync(process.execPath, [path.join(host, manifest.bin.pi), "--offline", "--no-approve", "--no-session",
		"--no-extensions", "--no-skills", "--no-prompt-templates", "-e", path.resolve(import.meta.dirname, "../index.js"),
		"-e", path.join(import.meta.dirname, "host-fixture.mjs"), "-p", "Run rbw_probe."], {
		cwd: h.cwd, encoding: "utf8", timeout: 30_000,
		env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", NO_COLOR: "1", NODE_OPTIONS: `--import=${guard}` },
	});
	assert.equal(result.error, undefined, String(result.error));
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.doesNotMatch(result.stdout + result.stderr, /Failed to load extension|extension error/i);
	assert.equal(await fs.readFile(path.join(h.cwd, "passed"), "utf8").catch(async () => result.stdout + result.stderr + await fs.readFile(path.join(h.cwd, "host-results.json"), "utf8").catch(() => "")), "actual host pipeline passed");
});

test("many aliases share a bounded budget and eviction drops associated metadata", async t => {
	const h = await harness(t);
	await fs.writeFile(h.file(), "one");
	const sizes = [];
	const original = Map.prototype.set;
	t.mock.method(Map.prototype, "set", function(key, value) {
		const result = original.call(this, key, value);
		if (typeof key === "string" && key.startsWith(h.cwd) && typeof value === "string" && value.startsWith(h.cwd)) sizes.push(this.size);
		return result;
	});
	for (let i = 0; i < 150; i++) { await fs.symlink(h.file(), h.file(`alias-${i}`)); await h.read(`alias-${i}`); }
	// One insertion may temporarily exceed the bound before synchronous eviction.
	assert(Math.max(...sizes) <= 101);
	await h.write();
});
