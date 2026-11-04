use crate::{
    legacy::safe_name,
    manifest::{self, Card, DeckSpec, Manifest},
};
use anyhow::{ensure, Result};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanInput {
    pub cards: Vec<Value>,
    pub deck_name: String,
    pub directory: String,
    pub source: Option<String>,
    pub export_key: Option<String>,
    #[serde(default)]
    pub images: bool,
    #[serde(default)]
    pub audio: bool,
    #[serde(default)]
    pub voice: String,
}
pub fn prepare(source: &str) -> Result<Value> {
    let cards = crate::legacy::parse_words(source)?;
    ensure!(
        !cards.is_empty() && cards.len() <= 1000,
        "Each export supports 1..1000 cards; generation is split into batches of at most 20"
    );
    manifest_from_cards(cards.clone(), "Input validation")?;
    for card in &cards {
        reject_media(card)?;
    }
    Ok(json!({"cards":cards}))
}
pub fn manifest_from_cards(cards: Vec<Value>, name: &str) -> Result<Manifest> {
    let cards = cards
        .into_iter()
        .map(|data| {
            let name = data["name"].as_str().unwrap_or("").trim();
            ensure!(!name.is_empty(), "Word name is required");
            Ok(Card {
                id: card_id(&data, name)?,
                kind: "word".into(),
                data,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let result = Manifest {
        version: 1,
        deck: DeckSpec {
            id: manifest::deck_id(name),
            name: name.into(),
            description: String::new(),
        },
        output: "deck.apkg".into(),
        template: None,
        cards,
        media: Vec::new(),
    };
    manifest::validate(&result)?;
    Ok(result)
}
pub fn build(mut input: PlanInput) -> Result<Value> {
    ensure!(
        !input.audio || !input.voice.trim().is_empty(),
        "Speech voice is required when audio generation is enabled"
    );
    if let Some(source) = &input.source {
        input.cards = merge_source(source, &input.cards)?;
    }
    validate_generated(&input)?;
    manifest::relative(&input.directory)?;
    let bytes = serde_json::to_vec(&input.cards)?;
    let key = input
        .export_key
        .clone()
        .unwrap_or_else(|| manifest::digest(&bytes)[..16].to_string());
    ensure!(
        key.len() == 16 && key.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "Invalid export key"
    );
    let value = manifest_from_cards(input.cards.clone(), &input.deck_name)?;
    let mut graph = MediaGraph::default();
    for index in 0..input.cards.len() {
        graph.card(index, &input);
    }
    graph.package();
    Ok(
        json!({"cards":input.cards,"manifest":value,"directory":input.directory,"voice":input.voice,"export_key":key,
        "artifacts":{"manifest":{"path":format!("{}/{key}/anki.manifest.yaml",input.directory),"mimeType":"application/yaml"},
                     "package":{"path":format!("{}/{key}/deck.apkg",input.directory),"mimeType":"application/octet-stream"}},
        "spawn":{"idempotencyKey":"anki-media-and-package-v1","nodes":graph.nodes,"edges":graph.edges}}),
    )
}
fn validate_generated(input: &PlanInput) -> Result<()> {
    ensure!(
        !input.cards.is_empty() && input.cards.len() <= 1000,
        "Each export supports 1..1000 cards; generation is split into batches of at most 20"
    );
    for card in &input.cards {
        for (field, required) in [
            ("chn", true),
            ("image_prompt", input.images),
            ("example_en", input.audio),
        ] {
            ensure!(
                !required
                    || card[field]
                        .as_str()
                        .is_some_and(|text| !text.trim().is_empty()),
                "Missing generated field: {field}"
            );
        }
    }
    Ok(())
}
fn merge_source(source: &str, generated: &[Value]) -> Result<Vec<Value>> {
    let original = crate::legacy::parse_words(source)?;
    ensure!(
        original.len() == generated.len(),
        "Generated cards must match all input words; do not omit cards"
    );
    original
        .into_iter()
        .map(|old| {
            let name = old["name"].as_str().unwrap_or("");
            let candidates: Vec<_> = generated
                .iter()
                .filter(|card| {
                    card["name"]
                        .as_str()
                        .is_some_and(|value| value.eq_ignore_ascii_case(name))
                        && unit_key(card) == unit_key(&old)
                })
                .collect();
            ensure!(
                candidates.len() == 1,
                "Generated word identity and unit must match exactly one input card"
            );
            reject_media(&old)?;
            Ok(crate::legacy::merge_word(&old, candidates[0], false))
        })
        .collect()
}
fn unit_key(card: &Value) -> String {
    match &card["unit"] {
        Value::Null => "1".into(),
        Value::String(unit) => unit.clone(),
        other => other.to_string(),
    }
}
pub(crate) fn card_id(card: &Value, name: &str) -> Result<String> {
    if let Some(id) = card["id"].as_str() {
        manifest::basename(id)?;
        return Ok(id.into());
    }
    let unit = unit_key(card);
    ensure!(
        !unit.trim().is_empty()
            && (card["unit"].is_null() || card["unit"].is_string() || card["unit"].is_number()),
        "Card unit must be a nonempty string or number"
    );
    let suffix = if unit == "1" {
        String::new()
    } else {
        format!("__unit_{}", safe_name(&unit))
    };
    Ok(format!("{}{suffix}.json", safe_name(name)))
}
fn reject_media(card: &Value) -> Result<()> {
    for field in ["audio", "audio_example", "image"] {
        ensure!(
            card[field].as_str().is_none_or(|value| value.is_empty()),
            "Import existing media with migrate/pack rather than WordData text input"
        );
    }
    Ok(())
}

fn reference(index: usize, field: &str) -> String {
    format!("${{nodes.plan.outputs.result.cards.{index}.{field}}}")
}
#[derive(Default)]
struct MediaGraph {
    nodes: Vec<Value>,
    edges: Vec<Value>,
    media: Vec<Value>,
}
impl MediaGraph {
    fn card(&mut self, index: usize, input: &PlanInput) {
        if input.images {
            self.add(
                index,
                "image",
                "image",
                "image.generate",
                json!({"prompt": reference(index,"image_prompt"),"format":"png"}),
            );
        }
        if input.audio {
            for (field, source) in [("audio", "name"), ("audio_example", "example_en")] {
                self.add(index,field,"speech","speech.synthesize",json!({"input":reference(index,source),"voice":"${nodes.plan.outputs.result.voice}","format":"mp3"}));
            }
        }
    }
    fn package(&mut self) {
        self.nodes.push(json!({"id":"anki-package","name":"生成 YAML 清单并打包 Anki","plugin":"builtin.tool","pluginVersion":"1.0.0","inputs":{},"capabilities":["anki.package"],
            "config":{"toolId":"anki.package","toolVersion":"1","approval":"none","timeoutMs":180000,"args":{"manifest":"${nodes.plan.outputs.result.manifest}","directory":"${nodes.plan.outputs.result.directory}","export_key":"${nodes.plan.outputs.result.export_key}","media":self.media}}}));
        self.edges.push(json!({"id":"plan-package","from":"$upstream:plan","to":"anki-package","kind":"control"}));
        self.edges.push(
            json!({"id":"spawn-package","from":"$parent","to":"anki-package","kind":"control"}),
        );
    }
    fn add(&mut self, index: usize, field: &str, slot: &str, operation: &str, request: Value) {
        let id = format!("anki-{index}-{field}");
        self.nodes.push(json!({"id":id,"name":format!("卡片 {} / {field}",index+1),"plugin":"builtin.media","pluginVersion":"1.0.0","inputs":{},
            "config":{"connectionId":slot,"operation":operation,"request":request},"outputPolicy":{"includeInRunOutput":false,"publishToHistory":false}}));
        self.edges.push(
            json!({"id":format!("plan-{id}"),"from":"$upstream:plan","to":id,"kind":"control"}),
        );
        self.edges
            .push(json!({"id":format!("spawn-{id}"),"from":"$parent","to":id,"kind":"control"}));
        self.edges.push(
            json!({"id":format!("{id}-package"),"from":id,"to":"anki-package","kind":"control"}),
        );
        self.media.push(
            json!({"card":index,"field":field,"result":format!("${{nodes.{id}.outputs.result}}" )}),
        );
    }
}
