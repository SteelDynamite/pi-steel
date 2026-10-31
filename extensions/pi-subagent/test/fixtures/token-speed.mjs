// Golden rates checked against pi-token-speed 0.1.0 src/token-speed.ts (MIT), SHA-256:
// 85cbf280535ea5ac1414514a67b1d55d815aac76b5563d5fa2d416be26e0bd4f
// Each step is [method, arguments, expected tok/s]; no runtime sibling dependency.
export const speedFixtures = [
	{
		name: "warmup, first-chunk omission, reported usage and weighted fallback across tools",
		steps: [
			["addDelta", ["", 0], undefined],
			["addDelta", ["large first chunk ignored", 10000], undefined],
			["addDelta", ["abcdefgh", 10200], undefined],
			["addDelta", ["abcd", 10499], undefined],
			["addDelta", ["abcd", 10500], 8],
			["addDelta", ["abcdefghijklmnopqrst", 11000], 9],
			["endCall", [41], 40],
			["beginCall", [], undefined],
			["addDelta", ["first", 60000], undefined],
			["addDelta", ["x".repeat(40), 62000], 5],
			["endCall", [undefined], 50 / 3],
		],
	},
	{
		name: "five-second inclusive boundary, empty deltas and zero-usage fallback",
		steps: [
			["addDelta", ["first", 0], undefined],
			["addDelta", ["x".repeat(40), 1000], 10],
			["addDelta", ["x".repeat(40), 5000], 4],
			["addDelta", ["x".repeat(40), 6000], 6],
			["addDelta", ["", 6001], 4],
			["addDelta", ["", 11001], undefined],
			["endCall", [0], 5],
		],
	},
	{
		name: "unmeasurable calls, zero post-first tokens and short calls",
		steps: [
			["endCall", [100], undefined],
			["addDelta", ["only chunk", 0], undefined],
			["endCall", [100], undefined],
			["addDelta", ["first", 1000], undefined],
			["addDelta", ["abcd", 1000], undefined],
			["endCall", [100], undefined],
			["addDelta", ["first", 2000], undefined],
			["addDelta", ["abcd", 2100], undefined],
			["endCall", [1], undefined],
			["addDelta", ["first", 3000], undefined],
			["addDelta", ["abcd", 3100], undefined],
			["endCall", [3], 20],
			["endCall", [1000], 20],
		],
	},
	{
		name: "UTF-16 character counts and unavailable provider usage",
		steps: [
			["addDelta", ["first", 0], undefined],
			["addDelta", ["😀😀", 1000], 1],
			["endCall", [NaN], 1],
			["addDelta", ["first", 2000], undefined],
			["addDelta", ["abcdefgh", 4000], 1],
			["endCall", [Infinity], 1],
			["addDelta", ["first", 5000], undefined],
			["addDelta", ["abcd", 6000], 1],
			["endCall", [-1], 1],
		],
	},
];
