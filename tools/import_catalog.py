"""Refresh the self-contained lobby catalog and WebP assets from local source projects.

Run with Python 3 and Pillow. The source checkouts are only read during import.
"""
import hashlib
import json
from pathlib import Path
import re

from PIL import Image, ImageOps


ROOT = Path(__file__).resolve().parents[1]
WEBSITE = ROOT.parent / "ClashLegendsWeb"
PROMO = ROOT.parent / "ClashLegends-promo-materials"
MEDIA = ROOT / "web/public/media"
CATALOG = ROOT / "content/catalog.json"

DEFAULT_DECK = ["garen", "freeze", "melee_minion_squad", "tombstone",
                "ashe", "xin", "teemo", "gnar"]


def save_art(source: Path, filename: str, bounds: tuple[int, int], quality: int) -> str:
    with Image.open(source) as image:
        image = ImageOps.exif_transpose(image)
        image.thumbnail(bounds, Image.Resampling.LANCZOS)
        image.save(MEDIA / filename, "WEBP", quality=quality, method=6)
    return "/play/media/" + filename


def public_card(card: dict, previous_skills: dict) -> dict:
    card_id = card["id"]
    skills = []
    for skill in card["skills"]:
        # Compiled legacy options are positional. Give each canonical ability an
        # explicit, card-scoped key which survives deck/option reordering.
        slug = re.sub(r"[^a-z0-9]+", "-", skill["name"]["en"].lower()).strip("-")
        key = card_id + "." + slug
        skills.append({
            "image": previous_skills.get(key, {}).get("image", "/play/media/battle/" + key + ".webp"),
            "id": card_id + "." + slug,
            "name": skill["name"]["zh"],
            "description": skill["description"]["zh"],
        })
    if len({skill["id"] for skill in skills}) != len(skills):
        raise ValueError(f"Duplicate skill key for {card_id}")
    image = WEBSITE / "public" / card["image"].lstrip("/")
    result = {
        "id": card_id,
        "name": card["name"]["zh"],
        "description": card["description"]["zh"],
        "type": card["type"],
        "cost": card["values"]["cost"],
        "image": save_art(image, card_id + ".webp", (300, 420), 80),
        "skills": skills,
    }
    if card["cost"] is None:
        if card_id != "mirror":
            raise ValueError(f"Unmapped variable cost for {card_id}")
        result["costLabel"] = "随上张牌"
    return result


def main():
    raw = json.loads((WEBSITE / "content/catalog.json").read_text())
    MEDIA.mkdir(parents=True, exist_ok=True)
    previous = json.loads(CATALOG.read_text()) if CATALOG.exists() else {"cards": []}
    previous_skills = {s["id"]: s for c in previous["cards"] for s in c["skills"]}
    cards = [public_card(card, previous_skills) for card in raw["cards"] if card["selectable"]]
    ids = {card["id"] for card in cards}
    if len(cards) != len(ids) or not set(DEFAULT_DECK) <= ids:
        raise ValueError("Invalid card IDs or default deck")

    # Existing released skill IDs can be referenced by saved presets. Changes
    # require an explicit migration, even if they arose from copy edits.
    if CATALOG.exists():
        previous = json.loads(CATALOG.read_text())
        old = {s["id"] for c in previous["cards"] for s in c["skills"]}
        new = {s["id"] for c in cards for s in c["skills"]}
        if old - new:
            raise ValueError(f"Skill migration required: {sorted(old - new)}")

    shared = PROMO / "00-公共素材"
    rift = save_art(shared / "竞技场与建筑图片/arena_cinematic_concept_16x9.png",
                    "rift.webp", (960, 540), 82)
    save_art(PROMO / "Video03-技能介绍/02-原始素材/sett_haymaker_skill_cover_16x9.png",
             "lobby.webp", (1500, 844), 85)
    save_art(shared / "Logo与品牌/ClashLegends-App图标-水晶王冠.png",
             "crest.webp", (136, 136), 86)

    content = {
        "cards": cards,
        "modes": [{"id": "classic", "name": "经典模式", "mapIds": ["rift"]}],
        "maps": [{"id": "rift", "name": "晴昼峡谷", "image": rift}],
        "defaultDeck": DEFAULT_DECK,
    }
    digest = hashlib.sha256(json.dumps(content, sort_keys=True).encode()).hexdigest()
    version = f"{raw['sourceCommit'][:8]}-{digest[:12]}"
    CATALOG.parent.mkdir(parents=True, exist_ok=True)
    CATALOG.write_text(json.dumps({"version": version, **content},
                                  ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
