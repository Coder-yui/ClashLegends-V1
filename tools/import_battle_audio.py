"""Build lossless web banks from the audio definitions evaluated by the reference game."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import wave
from collections import defaultdict

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT.parent / "ClashLegends"
OUT = ROOT / "web/public/media/audio"
MANIFEST = ROOT / "web/src/battle-audio-banks.json"
RATE = 44100


def read_pcm(path):
    try:
        with wave.open(str(path)) as audio:
            if (audio.getframerate(), audio.getsampwidth()) == (RATE, 2):
                return audio.getnchannels(), audio.readframes(audio.getnframes())
    except wave.Error:
        pass
    channels = int(subprocess.check_output([
        "ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
        "stream=channels", "-of", "csv=p=0", str(path)
    ]))
    return channels, subprocess.check_output([
        "ffmpeg", "-v", "error", "-i", str(path), "-ar", str(RATE), "-f", "s16le", "-"
    ])


def event_index(variants, profiles):
    # The host schedules native phase boundaries; only the browser needs PCM pools.
    groups = {}
    for key, index in variants.items():
        card, form, team = key.split("/")
        groups.setdefault(card, {}).setdefault(form, {})[team] = index
    events = [{key: spec.get("action_time") for key, spec in p.get("events", {}).items()}
              for p in profiles]
    return {"variants": groups, "profiles": events}


def verify_banks(manifest, paths):
    if len(manifest["clips"]) != len(paths):
        raise ValueError("Clip count differs from the reference project")
    groups = defaultdict(list)
    for source, index in paths.items():
        bank, offset, length = manifest["clips"][index]
        groups[bank].append((SOURCE / source.removeprefix("res://"), offset, length))
    if set(groups) != set(range(len(manifest["files"]))):
        raise ValueError("Bank references disagree with the manifest")
    for bank, entries in groups.items():
        file = OUT / manifest["files"][bank]
        if not file.stem.endswith(hashlib.sha256(file.read_bytes()).hexdigest()[:12]):
            raise ValueError(f"Bank hash mismatch: {file}")
        pcm = subprocess.check_output(["ffmpeg", "-v", "error", "-i", str(file), "-f", "s16le", "-"])
        for source, offset, length in entries:
            channels, expected = read_pcm(source)
            stride = 2 * channels
            if expected != pcm[offset*stride:(offset+length)*stride]:
                raise ValueError(f"PCM mismatch: {source}")
    print(f"Verified {len(paths)} reference clips in {len(groups)} FLAC banks")


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify", action="store_true", help="compare the existing project data and packed PCM without rewriting them")
    args=parser.parse_args()
    godot = os.getenv("GODOT") or shutil.which("godot") or "/Applications/Godot.app/Contents/MacOS/Godot"
    with tempfile.TemporaryDirectory() as tmp:
        output = Path(tmp) / "profiles.json"
        subprocess.run([godot, "--headless", "--path", str(SOURCE), "--log-file",
                        str(Path(tmp) / "export.log"), "--script", str(ROOT / "tools/export_battle_audio.gd"),
                        "--", str(output)], check=True)
        export = json.loads(output.read_text())
        legacy = export["profiles"]
    rules = json.loads((ROOT / "content/battle_rules.json").read_text())
    actions = {}
    for name, action in export["actions"].items():
        card, form, skill_name = name.split("/", 2)
        for skill in rules[card].get("active_skills", []):
            if skill.get("name") == skill_name:
                actions[f"{card}/{form}/{skill_name}"] = action
                if skill.get("id"):
                    actions[f"{card}/{form}/{skill['id']}"] = action
    old = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {}
    old_files = set(old["files"] if "files" in old else (b["file"] for b in old.values()))
    paths = {}
    def resolve(value):
        if isinstance(value, str) and value.startswith("res://"):
            return paths.setdefault(value, len(paths))
        if isinstance(value, list):
            return [resolve(item) for item in value]
        if isinstance(value, dict):
            return {resolve(key): resolve(item) for key, item in value.items()}
        return value

    variants, profiles, unique = {}, [], {}
    for name, profile in sorted(legacy.items()):
        data = resolve(profile)
        signature = json.dumps(data, sort_keys=True)
        if signature not in unique:
            unique[signature] = len(profiles)
            profiles.append(data)
        variants[name] = unique[signature]
    events = event_index(variants, profiles)
    actions_file = ROOT / "content/audio_actions.json"
    events_file = ROOT / "content/audio_events.json"
    if args.verify:
        if old.get("variants") != variants or old.get("profiles") != json.loads(json.dumps(profiles)):
            raise ValueError("Web profiles differ from the reference configuration")
        if json.loads(actions_file.read_text()) != actions or json.loads(events_file.read_text()) != events:
            raise ValueError("Host indices differ from the reference configuration")
        verify_banks(old, paths)
        return
    actions_file.write_text(json.dumps(actions, ensure_ascii=False, indent=2) + "\n")
    events_file.write_text(json.dumps(events, separators=(",", ":")) + "\n")
    groups = defaultdict(list)
    for src, index in paths.items():
        path = SOURCE / src.removeprefix("res://")
        groups[path.parent].append((path, index))
    files, clips = [], [None] * len(paths)
    OUT.mkdir(parents=True, exist_ok=True)
    for folder, entries in sorted(groups.items()):
        buffers = {}
        for path, index in entries:
            channels, pcm = read_pcm(path)
            if channels not in (1, 2) or not pcm:
                raise ValueError(f"Invalid audio: {path}")
            buf, offsets = buffers.setdefault(channels, (bytearray(), []))
            stride = 2 * channels
            offsets.append((index, len(buf) // stride, len(pcm) // stride))
            buf.extend(pcm)
            buf.extend(bytes(441 * stride))
        for channels, (pcm, offsets) in buffers.items():
            encoded = subprocess.run([
                "ffmpeg", "-loglevel", "error", "-f", "s16le", "-ar", str(RATE),
                "-ac", str(channels), "-i", "pipe:0", "-f", "flac", "pipe:1"
            ], input=pcm, capture_output=True, check=True).stdout
            digest = hashlib.sha256(encoded).hexdigest()[:12]
            label = "-".join(folder.relative_to(SOURCE / "assets/audio").parts[-2:])
            name = f"{label}-{digest}.flac"
            (OUT / name).write_bytes(encoded)
            for index, start, length in offsets:
                clips[index] = [len(files), start, length]
            files.append(name)
    manifest = dict(files=files, clips=clips, variants=variants, profiles=profiles)
    MANIFEST.write_text(json.dumps(manifest, separators=(",", ":"), ensure_ascii=False) + "\n")
    for filename in old_files - set(files):
        previous = OUT / filename
        if previous.exists() and hashlib.sha256(previous.read_bytes()).hexdigest()[:12] in previous.name:
            previous.unlink()
    print(f"{len(variants)} configurations, {len(profiles)} unique profiles, {len(clips)} clips, {len(files)} banks")


if __name__ == "__main__":
    main()
