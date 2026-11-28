"""Build workbench labels from hash-matched reference audio production records."""
import hashlib
import json
from pathlib import Path


def local_records(folder):
    """Newer cards can have a per-card manifest outside the original-gain index."""
    records = {}
    for path in sorted(folder.glob("*manifest.json")):
        data = json.loads(path.read_text())
        if isinstance(data, list):
            rows = data
        elif isinstance(data.get("events"), dict):
            rows = [
                row for event in data["events"].values() if isinstance(event, dict)
                for row in event.get("files", [])
            ]
        else:
            rows = data.get("files", data.get("entries", []))
        for row in rows:
            if not isinstance(row, dict) or not row.get("sha256"):
                continue
            name = row.get("file") or row.get("path") or row.get("output")
            if not name:
                continue
            inherited = data.get("processing") if isinstance(data, dict) else None
            # These two documented direct exports record the TXTP on each file
            # and the production settings only at the package level.
            if (folder.name in {"void_gate", "voidfish_ranged"} and row.get("txtp")
                    and data.get("wwiser_gain") == "0dB" and data.get("post_gain_db") == 0):
                inherited = "original TXTP; zero post gain"
            records[Path(name).name, row["sha256"]] = {
                "processing": inherited, **row,
            }
    return records


def recipe_parts(row):
    """Only production edits belong here. Playback compensation comes from the live event."""
    processing = row["processing"]
    if isinstance(processing, str):
        processing = {"description": processing}
    if not isinstance(processing, dict):
        raise ValueError(f"Missing audio processing record: {row}")
    parts = [processing[key] for key in ("description", "notes", "method") if processing.get(key)]
    if filters := processing.get("filters"):
        parts.append(",".join(filters))
    if graph := processing.get("filter_complex"):
        parts.append(graph)
    if "omit W grunt layer" in row.get("selection_note", ""):
        parts.append(row["selection_note"])
    return parts, processing


def production_note(row, translations):
    parts, processing = recipe_parts(row)
    notes = []
    for part in parts:
        if part not in translations:
            raise ValueError(f"Unreviewed audio recipe: {part}")
        if translations[part]:
            notes.append(translations[part])
    envelope = row.get("death_envelope") or processing.get("death_envelope")
    if envelope:
        notes.append(
            f"截取前 {envelope['keep_seconds']:g} 秒，"
            f"从 {envelope['fade_start_seconds']:g} 秒起线性淡出 {envelope['fade_seconds']:g} 秒"
        )
    if "source_interval_seconds" in processing:
        # Two full-length Trundle events record their interval too. The decoded
        # source hash distinguishes them from the two edited slices.
        if not any(s.get("decoded_sha256") == row["sha256"] for s in row["source_events"]):
            start, end = processing["source_interval_seconds"]
            notes.append(f"截取 {start:g}–{end:.5g} 秒")
            if processing.get("fade_in_seconds"):
                notes.append(f"淡入 {processing['fade_in_seconds']:g} 秒")
            if processing.get("fade_out_seconds"):
                notes.append(f"淡出 {processing['fade_out_seconds']:g} 秒")
            if processing.get("time_stretch", 1) != 1:
                notes.append(f"变速 {processing['time_stretch']:g} 倍")
    for keys, title in [
        (("tool_master_gain_db", "wwiser_master_gain_db"), "导出增益"),
        (("post_gain_db", "gain_db"), "后期增益"),
    ]:
        value = next((record[key] for record in (processing, row) for key in keys if key in record), 0)
        if value:
            notes.append(f"{title} {value:+g} dB")
    if processing.get("normalization"):
        notes.append("响度归一化")
    return "；".join(dict.fromkeys(notes))


def build_provenance(source, paths):
    audio = source / "assets/audio"
    entries = json.loads((audio / "original_gain_manifest.json").read_text())["entries"]
    indexed = {(row["file"], row["sha256"]): row for row in entries}
    per_folder = {}
    translations = json.loads(Path(__file__).with_name("audio_recipe_labels.json").read_text())
    clips = [None] * len(paths)
    for uri, index in paths.items():
        relative = uri.removeprefix("res://")
        file = source / relative
        digest = hashlib.sha256(file.read_bytes()).hexdigest()
        row = indexed.get((relative, digest))
        if row is None:
            if file.parent not in per_folder:
                per_folder[file.parent] = local_records(file.parent)
            row = per_folder[file.parent].get((file.name, digest))
        if row is None:
            raise ValueError(f"No matching audio source record: {relative} ({digest})")
        clip = {"file": str(file.relative_to(audio))}
        if row.get("event", "").startswith("User-provided Clash Royale Freeze SFX"):
            clip["external"] = "《皇室战争》冰冻法术（用户提供）"
        if note := production_note(row, translations):
            clip["edit"] = note
        clips[index] = clip
    return clips
