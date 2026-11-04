use crate::manifest::{self, Card, DeckSpec, Manifest, Media};
use anyhow::{ensure, Result};
use serde_json::{json, Value};
use std::{
    fs::{self, File},
    path::Path,
};

fn cell(value: &Value) -> String {
    value
        .as_str()
        .unwrap_or("")
        .replace('|', "\\|")
        .replace('\n', "<br>")
}
pub fn render(value: &Manifest) -> String {
    let mut output = format!("# {}\n\n| Unit | 单词 | 音标 | 释义 | 例句 | 翻译 |\n| --- | --- | --- | --- | --- | --- |\n",value.deck.name);
    for card in &value.cards {
        output.push_str(&if card.kind == "recite" {
            recite_markdown(&card.data)
        } else {
            word_row(&card.data)
        });
    }
    for card in value.cards.iter().filter(|card| card.kind == "word") {
        output.push_str(&word_details(&card.data));
    }
    output
}
fn word_row(data: &Value) -> String {
    let unit = match &data["unit"] {
        Value::String(value) => value.clone(),
        Value::Null => String::new(),
        value => value.to_string(),
    };
    format!(
        "| {} | {} | {} | {} | {} | {} |\n",
        unit.replace('|', "\\|"),
        cell(&data["name"]),
        cell(&data["symbol"]),
        cell(&data["chn"]),
        cell(&data["example_en"]),
        cell(&data["example_cn"])
    )
}
fn word_details(data: &Value) -> String {
    let mut result = format!("\n## {}\n", cell(&data["name"]));
    for (key, label) in [
        ("word_family", "词族"),
        ("memory_tips", "记忆技巧"),
        ("collocations", "搭配"),
    ] {
        if let Some(text) = data[key].as_str() {
            result.push_str(&format!("\n{label}：{text}\n"));
        }
    }
    result
}
fn recite_markdown(data: &Value) -> String {
    let mut result = format!(
        "\n## {}\n\n{}\n\n{}\n",
        cell(&data["name"]),
        cell(&data["author"]),
        data["text"].as_str().unwrap_or("")
    );
    for index in 1..=9 {
        if let Some(text) = data[format!("text{index}")].as_str() {
            result.push_str(&format!("\n{text}\n"));
        }
    }
    if let Some(text) = data["translate"].as_str() {
        result.push_str(&format!("\n{text}\n"));
    }
    result
}
pub fn unpack(package: &Path, output: &Path) -> Result<Value> {
    fs::create_dir_all(output)?;
    let value = read_package(package, output)?;
    manifest::write(&output.join("anki.manifest.yaml"), &value)?;
    let raw: Vec<_> = value.cards.iter().map(|card| &card.data).collect();
    manifest::atomic_write(
        &output.join("cards.json"),
        &serde_json::to_vec_pretty(&raw)?,
    )?;
    manifest::atomic_write(&output.join("cards.md"), render(&value).as_bytes())?;
    Ok(
        json!({"cards":value.cards.len(),"json":output.join("cards.json"),"markdown":output.join("cards.md"),"manifest":output.join("anki.manifest.yaml")}),
    )
}
fn read_package(package: &Path, output: &Path) -> Result<Manifest> {
    let mut archive = zip::ZipArchive::new(File::open(package)?)?;
    let mut database = tempfile::NamedTempFile::new()?;
    extract_database(&mut archive, database.as_file_mut())?;
    let connection = rusqlite::Connection::open(database.path())?;
    let cards = read_cards(&connection)?;
    let id: i64 = connection.query_row("SELECT did FROM cards LIMIT 1", [], |row| row.get(0))?;
    let name = package
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let media = extract_media(&mut archive, output)?;
    let value = Manifest {
        version: 1,
        deck: DeckSpec {
            id,
            name,
            description: String::new(),
        },
        output: "imported.apkg".into(),
        template: None,
        cards,
        media,
    };
    Ok(value)
}

