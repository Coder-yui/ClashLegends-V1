// Build as an example of the pinned ltk-manager-game crate (see import_battle_effects.py).
use ltk_hash::{BinHash, Hash as _, WadHash};
use ltk_manager_assets::preview::AssetRef;
use ltk_manager_bin::bin_document::{AssetLookup, BinDocument, RowNames};
use ltk_manager_game::lookup::ObjectLookup;
use std::{
    collections::{BTreeSet, HashMap},
    env, fs,
    path::Path,
};

// effectKey children are resolved through the champion skin's resource resolver.
// The authored parent path supplies the skin name even without external hash tables.
struct Entries(HashMap<u32, String>);
impl RowNames for Entries {
    fn for_each_entry(&self, hashes: &[BinHash], visit: &mut dyn FnMut(usize, &str)) {
        for (i, hash) in hashes.iter().enumerate() {
            if let Some(path) = self.0.get(&hash.0) {
                visit(i, path);
            }
        }
    }
    fn for_each_class(&self, _: &[BinHash], _: &mut dyn FnMut(usize, &str)) {}
    fn for_each_field(&self, _: &[BinHash], _: &mut dyn FnMut(usize, &str)) {}
    fn for_each_value(&self, _: &[BinHash], _: &mut dyn FnMut(usize, &str)) {}
    fn for_each_chunk(&self, _: &[WadHash], _: &mut dyn FnMut(usize, &str)) {}
}

struct ArchiveBins(BTreeSet<u64>);
impl AssetLookup for ArchiveBins {
    fn locate(&self, path: &str) -> Option<AssetRef> {
        let path = path.to_ascii_lowercase();
        if !path.ends_with(".bin") {
            return None;
        }
        let hash = WadHash::hash_str(&path).0;
        self.0.contains(&hash).then(|| AssetRef::GameChunk {
            wad: String::new(),
            path_hash: format!("{hash:016x}"),
        })
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = env::args().skip(1).collect();
    let (wad_path, requests, output) = (&args[0], &args[1], Path::new(&args[2]));
    let paths: Vec<String> = serde_json::from_slice(&fs::read(requests)?)?;
    let names = Entries(
        paths
            .into_iter()
            .map(|p| (BinHash::hash_str(&p).0, p))
            .collect(),
    );
    let mut needed: BTreeSet<u32> = names.0.keys().copied().collect();
    let mut wad = ltk_wad::Wad::mount(fs::File::open(wad_path)?)?;
    let chunks: Vec<_> = wad.chunks().iter().copied().collect();
    let indexed: HashMap<_, _> = chunks.iter().map(|c| (c.path_hash.0, *c)).collect();
    let bins = ArchiveBins(indexed.keys().copied().collect());
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
            let system = ObjectLookup::new(&document, &names, &bins, None, |asset| {
                let AssetRef::GameChunk { path_hash, .. } = asset else {
                    return None;
                };
                let hash = u64::from_str_radix(path_hash, 16).ok()?;
                let data = wad.load_chunk_decompressed(indexed.get(&hash)?).ok()?;
                BinDocument::parse(data).ok()
            })
            .system(entry)?;
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
