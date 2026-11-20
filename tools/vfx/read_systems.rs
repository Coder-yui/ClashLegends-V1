// Build as an example of the pinned ltk-manager-game crate (see import_battle_effects.py).
use ltk_hash::{BinHash, Hash as _};
use ltk_manager_bin::bin_document::BinDocument;
use ltk_manager_game::lookup::ObjectLookup;
use std::{collections::BTreeSet, env, fs, path::Path};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = env::args().skip(1).collect();
    let (wad_path, requests, output) = (&args[0], &args[1], Path::new(&args[2]));
    let mut needed: BTreeSet<u32> = serde_json::from_slice(&fs::read(requests)?)?;
    let mut wad = ltk_wad::Wad::mount(fs::File::open(wad_path)?)?;
    let chunks: Vec<_> = wad.chunks().iter().copied().collect();
    let vfx = BinHash::hash_str("VfxSystemDefinitionData");
    for chunk in chunks {
        if needed.is_empty() {
            break;
        }
        let Ok(bytes) = wad.load_chunk_decompressed(&chunk) else {
            continue;
        };
        if !bytes.starts_with(b"PROP") && !bytes.starts_with(b"PTCH") {
            continue;
        }
        let Ok(document) = BinDocument::parse(bytes) else {
            continue;
        };
        for entry in document.entries() {
            let key = entry.0;
            if !needed.contains(&key)
                || !document
                    .object_at(entry)
                    .is_some_and(|o| o.class_hash == vfx)
            {
                continue;
            }
            let system = ObjectLookup::single(&document, &(), &(), None).system(entry)?;
            fs::write(
                output.join(format!("{key:08x}.json")),
                serde_json::to_vec(&system)?,
            )?;
            fs::write(
                output.join(format!("{key:08x}.bin-hash")),
                format!("{:016x}", chunk.path_hash.0),
            )?;
            needed.remove(&key);
        }
    }
    if !needed.is_empty() {
        eprintln!("Unresolved native BIN entries in {wad_path}: {needed:x?}");
    }
    Ok(())
}