fn extract_database(archive: &mut zip::ZipArchive<File>, output: &mut File) -> Result<()> {
    let name = [
        "collection.anki21b",
        "collection.anki21",
        "collection.anki2",
    ]
    .into_iter()
    .find(|name| archive.file_names().any(|entry| entry == *name))
    .ok_or_else(|| anyhow::anyhow!("Anki collection is missing"))?;
    let mut entry = archive.by_name(name)?;
    if name.ends_with('b') {
        std::io::copy(&mut zstd::Decoder::new(&mut entry)?, output)?;
    } else {
        std::io::copy(&mut entry, output)?;
    }
    Ok(())
}
fn read_cards(connection: &rusqlite::Connection) -> Result<Vec<Card>> {
    let mut query = connection.prepare("SELECT flds FROM notes ORDER BY id")?;
    let rows = query.query_map([], |row| row.get::<_, String>(0))?;
    rows.map(|row| {
        let fields: Vec<String> = row?.split('\x1f').map(str::to_owned).collect();
        ensure!(
            fields.len() == 51,
            "Package does not use the anki-helper 51-field layout"
        );
        let kind = if fields[0].is_empty() && !fields[16].is_empty() {
            "recite"
        } else {
            "word"
        };
        let data = extract_fields(&fields, kind);
        Ok(Card {
            id: imported_id(&data, kind)?,
            kind: kind.into(),
            data,
        })
    })
    .collect()
}
fn imported_id(data: &Value, kind: &str) -> Result<String> {
    let name = data["name"].as_str().unwrap_or("");
    if kind == "recite" {
        return Ok(format!("{}.json", crate::legacy::safe_name(name)));
    }
    let mut identity = data.clone();
    if identity["unit"] == "" {
        identity["unit"] = Value::Null;
    }
    crate::plan::card_id(&identity, name)
}
fn decode(value: &str) -> String {
    value
        .replace("<br>", "\n")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}
const WORD_FIELDS: &[(usize, &str)] = &[
    (0, "name"),
    (2, "grade"),
    (3, "unit"),
    (4, "symbol"),
    (5, "chn"),
    (7, "example_en"),
    (11, "example_cn"),
    (12, "word_family"),
    (13, "memory_tips"),
    (14, "difficulty"),
    (15, "collocations"),
    (50, "image_prompt"),
];
const RECITE_FIELDS: &[(usize, &str)] = &[
    (16, "name"),
    (17, "author"),
    (18, "text"),
    (19, "hint"),
    (48, "translate"),
];
fn extract_fields(fields: &[String], kind: &str) -> Value {
    let mut data = serde_json::Map::new();
    let indices = if kind == "word" {
        WORD_FIELDS
    } else {
        RECITE_FIELDS
    };
    for (index, name) in indices {
        data.insert((*name).into(), json!(decode(&fields[*index])));
    }
    let media = if kind == "word" {
        vec![(6, "image"), (8, "audio_example"), (9, "audio")]
    } else {
        vec![(20, "audio"), (49, "image")]
    };
    for (index, name) in media {
        if let Some(file) = media_name(&fields[index]) {
            data.insert(name.into(), json!(file));
        }
    }
    if kind == "recite" {
        add_recite_fields(&mut data, fields);
    }
    Value::Object(data)
}
fn add_recite_fields(data: &mut serde_json::Map<String, Value>, fields: &[String]) {
    for index in 1..=9 {
        data.insert(
            format!("text{index}"),
            json!(decode(&fields[18 + index * 3])),
        );
        data.insert(
            format!("hint{index}"),
            json!(decode(&fields[19 + index * 3])),
        );
        if let Some(file) = media_name(&fields[20 + index * 3]) {
            data.insert(format!("audio{index}"), json!(file));
        }
    }
}

fn media_name(value: &str) -> Option<String> {
    value
        .strip_prefix("[sound:")
        .and_then(|value| value.strip_suffix(']'))
        .or_else(|| {
            value
                .strip_prefix("<img src=\"")
                .and_then(|value| value.strip_suffix("\">"))
        })
        .map(str::to_owned)
}
fn extract_media(archive: &mut zip::ZipArchive<File>, output: &Path) -> Result<Vec<Media>> {
    let map: std::collections::BTreeMap<String, String> =
        serde_json::from_reader(archive.by_name("media")?)?;
    fs::create_dir_all(output.join("media"))?;
    let mut media = Vec::new();
    for (index, name) in map {
        manifest::basename(&name)?;
        let relative = format!("media/{name}");
        let path = manifest::output_path(output, &relative)?;
        let mut target = tempfile::NamedTempFile::new_in(output.join("media"))?;
        std::io::copy(&mut archive.by_name(&index)?, target.as_file_mut())?;
        let sha256 = crate::archive::hash_file(target.path())?;
        target.persist(&path).map_err(|error| error.error)?;
        media.push(Media {
            name,
            path: relative,
            sha256: Some(sha256),
        });
    }
    Ok(media)
}
