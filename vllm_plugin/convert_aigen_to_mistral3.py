"""Convert Aigen-R0-3B weights to Ministral/Mistral3 format.

Renames weight keys to match the official Mistral3ForConditionalGeneration layout,
copies missing projector weights (norm, patch_merger) from Ministral-3-3B-Reasoning-2512,
and splits into 2 sharded safetensors files.

Usage:
    python convert_aigen_to_mistral3.py [--dry-run]
"""

import argparse
import json
import os
import re
import shutil
from collections import OrderedDict
from pathlib import Path

import torch
from safetensors.torch import load_file, save_file


# ── Paths ──────────────────────────────────────────────────────────
MODELS_DIR = Path(__file__).resolve().parent.parent.parent / "models"
AIGEN_DIR = MODELS_DIR / "Aigen-R0-3B"
MINISTRAL_DIR = MODELS_DIR / "Ministral-3-3B-Reasoning-2512"

AIGEN_SAFETENSORS = AIGEN_DIR / "model.safetensors"
AIGEN_BACKUP = AIGEN_DIR / "model.safetensors.bak"

OUT_SHARD1 = AIGEN_DIR / "model-00001-of-00002.safetensors"
OUT_SHARD2 = AIGEN_DIR / "model-00002-of-00002.safetensors"
OUT_INDEX = AIGEN_DIR / "model.safetensors.index.json"


# ── Key renaming rules ─────────────────────────────────────────────

# Order matters: rules are applied sequentially.
KEY_RENAME_RULES = [
    # Vision tower: structural renames (must come before prefix rules)
    # layers → transformer.layers
    (re.compile(r"^vision_tower\.layers\."), "vision_tower.transformer.layers."),
    # self_attn → attention (vision only, after transformer.layers rename)
    (re.compile(r"(vision_tower\.transformer\.layers\.\d+\.)self_attn\."), r"\1attention."),
    # input_layernorm → attention_norm
    (re.compile(r"(vision_tower\.transformer\.layers\.\d+\.)input_layernorm\."), r"\1attention_norm."),
    # post_attention_layernorm → ffn_norm
    (re.compile(r"(vision_tower\.transformer\.layers\.\d+\.)post_attention_layernorm\."), r"\1ffn_norm."),
    # mlp → feed_forward (vision only)
    (re.compile(r"(vision_tower\.transformer\.layers\.\d+\.)mlp\."), r"\1feed_forward."),
    # patch_embedding.proj → patch_conv
    (re.compile(r"^vision_tower\.patch_embedding\.proj\."), "vision_tower.patch_conv."),
    # norm → ln_pre
    (re.compile(r"^vision_tower\.norm\."), "vision_tower.ln_pre."),

    # Text backbone: model.* → language_model.model.*
    (re.compile(r"^model\."), "language_model.model."),

    # Note: lm_head not present (tie_word_embeddings=true)
    # log_variance_head.* and multi_modal_projector.* pass through unchanged
]


def rename_key(key: str) -> str:
    """Apply renaming rules sequentially to a weight key."""
    for pattern, replacement in KEY_RENAME_RULES:
        key = pattern.sub(replacement, key)
    return key


def get_missing_weights(ministral_dir: Path) -> dict[str, torch.Tensor]:
    """Load weights from Ministral that are missing in Aigen-R0-3B."""
    missing_keys = [
        "multi_modal_projector.norm.weight",
        "multi_modal_projector.patch_merger.merging_layer.weight",
    ]

    # Find which shard has each missing key
    index_path = ministral_dir / "model.safetensors.index.json"
    with open(index_path) as f:
        index = json.load(f)

    result = {}
    shards_to_load = {}
    for key in missing_keys:
        shard = index["weight_map"].get(key)
        if shard is None:
            print(f"  WARNING: {key} not found in Ministral index")
            continue
        if shard not in shards_to_load:
            shards_to_load[shard] = []
        shards_to_load[shard].append(key)

    for shard_name, keys in shards_to_load.items():
        shard_path = ministral_dir / shard_name
        print(f"  Loading {shard_name} for keys: {keys}")
        shard_data = load_file(str(shard_path))
        for key in keys:
            if key in shard_data:
                result[key] = shard_data[key]
                print(f"    OK {key}: shape={shard_data[key].shape}, dtype={shard_data[key].dtype}")
            else:
                print(f"    MISSING {key}: NOT FOUND in shard")

    return result


def split_into_shards(
    tensors: dict[str, torch.Tensor], max_shard_bytes: int = 5_000_000_000
) -> list[dict[str, torch.Tensor]]:
    """Split tensors into shards, each under max_shard_bytes."""
    shards = []
    current_shard = OrderedDict()
    current_size = 0

    for key in sorted(tensors.keys()):
        tensor = tensors[key]
        tensor_bytes = tensor.nelement() * tensor.element_size()

        if current_size + tensor_bytes > max_shard_bytes and current_shard:
            shards.append(current_shard)
            current_shard = OrderedDict()
            current_size = 0

        current_shard[key] = tensor
        current_size += tensor_bytes

    if current_shard:
        shards.append(current_shard)

    return shards


