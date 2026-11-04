use anki_cli::{archive, legacy, manifest, plan};
use serde_json::{json, Value};
use std::{
    fs::{self, File},
    io::Read,
    path::Path,
};

fn fixture() -> manifest::Manifest {
    plan::manifest_from_cards(
        vec![json!({"name":"apple", "chn":"苹果", "example_en":"An apple.", "unit":2})],
        "英语单词",
    )
    .unwrap()
}
fn note(path: &Path) -> (String, String) {
    let mut archive = zip::ZipArchive::new(File::open(path).unwrap()).unwrap();
    let mut database = tempfile::NamedTempFile::new().unwrap();
    std::io::copy(
        &mut archive.by_name("collection.anki2").unwrap(),
        database.as_file_mut(),
    )
    .unwrap();
    let connection = rusqlite::Connection::open(database.path()).unwrap();
    connection
        .query_row("SELECT guid, flds FROM notes", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .unwrap()
}
fn guids(path: &Path) -> Vec<String> {
    let mut archive = zip::ZipArchive::new(File::open(path).unwrap()).unwrap();
    let mut database = tempfile::NamedTempFile::new().unwrap();
    std::io::copy(
        &mut archive.by_name("collection.anki2").unwrap(),
        database.as_file_mut(),
    )
    .unwrap();
    let connection = rusqlite::Connection::open(database.path()).unwrap();
    let mut query = connection
        .prepare("SELECT guid FROM notes ORDER BY guid")
        .unwrap();
    query
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}
#[test]
fn yaml_pack_streams_real_media_and_preserves_note_identity() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let mut value = fixture();
    let bytes = vec![42u8; 256 * 1024];
    fs::write(root.join("apple.mp3"), &bytes).unwrap();
    value.cards[0].data["audio"] = json!("apple.mp3");
    value.media.push(manifest::Media {
        name: "apple.mp3".into(),
        path: "apple.mp3".into(),
        sha256: Some(manifest::digest(&bytes)),
    });
    manifest::write(&root.join("anki.yaml"), &value).unwrap();
    let loaded = manifest::read(&root.join("anki.yaml")).unwrap();
    let report = archive::pack(&loaded, root).unwrap();
    assert_eq!(report["media"], 1);
    let path = root.join("deck.apkg");
    let (guid, fields) = note(&path);
    assert!(fields.contains("[sound:apple.mp3]"));
    let mut package = zip::ZipArchive::new(File::open(&path).unwrap()).unwrap();
    let mut actual = Vec::new();
    package
        .by_name("0")
        .unwrap()
        .read_to_end(&mut actual)
        .unwrap();
    assert_eq!(actual, bytes);
    drop(package);
    value.cards[0].data["chn"] = json!("手动修改");
    archive::pack(&value, root).unwrap();
    assert_eq!(note(&path).0, guid);
}
#[test]
fn invalid_media_never_replaces_previous_package() {
    let temp = tempfile::tempdir().unwrap();
    let mut value = fixture();
    archive::pack(&value, temp.path()).unwrap();
    let old = fs::read(temp.path().join("deck.apkg")).unwrap();
    value.cards[0].data["image"] = json!("missing.png");
    assert!(archive::pack(&value, temp.path()).is_err());
    assert_eq!(fs::read(temp.path().join("deck.apkg")).unwrap(), old);
}
#[test]
fn imports_original_projects_with_original_guid_algorithm() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    legacy::init(root, "Unit 2\napple").unwrap();
    fs::write(root.join(".anki-deck-id"), "12345").unwrap();
    let value = legacy::project(root).unwrap();
    assert_eq!(value.deck.id, 12345);
    assert_eq!(value.cards[0].data["unit"], 2);
    let path = root.join(&value.output);
    archive::pack(&value, root).unwrap();
    assert_eq!(note(&path).0, manifest::stable_guid("12345:apple.json"));
    legacy::init(root, "apple").unwrap();
    assert_eq!(legacy::project(root).unwrap().cards[0].data["unit"], 2);
}
#[test]
fn rejects_version_paths_collisions_and_duplicate_identities() {
    let mut value = fixture();
    value.version = 2;
    assert!(manifest::validate(&value).is_err());
    value.version = 1;
    value.output = "../deck.apkg".into();
    assert!(manifest::validate(&value).is_err());
    value.output = "deck.apkg".into();
    value.cards.push(value.cards[0].clone());
    assert!(manifest::validate(&value).is_err());
    let temp = tempfile::tempdir().unwrap();
    assert!(legacy::init(temp.path(), "a-b\na b").is_err());
}
#[test]
fn plans_media_with_references_instead_of_interpolating_card_data() {
    let input: plan::PlanInput = serde_json::from_value(json!({"cards":[{"name":"apple","chn":"苹果","example_en":"${param.secret}","image_prompt":"red apple"}],"deck_name":"英语","directory":"output","images":true,"audio":true,"voice":"fixture-voice"})).unwrap();
    let result = plan::build(input).unwrap();
    let nodes = result["spawn"]["nodes"].as_array().unwrap();
    assert_eq!(nodes.len(), 4);
    assert_eq!(nodes.last().unwrap()["config"]["timeoutMs"], 180000);
    let speech: &Value = &nodes[2]["config"]["request"]["input"];
    assert_eq!(speech, "${nodes.plan.outputs.result.cards.0.example_en}");
    assert!(!result["spawn"].to_string().contains("param.secret"));
}
#[test]
fn plans_without_vendor_voice_defaults_and_requires_an_explicit_audio_voice() {
    let mut input = json!({"cards":[{"name":"apple","chn":"苹果","example_en":"An apple."}],"deck_name":"English","directory":"output"});
    let result = plan::build(serde_json::from_value(input.clone()).unwrap()).unwrap();
    assert_eq!(result["voice"], "");
    assert_eq!(result["spawn"]["nodes"].as_array().unwrap().len(), 1);
    assert_eq!(result["spawn"]["nodes"][0]["config"]["timeoutMs"], 180000);
    input["audio"] = json!(true);
    assert!(plan::build(serde_json::from_value(input.clone()).unwrap())
        .unwrap_err()
        .to_string()
        .contains("Speech voice is required"));
    input["voice"] = json!("custom-voice");
    let result = plan::build(serde_json::from_value(input).unwrap()).unwrap();
    assert_eq!(result["voice"], "custom-voice");
    assert_eq!(
        result["spawn"]["nodes"][0]["config"]["connectionId"],
        "speech"
    );
}
#[test]
fn plans_one_large_package_and_preserves_same_word_in_different_units() {
    let mut cards: Vec<Value> = (0..303)
        .map(|index| json!({"name":format!("word-{index}"),"unit":1,"chn":"测试"}))
        .collect();
    cards.extend([
        json!({"name":"fair","unit":3,"chn":"公平","symbol":"source-symbol","custom":"keep"}),
        json!({"name":"fair","unit":8,"chn":"展销会"}),
    ]);
    let source = serde_json::to_string(&cards).unwrap();
    assert_eq!(
        plan::prepare(&source).unwrap()["cards"]
            .as_array()
            .unwrap()
            .len(),
        305
    );
    cards[303]["chn"] = json!("must not overwrite source");
    cards[303]["symbol"] = json!("generated-symbol");
    cards.reverse();
    let result = plan::build(
        serde_json::from_value(
            json!({"cards":cards,"source":source,"deck_name":"All units","directory":"output"}),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(result["manifest"]["cards"].as_array().unwrap().len(), 305);
    assert_eq!(result["cards"][303]["chn"], "公平");
    assert_eq!(result["cards"][303]["custom"], "keep");
    assert_eq!(result["cards"][303]["symbol"], "source-symbol");
    assert_eq!(result["cards"][304]["chn"], "展销会");
    assert_ne!(
        result["manifest"]["cards"][303]["id"],
        result["manifest"]["cards"][304]["id"]
    );
    assert_eq!(result["spawn"]["nodes"].as_array().unwrap().len(), 1);
    let mut manifest: manifest::Manifest =
        serde_json::from_value(result["manifest"].clone()).unwrap();
    manifest.cards = manifest.cards.split_off(303);
    let temp = tempfile::tempdir().unwrap();
    assert_eq!(archive::pack(&manifest, temp.path()).unwrap()["cards"], 2);
}
#[test]
fn rejects_same_unit_collisions_and_changed_generated_units() {
    assert!(plan::prepare(r#"[{"name":"fair","unit":3},{"name":"fair","unit":3}]"#).is_err());
    let input = json!({"cards":[{"name":"fair","unit":8,"chn":"展销会"}],"source":"[{\"name\":\"fair\",\"unit\":3}]","deck_name":"Units","directory":"output"});
    assert!(plan::build(serde_json::from_value(input).unwrap())
        .unwrap_err()
        .to_string()
        .contains("unit"));
}
#[test]
fn round_trips_same_word_across_units_with_image_prompts_and_stable_guids() {
    let cards = vec![
        json!({"name":"fair","unit":3,"chn":"公平","image_prompt":"A fair game <outside> & friends.\nSunny day."}),
        json!({"name":"fair","unit":8,"chn":"展销会","image_prompt":"A busy trade fair."}),
    ];
    let value = plan::manifest_from_cards(cards, "Units").unwrap();
    let temp = tempfile::tempdir().unwrap();
    archive::pack(&value, temp.path()).unwrap();
    let original_guids = guids(&temp.path().join("deck.apkg"));
    assert_eq!(original_guids.len(), 2);
    let output = temp.path().join("unpacked");
    anki_cli::markdown::unpack(&temp.path().join("deck.apkg"), &output).unwrap();
    let restored = manifest::read(&output.join("anki.manifest.yaml")).unwrap();
    assert_eq!(restored.cards.len(), 2);
    for (old, new) in value.cards.iter().zip(&restored.cards) {
        assert_eq!(old.id, new.id);
        assert_eq!(old.data["chn"], new.data["chn"]);
        assert_eq!(old.data["image_prompt"], new.data["image_prompt"]);
    }
    archive::pack(&restored, &output).unwrap();
    assert_eq!(original_guids, guids(&output.join("imported.apkg")));
}
#[test]
fn escapes_user_markup_in_anki_fields() {
    let temp = tempfile::tempdir().unwrap();
    let mut value = fixture();
    value.cards[0].data["chn"] = json!("<script>alert(1)</script>\n苹果");
    archive::pack(&value, temp.path()).unwrap();
    let fields = note(&temp.path().join("deck.apkg")).1;
    assert!(fields.contains("&lt;script&gt;"));
    assert!(!fields.contains("<script>"));
}
#[test]
fn fills_missing_text_without_overwriting_edits_and_invalidates_changed_media() {
    let old = json!({"name":"apple","chn":"手写释义","example_en":"My apple.","audio_example":"old.mp3","image_prompt":"Old scene","image":"old.png","unit":2,"custom":"keep"});
    let generated = json!({"name":"wrong","chn":"替换","symbol":"/æpl/","example_en":"New example.","image_prompt":"New scene"});
    let merged = legacy::merge_word(&old, &generated, false);
    assert_eq!(merged["name"], "apple");
    assert_eq!(merged["chn"], "手写释义");
    assert_eq!(merged["custom"], "keep");
    assert_eq!(merged["symbol"], "/æpl/");
    assert_eq!(merged["audio_example"], "old.mp3");
    let replaced = legacy::merge_word(&old, &generated, true);
    assert!(replaced["audio_example"].is_null());
    assert!(replaced["image"].is_null());
    assert_eq!(replaced["name"], "apple");
}
#[test]
fn reads_numeric_unit_markers_from_original_json_imports() {
    let cards = legacy::parse_words(r#"[{"name":"3"},{"name":"apple","chn":"苹果"}]"#).unwrap();
    assert_eq!(cards.len(), 1);
    assert_eq!(cards[0]["unit"], 3);
}
#[test]
fn round_trips_recitation_fields_and_media_through_apkg() {
    let temp = tempfile::tempdir().unwrap();
    let mut value = fixture();
    value.cards = vec![manifest::Card {
        id: "poem.json".into(),
        kind: "recite".into(),
        data: json!({"name":"A poem","author":"Author","text":"Line one\nLine two","text1":"Part one","hint1":"Hint","translate":"译文","audio1":"poem.mp3"}),
    }];
    fs::write(temp.path().join("poem.mp3"), b"audio").unwrap();
    value.media.push(manifest::Media {
        name: "poem.mp3".into(),
        path: "poem.mp3".into(),
        sha256: None,
    });
    archive::pack(&value, temp.path()).unwrap();
    let output = temp.path().join("unpacked");
    anki_cli::markdown::unpack(&temp.path().join("deck.apkg"), &output).unwrap();
    let restored = manifest::read(&output.join("anki.manifest.yaml")).unwrap();
    assert_eq!(restored.cards[0].kind, "recite");
    assert_eq!(restored.cards[0].data["text1"], "Part one");
    assert_eq!(restored.cards[0].data["audio1"], "poem.mp3");
    assert_eq!(fs::read(output.join("media/poem.mp3")).unwrap(), b"audio");
    archive::pack(&restored, &output).unwrap();
}
