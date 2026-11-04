use crate::manifest::{basename, Card};
use anyhow::{ensure, Result};
use serde_json::Value;
use std::collections::HashSet;

fn text(data: &Value, key: &str) -> String {
    match &data[key] {
        Value::Null => String::new(),
        Value::String(value) => escape(value),
        value => escape(&value.to_string()),
    }
}
fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('\n', "<br>")
}
fn media(data: &Value, key: &str, names: &HashSet<String>, image: bool) -> Result<String> {
    let Some(name) = data[key].as_str().filter(|name| !name.is_empty()) else {
        return Ok(String::new());
    };
    basename(name)?;
    ensure!(
        names.contains(name),
        "Referenced media is missing from manifest: {name}"
    );
    Ok(if image {
        format!("<img src=\"{name}\">")
    } else {
        format!("[sound:{name}]")
    })
}
pub fn fields(card: &Card, names: &HashSet<String>) -> Result<Vec<String>> {
    let mut result = vec![String::new(); 51];
    if card.kind == "word" {
        word_fields(&mut result, &card.data, names)?;
    } else {
        recite_fields(&mut result, &card.data, names)?;
    }
    Ok(result)
}
fn word_fields(result: &mut [String], data: &Value, names: &HashSet<String>) -> Result<()> {
    for (index, key) in [
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
    ] {
        result[index] = text(data, key);
    }
    ensure!(!result[0].trim().is_empty(), "Word name is required");
    result[6] = media(data, "image", names, true)?;
    result[8] = media(data, "audio_example", names, false)?;
    result[9] = media(data, "audio", names, false)?;
    Ok(())
}
fn recite_fields(result: &mut [String], data: &Value, names: &HashSet<String>) -> Result<()> {
    for (index, key) in [
        (16, "name"),
        (17, "author"),
        (18, "text"),
        (19, "hint"),
        (48, "translate"),
    ] {
        result[index] = text(data, key);
    }
    result[20] = media(data, "audio", names, false)?;
    result[49] = media(data, "image", names, true)?;
    for index in 1..=9 {
        result[18 + index * 3] = text(data, &format!("text{index}"));
        result[19 + index * 3] = text(data, &format!("hint{index}"));
        result[20 + index * 3] = media(data, &format!("audio{index}"), names, false)?;
    }
    Ok(())
}
