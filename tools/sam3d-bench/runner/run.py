"""Run SAM 3D Objects on benchmark cases and save its raw outputs.

UNTESTED ON A GPU. Written against facebookresearch/sam-3d-objects at the commit pinned in
the Dockerfile (notebook/inference.py and demo.py there); it has not run end to end yet.
`--dry-run` (no torch, no GPU) validates the cases and prints the plan.

Per case, into <out>/<case_id>/:
  splat.ply            output["gs"].save_ply(): Gaussians in the model's object frame
  splat-posed.ply      make_scene(output): Gaussians moved by the predicted layout
                       (rotation, translation, scale) into the model's camera/scene frame
  layout.json          rotation / translation / scale as predicted, when present
  output-keys.json     every key of the output dict with its type and shape, so the first
                       real run documents what the pipeline returns
  reconstruction.json  status, timing, GPU, versions; on failure the error, and no PLYs
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import signal
import subprocess
import sys
import time
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from sam3d_bench.case_format import CaseError, find_cases, load_case  # noqa: E402


class CaseTimeout(Exception):
    pass


def _alarm(_signum, _frame):
    raise CaseTimeout()


def describe(value) -> dict:
    shape = getattr(value, "shape", None)
    out = {"type": type(value).__name__}
    if shape is not None:
        out["shape"] = list(shape)
    if isinstance(value, (list, tuple)):
        out["len"] = len(value)
    return out


def to_list(value):
    if hasattr(value, "detach"):
        value = value.detach().float().cpu().numpy()
    return value.tolist() if hasattr(value, "tolist") else value


def git_rev(path: Path) -> str | None:
    try:
        return subprocess.run(["git", "-C", str(path), "rev-parse", "HEAD"], capture_output=True,
                              text=True, timeout=10, check=True).stdout.strip()
    except (subprocess.SubprocessError, FileNotFoundError):
        return None


def plan_cases(cases_root: Path, only: set[str] | None) -> tuple[list, list[str]]:
    dirs = [cases_root] if (cases_root / "ground-truth.json").is_file() else find_cases(cases_root)
    cases, problems = [], []
    for d in dirs:
        if only and d.name not in only:
            continue
        try:
            cases.append(load_case(d, require_image=True))
        except CaseError as e:
            problems.append(str(e))
    if only:
        missing = only - {c.case_id for c in cases} - {Path(p.split(":")[0]).name for p in problems}
        problems += [f"{m}: no such case under {cases_root}" for m in sorted(missing)]
    return cases, problems


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--cases", required=True, type=Path, help="a case folder or a folder of cases")
    ap.add_argument("--out", required=True, type=Path, help="output root (runs/<label>)")
    ap.add_argument("--only", nargs="*", help="case ids to run (default: all)")
    ap.add_argument("--sam3d-root", type=Path, default=Path(os.environ.get("SAM3D_ROOT", "/opt/sam-3d-objects")))
    ap.add_argument("--config", type=Path, help="pipeline.yaml (default: <sam3d-root>/checkpoints/hf/pipeline.yaml)")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--timeout", type=int, default=900, help="seconds per case")
    ap.add_argument("--overwrite", action="store_true", help="re-run cases that already have splat.ply")
    ap.add_argument("--dry-run", action="store_true", help="validate cases and print the plan; no GPU")
    args = ap.parse_args(argv)

    cases, problems = plan_cases(args.cases, set(args.only) if args.only else None)
    for p in problems:
        print(f"INVALID {p}", file=sys.stderr)
    todo = [c for c in cases if args.overwrite or not (args.out / c.case_id / "splat.ply").is_file()]
    print(f"{len(cases)} valid cases, {len(todo)} to run, {len(problems)} invalid")
    if args.dry_run:
        for c in todo:
            print(f"  would run {c.case_id}: {c.image.name} + {c.mask.name} -> {args.out / c.case_id}")
        return 1 if problems else 0
    if not todo:
        return 1 if problems else 0

    config = args.config or args.sam3d_root / "checkpoints" / "hf" / "pipeline.yaml"
    if not config.is_file():
        print(f"missing checkpoint config {config}: download the gated checkpoints (README)", file=sys.stderr)
        return 2

    # Heavy imports only past this point: torch, pytorch3d, kaolin, the SAM 3D pipeline.
    import numpy as np
    import torch
    from PIL import Image

    if not torch.cuda.is_available():
        print("CUDA is not available; SAM 3D Objects needs an NVIDIA GPU with >= 32 GB", file=sys.stderr)
        return 2
    sys.path.insert(0, str(args.sam3d_root / "notebook"))
    os.chdir(args.sam3d_root)
    from inference import Inference, make_scene  # type: ignore[import-not-found]

    t0 = time.time()
    model = Inference(str(config), compile=False)
    load_s = time.time() - t0
    env = {
        "sam3d_commit": git_rev(args.sam3d_root),
        "config": str(config),
        "torch": torch.__version__,
        "cuda": torch.version.cuda,
        "gpu": torch.cuda.get_device_name(0),
        "gpu_total_gb": round(torch.cuda.get_device_properties(0).total_memory / 2**30, 1),
        "host": platform.node(),
        "model_load_s": round(load_s, 1),
    }
    print(json.dumps(env))

    failed = 0
    signal.signal(signal.SIGALRM, _alarm)
    for case in todo:
        out = args.out / case.case_id
        out.mkdir(parents=True, exist_ok=True)
        for stale in ("splat.ply", "splat-posed.ply", "layout.json"):
            (out / stale).unlink(missing_ok=True)
        record = {"case_id": case.case_id, "seed": args.seed, **env}
        torch.cuda.reset_peak_memory_stats()
        start = time.time()
        signal.alarm(args.timeout)
        try:
            image = np.array(Image.open(case.image).convert("RGB"), dtype=np.uint8)
            mask = np.array(Image.open(case.mask).convert("L")) > 0
            if image.shape[:2] != mask.shape:
                raise ValueError(f"image {image.shape[:2]} and mask {mask.shape} differ")
            if not mask.any():
                raise ValueError("mask is empty")
            output = model(image, mask, seed=args.seed)
            (out / "output-keys.json").write_text(
                json.dumps({k: describe(v) for k, v in output.items()}, indent=2) + "\n")
            output["gs"].save_ply(str(out / "splat.ply"))
            layout = {k: to_list(output[k]) for k in ("rotation", "translation", "scale") if k in output}
            if layout:
                (out / "layout.json").write_text(json.dumps(layout, indent=2) + "\n")
                make_scene(output).save_ply(str(out / "splat-posed.ply"))
            signal.alarm(0)
            record.update(status="ok", seconds=round(time.time() - start, 1),
                          peak_gpu_gb=round(torch.cuda.max_memory_allocated() / 2**30, 2),
                          files=sorted(p.name for p in out.iterdir()))
            print(f"ok {case.case_id} in {record['seconds']} s")
        except CaseTimeout:
            failed += 1
            record.update(status="failed", error=f"timed out after {args.timeout} s")
            print(f"FAILED {case.case_id}: timeout", file=sys.stderr)
        except Exception as e:  # noqa: BLE001 - one bad case must not stop the batch
            signal.alarm(0)
            failed += 1
            record.update(status="failed", error=f"{type(e).__name__}: {e}",
                          traceback=traceback.format_exc(limit=8))
            print(f"FAILED {case.case_id}: {type(e).__name__}: {e}", file=sys.stderr)
        if record["status"] != "ok":
            for partial in ("splat.ply", "splat-posed.ply", "layout.json"):
                (out / partial).unlink(missing_ok=True)
        (out / "reconstruction.json").write_text(json.dumps(record, indent=2) + "\n")
    print(f"{len(todo) - failed}/{len(todo)} cases ok")
    return 1 if failed or problems else 0


if __name__ == "__main__":
    sys.exit(main())
