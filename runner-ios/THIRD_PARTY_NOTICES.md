# Third-party notices

Nothing third-party is committed to this repository. This file records what
the app links when you build it, so the terms travel with the source.

| Component | How it gets here | License |
|---|---|---|
| [llama.cpp](https://github.com/ggml-org/llama.cpp) | You build `llama.xcframework` yourself, from the commit pinned as a submodule in [`runner-android`](../runner-android) (`a94d563`, tag `b10423`). Gitignored here — see the README. | MIT — Copyright (c) 2023-2026 The ggml authors |
| Core ML, Accelerate, SwiftUI | Apple system frameworks, linked from the SDK | Apple SDK terms |

The pinned llama.cpp commit is the same one the Android runner compiles into
its JNI backend. That is deliberate and load-bearing: the two platforms only
produce comparable tok/s because they run the same inference code.

Model weights are never bundled in the app. Runners fetch them from the
collector's artifact store by content hash, so a model's license is the
concern of whoever puts it on the shelf.
