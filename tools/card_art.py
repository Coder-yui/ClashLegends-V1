"""Install selected card art or check the files used by the V1 interfaces."""
import argparse
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import re
import tempfile

from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[1]
MEDIA = ROOT / "web/public/media"
REGISTRY = ROOT / "content/card_art.json"


def read(path):
    return json.loads(path.read_text())


def identities():
    cards = {c["id"]: c for c in read(ROOT / "content/catalog.json")["cards"]}
    rules = read(ROOT / "content/battle_rules.json")
    extras = {key for key, rule in rules.items()
              if rule.get("selectable") is False and "hp" in rule}
    return cards, extras


def atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as f:
        temp = Path(f.name)
    try:
        temp.write_bytes(data)
        temp.chmod(0o644)
        temp.replace(path)
    finally:
        temp.unlink(missing_ok=True)


def immutable(path, data):
    if path.exists():
        if path.read_bytes() != data:
            raise ValueError(f"同名资源内容不同：{path}")
    else:
        atomic(path, data)


def install(args):
    cards, extras = identities()
    if args.card not in cards.keys() | extras or not re.fullmatch(r"[a-z0-9_-]+", args.card):
        raise ValueError(f"未知卡牌或衍生物 ID：{args.card}")
    original = args.image.read_bytes()
    with Image.open(io.BytesIO(original)) as decoded:
        if args.kind == "photo" and (decoded.format != "PNG" or decoded.size != (308, 560)):
            raise ValueError("摄影成片须为 308×560 PNG")
        image = ImageOps.exif_transpose(decoded).convert("RGBA")
        if not image.getchannel("A").getbbox():
            raise ValueError("成片完全透明")
        image.thumbnail((1024, 1536), Image.Resampling.LANCZOS)
        encoded = io.BytesIO()
        image.save(encoded, "WEBP", quality=92, method=6)
    data = encoded.getvalue()
    filename = args.card + "-" + hashlib.sha256(data).hexdigest()[:16] + ".webp"
    entry = {"kind": args.kind, "source": args.source or args.image.name,
             "sourceSha256": hashlib.sha256(original).hexdigest(),
             "image": "/play/media/card-art/" + filename}
    recipe_data = None
    if args.recipe:
        recipe_data = args.recipe.read_bytes()
        shot = json.loads(recipe_data)
        if (args.kind != "photo" or not isinstance(shot, dict) or shot.get("version") != 1
                or shot.get("card") != args.card or not shot.get("members")):
            raise ValueError("方案和成片的卡牌或版本不匹配")
        entry["recipe"] = (f"content/card-art-recipes/{args.card}-"
                           f"{hashlib.sha256(recipe_data).hexdigest()[:16]}.json")
    # All installs serialize the read/modify/replace of the registry. Publish
    # immutable files first, so a failed install leaves the old face usable.
    fd = os.open(REGISTRY.parent, os.O_RDONLY)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        registry = read(REGISTRY)
        immutable(MEDIA / "card-art" / filename, data)
        if recipe_data is not None:
            immutable(ROOT / entry["recipe"], recipe_data)
        registry[args.card] = entry
        atomic(REGISTRY, (json.dumps(registry, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode())
    finally:
        os.close(fd)
    print(args.card, entry["image"])


def public_file(url):
    prefix = "/play/media/"
    if not url.startswith(prefix):
        raise ValueError(f"无效资源地址：{url}")
    file = (MEDIA / url[len(prefix):]).resolve()
    if not file.is_relative_to(MEDIA.resolve()):
        raise ValueError(f"无效资源路径：{url}")
    return file


def verify(card):
    cards, extras = identities()
    registry = read(REGISTRY)
    known = cards.keys() | extras
    if set(registry) - known:
        raise ValueError(f"登记中存在未知 ID：{sorted(set(registry) - known)}")
    if card and card not in known:
        raise ValueError(f"未知卡牌或衍生物 ID：{card}")
    metadata = read(ROOT / "web/src/preparation-data.json")
    for key in ([card] if card else sorted(known)):
        entry = registry.get(key)
        if entry:
            path = public_file(entry["image"])
            digest = hashlib.sha256(path.read_bytes()).hexdigest()[:16]
            if path != MEDIA / "card-art" / f"{key}-{digest}.webp":
                raise ValueError(f"{key} 卡面与登记的哈希不符")
            if "recipe" in entry and read(ROOT / entry["recipe"]).get("card") != key:
                raise ValueError(f"{key} 方案 ID 不匹配")
            paths = [path]
        elif key in cards:
            paths = [public_file(cards[key]["image"])]
            if portrait := metadata.get(key, {}).get("portrait"):
                paths.append(public_file(portrait))
        else:
            paths = [ROOT / "web/src/workbench-portraits" / (key + ".webp")]
        for path in paths:
            with Image.open(path) as image:
                image.load()
                if image.format != "WEBP" or (entry and entry["kind"] == "photo" and image.size != (308,560)):
                    raise ValueError(f"卡面格式或尺寸异常：{path}")
        if card:
            print(key, *[p.relative_to(ROOT) for p in paths])
    print(f"已核对 {1 if card else len(known)} 个对象")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    add = commands.add_parser("install", help="登记选定的正式图片，制作独立 WebP")
    add.add_argument("card")
    add.add_argument("image", type=Path)
    add.add_argument("--kind", choices=("photo", "original"), required=True)
    add.add_argument("--source", help="原始素材包或可追溯来源")
    add.add_argument("--recipe", type=Path, help="摄影棚导出的构图 JSON")
    check = commands.add_parser("verify", help="校验一张卡或全部正式卡面")
    check.add_argument("card", nargs="?")
    args = parser.parse_args()
    try:
        if args.command == "install":
            install(args)
        else:
            verify(args.card)
    except (OSError, ValueError, KeyError) as err:
        parser.exit(1, str(err) + "\n")


if __name__ == "__main__":
    main()
