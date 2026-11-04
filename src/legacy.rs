use crate::manifest::{self, Card, DeckSpec, Manifest, Media};
use anyhow::{ensure, Result};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    path::Path,
};

pub fn safe_name(name: &str) -> String {
    name.trim_start_matches('*')
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '_' })
        .collect()
}
pub fn parse_words(text: &str) -> Result<Vec<Value>> {
    if text.trim_start().starts_with('[') {
        return parse_json_words(text);
    }
    let mut unit = 1u32;
    let mut cards = Vec::new();
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if line.to_lowercase().starts_with("unit ") {
            unit = line[5..].trim().parse()?;
        } else {
            cards.push(json!({"name": line, "unit": unit}));
        }
    }
    Ok(cards)
}
fn parse_json_words(text: &str) -> Result<Vec<Value>> {
    let input: Vec<Value> = serde_json::from_str(text)?;
    let mut unit = json!(1);
    let mut cards = Vec::new();
    for mut card in input {
        ensure!(card.is_object(), "WordData entries must be objects");
        let name = card["name"].as_str().unwrap_or("").trim();
        if card["chn"].is_null() && card["example_en"].is_null() {
            if let Ok(number) = name.parse::<u32>() {
                unit = json!(number);
                continue;
            }
        }
        if card["unit"].is_null() {
            card["unit"] = unit.clone();
        }
        cards.push(card);
    }
    Ok(cards)
}
pub fn merge_word(old: &Value, generated: &Value, replace: bool) -> Value {
    let mut value = old.clone();
    let keys = [
        "symbol",
        "chn",
        "example_en",
        "example_cn",
        "word_family",
        "memory_tips",
        "difficulty",
        "collocations",
        "image_prompt",
    ];
    for key in keys {
        let missing = value[key].is_null()
            || value[key]
                .as_str()
                .is_some_and(|value| value.trim().is_empty());
        if (replace || missing) && !generated[key].is_null() {
            value[key] = generated[key].clone();
        }
    }
    if value["example_en"] != old["example_en"] {
        value["audio_example"] = Value::Null;
    }
    if value["image_prompt"] != old["image_prompt"] {
        value["image"] = Value::Null;
    }
    value
}
pub fn merge_project(root: &Path, text: &str, replace: bool) -> Result<Value> {
    let cards = parse_words(text)?;
    let mut writes = Vec::new();
    let mut seen = HashSet::new();
    for generated in cards {
        let name = generated["name"].as_str().unwrap_or("").trim();
        ensure!(!name.is_empty(), "Word name is required");
        let filename = format!("{}.json", safe_name(name));
        manifest::basename(&filename)?;
        ensure!(seen.insert(filename.clone()), "Duplicate word identity");
        let path = root.join("word_json").join(filename);
        let old: Value = serde_json::from_slice(&fs::read(&path)?)?;
        ensure!(old.is_object(), "Existing WordData must be an object");
        ensure!(
            old["name"]
                .as_str()
                .is_some_and(|old| old.eq_ignore_ascii_case(name)),
            "Word filename collision"
        );
        writes.push((path, merge_word(&old, &generated, replace)));
    }
    for (path, value) in &writes {
        manifest::atomic_write(path, &serde_json::to_vec_pretty(value)?)?;
    }
    Ok(json!({"updated":writes.len()}))
}
pub fn init(root: &Path, text: &str) -> Result<Value> {
    for dir in ["word_json", "recite_json", "audio", "images"] {
        fs::create_dir_all(root.join(dir))?;
    }
    let mut writes = Vec::new();
    let mut seen = HashSet::new();
    for card in parse_words(text)? {
        if let Some(path) = new_card_path(root, &card, &mut seen)? {
            writes.push((path, card));
        }
    }
    for (path, card) in &writes {
        manifest::atomic_write(path, &serde_json::to_vec_pretty(card)?)?;
    }
    Ok(json!({"added":writes.len(),"project":root}))
}
fn new_card_path(
    root: &Path,
    card: &Value,
    seen: &mut HashSet<String>,
) -> Result<Option<std::path::PathBuf>> {
    let name = card["name"].as_str().unwrap_or("").trim();
    ensure!(!name.is_empty(), "Word name is required");
    let filename = format!("{}.json", safe_name(name));
    manifest::basename(&filename)?;
    ensure!(
        seen.insert(filename.clone()),
        "Duplicate or colliding word name: {name}"
    );
    let relative = format!("word_json/{filename}");
    let path = manifest::output_path(root, &relative)?;
    if !path.exists() {
        return Ok(Some(path));
    }
    let old: Value = serde_json::from_slice(&fs::read(manifest::input_path(root, &relative)?)?)?;
    ensure!(
        old["name"]
            .as_str()
            .is_some_and(|old| old.eq_ignore_ascii_case(name)),
        "Word filename collision"
    );
    Ok(None)
}
pub fn project(root: &Path) -> Result<Manifest> {
    let root = root.canonicalize()?;
    let name = root.file_name().unwrap().to_string_lossy().into_owned();
    let cards = read_project_cards(&root)?;
    let mut media = BTreeMap::new();
    for card in &cards {
        collect_media(&card.data, &mut media)?;
    }
    let result = Manifest {
        version: 1,
        deck: project_deck(&root, &name)?,
        output: format!("{name}_Deck.apkg"),
        template: None,
        cards,
        media: media.into_values().collect(),
    };
    manifest::validate(&result)?;
    Ok(result)
}
fn project_deck(root: &Path, name: &str) -> Result<DeckSpec> {
    let id_path = root.join(".anki-deck-id");
    let id = if id_path.exists() {
        fs::read_to_string(manifest::input_path(root, ".anki-deck-id")?)?
            .trim()
            .parse()?
    } else {
        manifest::deck_id(&root.to_string_lossy())
    };
    Ok(DeckSpec {
        id,
        name: format!("{name} 综合学习"),
        description: String::new(),
    })
}
fn read_project_cards(root: &Path) -> Result<Vec<Card>> {
    let mut cards = Vec::new();
    for (dir, kind) in [("word_json", "word"), ("recite_json", "recite")] {
        for path in json_files(&root.join(dir))? {
            let relative = path
                .strip_prefix(root)?
                .to_string_lossy()
                .replace('\\', "/");
            let data: Value =
                serde_json::from_slice(&fs::read(manifest::input_path(root, &relative)?)?)?;
            cards.push(Card {
                id: path.file_name().unwrap().to_string_lossy().into_owned(),
                kind: kind.into(),
                data,
            });
        }
    }
    Ok(cards)
}
fn collect_media(data: &Value, result: &mut BTreeMap<String, Media>) -> Result<()> {
    for (key, value) in data.as_object().into_iter().flatten() {
        if key != "image"
            && key != "audio"
            && key != "audio_example"
            && !(1..=9).any(|i| key == &format!("audio{i}"))
        {
            continue;
        }
        if let Some(name) = value.as_str().filter(|name| !name.is_empty()) {
            manifest::basename(name)?;
            let directory = if key == "image" { "images" } else { "audio" };
            let media = Media {
                name: name.into(),
                path: format!("{directory}/{name}"),
                sha256: None,
            };
            ensure!(
                !result.get(name).is_some_and(|old| old.path != media.path),
                "Media filename collision: {name}"
            );
            result.insert(name.into(), media);
        }
    }
    Ok(())
}
fn json_files(root: &Path) -> Result<Vec<std::path::PathBuf>> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut files = fs::read_dir(root)?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<std::io::Result<Vec<_>>>()?;
    files.retain(|path| path.extension().is_some_and(|ext| ext == "json"));
    files.sort();
    Ok(files)
}
