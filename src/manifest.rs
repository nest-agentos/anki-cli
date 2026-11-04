use anyhow::{bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    path::{Component, Path, PathBuf},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub version: u32,
    pub deck: DeckSpec,
    pub output: String,
    pub template: Option<String>,
    pub cards: Vec<Card>,
    #[serde(default)]
    pub media: Vec<Media>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeckSpec {
    pub id: i64,
    pub name: String,
    #[serde(default)]
    pub description: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Card {
    pub id: String,
    #[serde(default = "word_kind")]
    pub kind: String,
    pub data: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Media {
    pub name: String,
    pub path: String,
    pub sha256: Option<String>,
}
fn word_kind() -> String {
    "word".into()
}

pub fn stable_guid(identity: &str) -> String {
    let hash = identity.bytes().fold(0xcbf29ce484222325u64, |hash, byte| {
        (hash ^ byte as u64).wrapping_mul(0x100000001b3)
    });
    format!("{hash:016x}")
}
pub fn deck_id(key: &str) -> i64 {
    let bytes = Sha256::digest(format!("anki-cli:deck:{key}"));
    ((u64::from_be_bytes(bytes[..8].try_into().unwrap()) & ((1 << 53) - 1)).max(1)) as i64
}
pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn read(path: &Path) -> Result<Manifest> {
    let value: Manifest = serde_yaml::from_slice(&fs::read(path)?)?;
    validate(&value)?;
    Ok(value)
}
pub fn validate(value: &Manifest) -> Result<()> {
    ensure!(value.version == 1, "Unsupported manifest version");
    ensure!(
        value.deck.id > 0 && value.deck.id < (1i64 << 53),
        "Invalid deck id"
    );
    ensure!(!value.deck.name.trim().is_empty(), "Deck name is required");
    ensure!(!value.cards.is_empty(), "No cards to package");
    relative(&value.output)?;
    ensure!(
        value.output.ends_with(".apkg"),
        "Output must be an .apkg file"
    );
    validate_cards(&value.cards)?;
    validate_media(&value.media)
}
fn validate_cards(cards: &[Card]) -> Result<()> {
    let mut ids = HashSet::new();
    for card in cards {
        basename(&card.id)?;
        ensure!(
            !card.id.is_empty() && ids.insert((&card.kind, &card.id)),
            "Duplicate or empty card id"
        );
        ensure!(
            matches!(card.kind.as_str(), "word" | "recite"),
            "Unknown card kind"
        );
        ensure!(card.data.is_object(), "Card data must be an object");
    }
    Ok(())
}
fn validate_media(media: &[Media]) -> Result<()> {
    let mut names = HashSet::new();
    for media in media {
        basename(&media.name)?;
        relative(&media.path)?;
        ensure!(names.insert(&media.name), "Duplicate media name");
    }
    Ok(())
}

pub fn relative(path: &str) -> Result<()> {
    ensure!(
        !path.is_empty() && !path.contains(['\\', '\0', ':']),
        "Invalid relative path"
    );
    ensure!(
        Path::new(path)
            .components()
            .all(|part| matches!(part, Component::Normal(_))),
        "Path must remain inside the manifest directory"
    );
    Ok(())
}
pub fn basename(name: &str) -> Result<()> {
    relative(name)?;
    ensure!(
        !name.contains(['/', '<', '>', '"', '\'', '[', ']']),
        "Invalid media filename"
    );
    Ok(())
}
pub fn input_path(root: &Path, name: &str) -> Result<PathBuf> {
    relative(name)?;
    let path = root
        .join(name)
        .canonicalize()
        .with_context(|| format!("Missing input: {name}"))?;
    ensure!(
        path.starts_with(root.canonicalize()?),
        "Input escapes manifest directory"
    );
    Ok(path)
}
pub fn output_path(root: &Path, name: &str) -> Result<PathBuf> {
    relative(name)?;
    let target = root.join(name);
    let parent = target.parent().context("Missing output parent")?;
    ensure!(
        parent.canonicalize()?.starts_with(root.canonicalize()?),
        "Output escapes manifest directory"
    );
    if fs::symlink_metadata(&target).is_ok_and(|meta| meta.file_type().is_symlink()) {
        bail!("Output must not be a symlink");
    }
    Ok(target)
}
pub fn write(path: &Path, manifest: &Manifest) -> Result<()> {
    validate(manifest)?;
    atomic_write(path, serde_yaml::to_string(manifest)?.as_bytes())
}
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let mut temp = tempfile::NamedTempFile::new_in(path.parent().unwrap_or(Path::new(".")))?;
    temp.write_all(bytes)?;
    temp.as_file().sync_all()?;
    temp.persist(path).map_err(|error| error.error)?;
    Ok(())
}
