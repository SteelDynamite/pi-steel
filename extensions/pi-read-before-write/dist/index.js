import { createHash } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createReadToolDefinition, createEditToolDefinition, createWriteToolDefinition, detectSupportedImageMimeTypeFromFile, } from "@earendil-works/pi-coding-agent";
// Negative records and aliases share the same metadata budget as authorization.
class FingerprintCache {
    entries = new Map();
    aliases = new Map();
    get(key, alias) {
        const value = this.entries.get(key) ?? this.entries.get(this.aliases.get(alias) ?? "");
        if (value) {
            const actual = this.entries.has(key) ? key : this.aliases.get(alias);
            this.entries.delete(actual);
            this.entries.set(actual, value);
        }
        return value;
    }
    set(key, alias, hash) {
        const value = this.entries.get(key) ?? { aliases: new Set() };
        value.hash = hash;
        this.entries.delete(key);
        this.entries.set(key, value);
        const previous = this.aliases.get(alias);
        if (previous)
            this.entries.get(previous)?.aliases.delete(alias);
        this.aliases.delete(alias);
        this.aliases.set(alias, key);
        value.aliases.add(alias);
        while (this.entries.size > 100 || this.aliases.size > 100 || this.bytes() > 1024 * 1024) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined)
                break;
            for (const alias of this.entries.get(oldest).aliases)
                this.aliases.delete(alias);
            this.entries.delete(oldest);
        }
    }
    bytes() {
        let total = 0;
        for (const [key, value] of this.entries) {
            total += Buffer.byteLength(key) + (value.hash?.length ?? 0) + 32;
            for (const alias of value.aliases)
                total += Buffer.byteLength(alias) + 16;
        }
        return total;
    }
}
function missing(error) {
    return !!error && typeof error === "object" && "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR");
}
// Resolve missing suffixes through existing parents, including dangling links.
// This is identity tracking, not an atomic filesystem boundary.
async function canonicalPath(absolute, links = 0) {
    if (links > 40)
        throw new Error("Too many symbolic links");
    try {
        return await fs.realpath(absolute);
    }
    catch (error) {
        if (!missing(error))
            throw error;
    }
    try {
        const target = await fs.readlink(absolute);
        return canonicalPath(path.resolve(path.dirname(absolute), target), links + 1);
    }
    catch (error) {
        if (!missing(error) && !(typeof error === "object" && error !== null && "code" in error && error.code === "EINVAL"))
            throw error;
    }
    const parent = path.dirname(absolute);
    if (parent === absolute)
        return absolute;
    return path.join(await canonicalPath(parent, links), path.basename(absolute));
}
/** Compatibility helper. Runtime guards receive native paths from Pi's own resolver. */
export async function resolveTrackedPath(input, cwd) {
    let normalized = input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ").replace(/^@/, "");
    if (process.platform === "win32" && !normalized.includes("\\")) {
        const drive = normalized.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
        if (drive)
            normalized = `${drive[1].toUpperCase()}:\\${(drive[2] ?? "").replaceAll("/", "\\")}`;
    }
    if (normalized === "~")
        normalized = os.homedir();
    else if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\")))
        normalized = path.join(os.homedir(), normalized.slice(2));
    else if (/^file:\/\//.test(normalized))
        normalized = fileURLToPath(normalized);
    return canonicalPath(path.resolve(cwd, normalized));
}
function hash(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}
async function guard(cache, absolute, allowNew, bytes, expected) {
    const key = await canonicalPath(absolute);
    const fingerprint = cache.get(key, "");
    let current;
    try {
        current = bytes ?? await fs.readFile(absolute);
    }
    catch (error) {
        if (!missing(error))
            throw error;
        if (fingerprint || cache.get(key, absolute))
            throw new Error(`Blocked stale write: file was deleted since the last read: ${absolute}`);
        if (allowNew)
            return key;
        throw new Error(`Blocked stale write: file has not been read in this session. Read it before editing: ${absolute}`);
    }
    if (!fingerprint)
        throw new Error(`Blocked stale write: file has not been read in this session. Read it before editing: ${absolute}`);
    const currentHash = hash(current);
    if (fingerprint.hash !== currentHash || (expected && (expected.key !== key || expected.hash !== currentHash))) {
        throw new Error(`Blocked stale write: file changed on disk since the last read. Read it again before editing: ${absolute}`);
    }
    return key;
}
export default function readBeforeWrite(pi) {
    let cache = new FingerprintCache();
    const reset = () => { cache = new FingerprintCache(); };
    pi.on("session_start", reset);
    pi.on("session_tree", reset);
    pi.on("session_compact", reset);
    pi.on("session_shutdown", reset);
    // Delegate schemas, rendering, path fallbacks, BOM/line endings, image handling,
    // cancellation and mutation serialization to the installed host. Only the actual
    // bytes handed across its operation boundary may establish authorization.
    // Erase schema-specific types only across this forwarding loop; each definition
    // retains its original schema and receives its own validated input unchanged.
    const factories = {
        read: createReadToolDefinition, edit: createEditToolDefinition, write: createWriteToolDefinition,
    };
    for (const name of ["read", "edit", "write"]) {
        const definition = factories[name](process.cwd());
        pi.registerTool({
            ...definition,
            async execute(id, input, signal, onUpdate, ctx) {
                const owner = cache;
                let observed;
                const operations = {
                    access: (absolute) => fs.access(absolute, name === "read" ? constants.R_OK : constants.R_OK | constants.W_OK),
                    detectImageMimeType: detectSupportedImageMimeTypeFromFile,
                    mkdir: async (directory) => { await fs.mkdir(directory, { recursive: true }); },
                    readFile: async (absolute) => {
                        const key = await canonicalPath(absolute);
                        const bytes = await fs.readFile(absolute);
                        if (name === "edit")
                            await guard(owner, absolute, false, bytes);
                        if (key === await canonicalPath(absolute))
                            observed = { key, absolute, hash: hash(bytes) };
                        return bytes;
                    },
                    writeFile: async (absolute, content) => {
                        if (name === "edit" && !observed)
                            throw new Error(`Blocked stale write: file identity changed during edit: ${absolute}`);
                        // A concurrent read must not authorize writing an edit computed from older bytes.
                        const key = await guard(owner, absolute, name === "write", undefined, name === "edit" ? observed : undefined);
                        // Revoke before attempting I/O: failed/partial writes must not keep authorization.
                        owner.set(key, absolute);
                        await fs.writeFile(absolute, content, "utf8");
                        if (key === await canonicalPath(absolute))
                            observed = { key, absolute, hash: hash(content) };
                    },
                };
                const tool = factories[name](ctx.cwd, { operations });
                const result = await tool.execute(id, input, signal, onUpdate, ctx);
                if (observed && !signal?.aborted)
                    owner.set(observed.key, observed.absolute, observed.hash);
                return result;
            },
        });
    }
}
//# sourceMappingURL=index.js.map