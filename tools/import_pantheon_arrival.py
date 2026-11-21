"""Extract the independent arrival spear, silhouette rig and both native clips."""
import argparse
import hashlib
import json
from pathlib import Path
import tempfile

from import_battle_effects import ROOT, NativeAssets, command


def build(source, tools, scb, tmp):
    wad = "Champions/Pantheon.wad.client"
    directory = "assets/characters/pantheon/skins/base/"
    particles = directory + "particles/"
    names = {
        "spear": particles + "pantheon_base_q_hold_spear.scb",
        "color": directory + "pantheon_base_tx_cm.tex",
        "stars": particles + "kassadin_skin05_i_starrybackdrop.tex",
        "proxy": particles + "pantheon_base_spell4_slide.skn",
        "rig": particles + "pantheon_base_spell4_slide.skl",
        "fly": particles + "pantheon_spell4_fly.anm",
        "slide": particles + "pantheon_spell4_slide.anm",
    }
    final = source / "Game/DATA/FINAL"
    index = NativeAssets(final, tools, scb, tmp).index(wad)
    command(tools / "wadtools", "extract", "-i", final / wad, "-o", tmp,
            "--hash", *(index[path] for path in names.values()), "--stats=false")
    paths = {k: tmp / path for k, path in names.items()}
    command("dotnet", scb, paths["spear"])
    command(tools / "lol2gltf", "skn2gltf", "-m", paths["proxy"], "-s", paths["rig"],
            "-a", paths["fly"].parent, "-g", tmp / "silhouette.glb")
    for key in ["color", "stars"]:
        command(tools / "ltk-tex-utils", "decode", paths[key], "-o", tmp / (key+".png"))
    dest = ROOT / "web/public/media/arrival"
    dest.mkdir(parents=True, exist_ok=True)
    outputs = {}
    for key, path in {"spear": paths["spear"].with_suffix(".glb"), "proxy":tmp/"silhouette.glb",
                      "color":tmp/"color.png", "stars":tmp/"stars.png"}.items():
        data = path.read_bytes()
        name = hashlib.sha256(data).hexdigest()[:24] + path.suffix
        (dest/name).write_bytes(data)
        outputs[key] = name
    (ROOT/"web/src/pantheon-arrival-assets.json").write_text(json.dumps({
        "wad":wad,"sourceVersion":json.loads((source/"Game/content-metadata.json").read_text())["version"],
        "inputs":{k:{"path":name,"chunk":index[name],"sha256":hashlib.sha256(paths[k].read_bytes()).hexdigest()} for k,name in names.items()},
        "files":outputs},indent=2)+"\n")


if __name__ == "__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source",type=Path,default=Path.home()/"Downloads/LOL_Asset_Source")
    parser.add_argument("--tools",type=Path,default=Path.home()/"Tools/lol-asset-tools/bin")
    parser.add_argument("--scb",type=Path,default=Path.home()/"Tools/lol-scb-export/bin/Debug/net10.0/lol-scb-export.dll")
    args=parser.parse_args()
    with tempfile.TemporaryDirectory() as temp:
        build(args.source,args.tools,args.scb,Path(temp))