def main():
    parser = argparse.ArgumentParser(description="Convert Aigen-R0-3B to Mistral3 format")
    parser.add_argument("--dry-run", action="store_true", help="Print key mappings without writing files")
    args = parser.parse_args()

    print("=" * 60)
    print("Aigen-R0-3B -> Mistral3 Weight Conversion")
    print("=" * 60)

    # Validate paths
    if not AIGEN_SAFETENSORS.exists():
        print(f"ERROR: {AIGEN_SAFETENSORS} not found")
        return
    if not MINISTRAL_DIR.exists():
        print(f"ERROR: {MINISTRAL_DIR} not found")
        return

    # Step 1: Load Aigen weights
    print(f"\n[1/5] Loading Aigen-R0-3B weights from {AIGEN_SAFETENSORS.name}...")
    aigen_tensors = load_file(str(AIGEN_SAFETENSORS))
    print(f"  Loaded {len(aigen_tensors)} tensors")

    # Step 2: Rename keys
    print(f"\n[2/5] Renaming weight keys...")
    renamed = OrderedDict()
    rename_log = []
    for old_key in sorted(aigen_tensors.keys()):
        new_key = rename_key(old_key)
        renamed[new_key] = aigen_tensors[old_key]
        if old_key != new_key:
            rename_log.append((old_key, new_key))

    print(f"  {len(rename_log)} keys renamed, {len(aigen_tensors) - len(rename_log)} unchanged")
    for old, new in rename_log[:10]:
        print(f"    {old}")
        print(f"      -> {new}")
    if len(rename_log) > 10:
        print(f"    ... and {len(rename_log) - 10} more")

    # Step 3: Add missing weights from Ministral
    print(f"\n[3/5] Loading missing weights from Ministral...")
    missing = get_missing_weights(MINISTRAL_DIR)
    for key, tensor in missing.items():
        renamed[key] = tensor
    print(f"  Added {len(missing)} missing weights")

    # Step 4: Validate against Ministral index
    print(f"\n[4/5] Validating against Ministral key structure...")
    with open(MINISTRAL_DIR / "model.safetensors.index.json") as f:
        ministral_keys = set(json.load(f)["weight_map"].keys())

    our_keys = set(renamed.keys())
    # log_variance_head is Aigen-specific, not in Ministral
    aigen_specific = {k for k in our_keys if k.startswith("log_variance_head.")}
    common = our_keys - aigen_specific

    in_both = common & ministral_keys
    only_ours = common - ministral_keys
    only_ministral = ministral_keys - common

    print(f"  Ministral keys:    {len(ministral_keys)}")
    print(f"  Our keys:          {len(our_keys)} ({len(aigen_specific)} Aigen-specific)")
    print(f"  Matching:          {len(in_both)}")
    if only_ours:
        print(f"  Only in ours:      {len(only_ours)}")
        for k in sorted(only_ours)[:5]:
            print(f"    {k}")
    if only_ministral:
        print(f"  Only in Ministral: {len(only_ministral)}")
        for k in sorted(only_ministral)[:5]:
            print(f"    {k}")

    if args.dry_run:
        print("\n[DRY RUN] No files written.")
        return

    # Step 5: Split and save
    print(f"\n[5/5] Splitting into 2 shards and saving...")

    # Backup original
    if not AIGEN_BACKUP.exists():
        print(f"  Backing up original → {AIGEN_BACKUP.name}")
        shutil.copy2(AIGEN_SAFETENSORS, AIGEN_BACKUP)
    else:
        print(f"  Backup already exists: {AIGEN_BACKUP.name}")

    shards = split_into_shards(renamed, max_shard_bytes=5_000_000_000)
    num_shards = len(shards)
    print(f"  Split into {num_shards} shards")

    # Build index and save shards
    weight_map = {}
    total_size = 0
    total_params = 0
    shard_names = []

    for i, shard in enumerate(shards):
        shard_name = f"model-{i+1:05d}-of-{num_shards:05d}.safetensors"
        shard_path = AIGEN_DIR / shard_name
        shard_names.append(shard_name)

        shard_size = sum(t.nelement() * t.element_size() for t in shard.values())
        shard_params = sum(t.nelement() for t in shard.values())
        total_size += shard_size
        total_params += shard_params

        print(f"  Saving {shard_name}: {len(shard)} tensors, {shard_size / 1e9:.2f} GB")
        save_file(shard, str(shard_path))

        for key in shard:
            weight_map[key] = shard_name

    # Save index
    index = {
        "metadata": {
            "total_parameters": total_params,
            "total_size": total_size,
        },
        "weight_map": OrderedDict(sorted(weight_map.items())),
    }
    with open(OUT_INDEX, "w") as f:
        json.dump(index, f, indent=2)
    print(f"  Saved {OUT_INDEX.name}")

    # Remove original single file (backup exists)
    AIGEN_SAFETENSORS.unlink()
    print(f"  Removed original {AIGEN_SAFETENSORS.name} (backup: {AIGEN_BACKUP.name})")

    print(f"\n{'=' * 60}")
    print(f"Done! {total_params} parameters, {total_size / 1e9:.2f} GB total")
    print(f"Files:")
    for name in shard_names:
        print(f"  {AIGEN_DIR / name}")
    print(f"  {OUT_INDEX}")
    print(f"Backup: {AIGEN_BACKUP}")


if __name__ == "__main__":
    main()
