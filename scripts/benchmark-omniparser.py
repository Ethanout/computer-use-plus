#!/usr/bin/env python3
"""Benchmark OmniParser v2 detector and Florence icon captioning.

This script is intentionally optional and is not part of the base MCP install.
Run it from an OmniParser checkout with its model weights and a CUDA-enabled
Python environment. It reports warm latency, node count, captions, and peak
GPU memory without sending screenshots anywhere.
"""

from __future__ import annotations

import argparse
import json
import statistics
import time
from pathlib import Path

import torch
from PIL import Image
from ultralytics import YOLO


def percentile(values: list[float], percentile_value: float) -> float:
    ordered = sorted(values)
    index = min(len(ordered) - 1, round((percentile_value / 100) * (len(ordered) - 1)))
    return ordered[index]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("image", type=Path)
    parser.add_argument("--detector", type=Path, required=True)
    parser.add_argument("--caption-model", type=Path)
    parser.add_argument("--processor-model", type=Path)
    parser.add_argument("--warmup", type=int, default=3)
    parser.add_argument("--repeat", type=int, default=10)
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--confidence", type=float, default=0.05)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    if not torch.cuda.is_available():
        raise SystemExit("CUDA is required for a meaningful OmniParser benchmark")
    if args.repeat < 1 or args.warmup < 0:
        raise SystemExit("--warmup must be >= 0 and --repeat must be >= 1")

    image = Image.open(args.image).convert("RGB")
    detector = YOLO(str(args.detector))

    def detect() -> list[list[float]]:
        result = detector.predict(
            image,
            conf=args.confidence,
            imgsz=args.imgsz,
            iou=0.1,
            device=0,
            verbose=False,
        )[0]
        return result.boxes.xyxy.detach().cpu().tolist()

    for _ in range(args.warmup):
        detect()
    torch.cuda.synchronize()
    detector_times: list[float] = []
    boxes: list[list[float]] = []
    for _ in range(args.repeat):
        started = time.perf_counter()
        boxes = detect()
        torch.cuda.synchronize()
        detector_times.append((time.perf_counter() - started) * 1000)

    result: dict[str, object] = {
        "image": str(args.image),
        "image_size": list(image.size),
        "detector_boxes": len(boxes),
        "detector_ms": {
            "p50": statistics.median(detector_times),
            "p95": percentile(detector_times, 95),
            "samples": detector_times,
        },
        "peak_gpu_memory_mb_after_detector": torch.cuda.max_memory_allocated() / 1048576,
    }

    if args.caption_model and args.processor_model:
        from transformers import AutoConfig, AutoModelForCausalLM, AutoProcessor

        processor = AutoProcessor.from_pretrained(
            args.processor_model,
            trust_remote_code=True,
            local_files_only=True,
        )
        config = AutoConfig.from_pretrained(
            args.processor_model,
            trust_remote_code=True,
            local_files_only=True,
        )
        caption_model = AutoModelForCausalLM.from_pretrained(
            args.caption_model,
            config=config,
            torch_dtype=torch.float16,
            trust_remote_code=True,
            local_files_only=True,
        ).to("cuda").eval()
        crops = [
            image.crop(tuple(int(value) for value in box)).resize((64, 64))
            for box in boxes
        ]
        inputs = processor(
            images=crops,
            text=["<CAPTION>"] * len(crops),
            return_tensors="pt",
            do_resize=False,
        ).to(device="cuda", dtype=torch.float16)

        def caption() -> list[str]:
            generated = caption_model.generate(
                input_ids=inputs["input_ids"],
                pixel_values=inputs["pixel_values"],
                max_new_tokens=20,
                num_beams=1,
                do_sample=False,
                use_cache=False,
            )
            return processor.batch_decode(generated, skip_special_tokens=True)

        for _ in range(args.warmup):
            caption()
        torch.cuda.synchronize()
        caption_times: list[float] = []
        captions: list[str] = []
        for _ in range(args.repeat):
            started = time.perf_counter()
            captions = caption()
            torch.cuda.synchronize()
            caption_times.append((time.perf_counter() - started) * 1000)
        result["captions"] = captions
        result["caption_ms_for_all_boxes"] = {
            "p50": statistics.median(caption_times),
            "p95": percentile(caption_times, 95),
            "samples": caption_times,
        }
        result["peak_gpu_memory_mb"] = torch.cuda.max_memory_allocated() / 1048576

    encoded = json.dumps(result, ensure_ascii=False, indent=2)
    print(encoded)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
