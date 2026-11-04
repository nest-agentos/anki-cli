use crate::{
    fields,
    manifest::{self, Manifest},
    model,
};
use anyhow::{ensure, Context, Result};
use genanki_rs::{Deck, Note, Package};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
};
use zip::{write::FileOptions, CompressionMethod, ZipArchive, ZipWriter};

pub fn pack(value: &Manifest, root: &Path) -> Result<serde_json::Value> {
    manifest::validate(value)?;
    let target = manifest::output_path(root, &value.output)?;
    let lock = File::options()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join(".anki-pack.lock"))?;
    fs2::FileExt::try_lock_exclusive(&lock)
        .context("Another pack operation owns this directory")?;
    let media = check_media(value, root)?;
    let deck = create_deck(value, root)?;
    let mut collection = tempfile::NamedTempFile::new_in(root)?;
    Package::new(vec![deck], vec![])?.write(collection.as_file_mut())?;
    let mut output = tempfile::NamedTempFile::new_in(target.parent().unwrap())?;
    write_archive(collection.reopen()?, output.as_file_mut(), value, &media)?;
    output.as_file().sync_all()?;
    let sha256 = hash_file(output.path())?;
    let bytes = output.as_file().metadata()?.len();
    output.persist(&target).map_err(|error| error.error)?;
    Ok(
        serde_json::json!({"output": value.output, "deck_id": value.deck.id, "cards": value.cards.len(), "media": media.len(), "bytes": bytes, "sha256": sha256}),
    )
}
fn check_media(value: &Manifest, root: &Path) -> Result<Vec<PathBuf>> {
    value
        .media
        .iter()
        .map(|media| {
            let path = manifest::input_path(root, &media.path)?;
            if let Some(expected) = &media.sha256 {
                ensure!(
                    hash_file(&path)? == *expected,
                    "Media checksum mismatch: {}",
                    media.name
                );
            }
            Ok(path)
        })
        .collect()
}
fn create_deck(value: &Manifest, root: &Path) -> Result<Deck> {
    let model = model::load(value, root)?;
    let names: HashSet<String> = value.media.iter().map(|item| item.name.clone()).collect();
    let mut deck = Deck::new(value.deck.id, &value.deck.name, &value.deck.description);
    for card in &value.cards {
        let fields = fields::fields(card, &names)?;
        let fields: Vec<&str> = fields.iter().map(String::as_str).collect();
        let identity = if card.kind == "recite" {
            format!("{}:recite:{}", value.deck.id, card.id)
        } else {
            format!("{}:{}", value.deck.id, card.id)
        };
        deck.add_note(Note::new(model.clone(), fields)?.guid(manifest::stable_guid(&identity)));
    }
    Ok(deck)
}
fn write_archive(
    source: File,
    output: &mut File,
    value: &Manifest,
    media: &[PathBuf],
) -> Result<()> {
    let mut source = ZipArchive::new(source)?;
    let mut archive = ZipWriter::new(output);
    archive.start_file(
        "collection.anki2",
        FileOptions::default().compression_method(CompressionMethod::Deflated),
    )?;
    std::io::copy(&mut source.by_name("collection.anki2")?, &mut archive)?;
    write_media(&mut archive, value, media)?;
    archive.finish()?;
    Ok(())
}
fn write_media(
    archive: &mut ZipWriter<&mut File>,
    value: &Manifest,
    media: &[PathBuf],
) -> Result<()> {
    let map: BTreeMap<String, &str> = value
        .media
        .iter()
        .enumerate()
        .map(|(index, item)| (index.to_string(), item.name.as_str()))
        .collect();
    archive.start_file(
        "media",
        FileOptions::default().compression_method(CompressionMethod::Stored),
    )?;
    archive.write_all(&serde_json::to_vec(&map)?)?;
    for (index, path) in media.iter().enumerate() {
        archive.start_file(
            index.to_string(),
            FileOptions::default()
                .compression_method(CompressionMethod::Stored)
                .large_file(true),
        )?;
        std::io::copy(&mut File::open(path)?, &mut *archive)?;
    }
    Ok(())
}

pub fn hash_file(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
