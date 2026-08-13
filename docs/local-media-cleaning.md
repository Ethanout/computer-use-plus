# Local media cleaning

`scripts/trim-local-media.js` processes only local files named by a JSON manifest. It rejects HTTP URLs, does not access browser cookies, and has no Bilibili stream extraction or DRM bypass code.

Example manifest:

```json
{
  "config": { "outputDir": "./trimmed", "concurrency": 1, "retries": 2 },
  "items": [
    { "id": "p01", "input": "D:/legal-media/p01.mp4", "startSeconds": 0, "keepSeconds": 3600 },
    { "id": "p02", "input": "D:/legal-media/p02.mp4", "startSeconds": 0, "endSeconds": 3580 }
  ]
}
```

Run with `node scripts/trim-local-media.js manifest.json --concurrency 1`. The default keeps the first hour, prefers FFmpeg stream copy, and falls back to H.264/AAC re-encoding when the container or keyframes prevent a clean copy. Each item is written to a process-specific `.part-*` file, probed, hashed with SHA-256, and atomically renamed. `trim-state.json` permits restart without reprocessing unchanged completed items; `.log` files retain FFmpeg diagnostics.

The default concurrency is 1 because five-hour source files are I/O-heavy and a stream-copy job is usually bounded by storage/network throughput. Use 2 only on fast SSD storage. A 54-item set trimmed to one hour is about 54 hours of output duration; expected storage is roughly 2-8 GB at common 0.5-2 Mb/s bitrates, while temporary headroom should cover at least one full source file per active worker. The page checked for BV12suS6rEwn exposes 54 public parts with durations about 4:23-5:36 (part 1: 4:45:05), but no authorized direct-download path was used. Obtain files through a platform-provided download or another source where the user has the rights, then place those local paths in the manifest.
