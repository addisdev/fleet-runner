# Third-party notices

Nothing third-party is committed to this repository, and the agent itself has
no runtime dependencies — it is Node's standard library and the tools already
on the machine. This file records what it links or shells out to, so the terms
travel with the source.

| Component | How it gets here | License |
|---|---|---|
| [tsx](https://github.com/privatenumber/tsx) + [esbuild](https://github.com/evanw/esbuild) | `npm install`, dev dependency — how TypeScript runs without a build step | MIT |
| [TypeScript](https://github.com/microsoft/TypeScript) | `npm install`, dev dependency — typecheck only | Apache-2.0 |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) | Not bundled. The `llama.cpp` backend executes a `llama-bench` binary you built or installed yourself, discovered on PATH or named by `FLEET_LLAMA_BENCH`. | MIT — Copyright (c) 2023-2026 The ggml authors |
| [mlx-lm](https://github.com/ml-explore/mlx-lm) | Not bundled. Probed with `python3 -c "import mlx_lm"` to decide whether to declare the capability. | MIT |
| `system_profiler`, `sysctl`, `pmset`, `ioreg`, `caffeinate`, `wmic`, `lspci`, `upower`, `nvidia-smi` | System tools on the host, shelled out to for the descriptor and the beacon. Every one of them is optional: a missing tool is a null field. | Their platform's terms |

For comparable llama.cpp numbers across the fleet, the binary this agent shells
out to should be built from the commit the phone runners pin — see
[`runner-ios`](../runner-ios)'s notices.
Two machines running different llama.cpp builds produce two numbers that are
not each other's comparison, which is the same reason the phones pin at all.

Model weights are never stored in this repository. They are fetched from the
collector's artifact store by content hash and verified before use, so a
model's license is the concern of whoever put it on the shelf.
