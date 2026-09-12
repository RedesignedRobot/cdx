# Native-thread token accounting reproduction

The existing cdx handler subtracts one baseline and one previous counter across interleaved thread IDs. The calculation below reproduces its ledger total, then repeats it with separate thread baselines. This is log arithmetic, not a test run.

| Lane | Threads | Ledger input | Per-thread input | Excess input | Ledger output | Per-thread output |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| r28-master r1 | 4 | 15,629,171 | 7,127,152 | 8,502,019 | 65,791 | 35,836 |
| cdx-visibility r1 | 2 | 6,183,755 | 3,955,231 | 2,228,524 | 36,079 | 21,279 |

Source: /Users/mas/code/cdx/cdx.ts:2612-2645, handleCodexEvent. Input events are thread/tokenUsage/updated with params.threadId and tokenUsage.total/last. Derive each thread baseline from its first total minus first last, then subtract that baseline from its final total. Sum threads only after deriving their deltas. Existing data and corrected counts are both retained.

Raw counter semantics differ by engine. GPT cached input is included in input. Gemini cache_read_tokens is separate from input_tokens. Do not add GPT cached counts to input or price this table as uncached input.
