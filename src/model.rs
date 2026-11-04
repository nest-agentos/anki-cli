use crate::manifest::{input_path, Manifest};
use anyhow::{ensure, Result};
use genanki_rs::{Field, Model, Template};
use serde::Deserialize;
use std::{fs, path::Path};

#[derive(Deserialize)]
struct ModelSpec {
    id: i64,
    name: String,
    flds: Vec<FieldSpec>,
    tmpls: Vec<TemplateSpec>,
    css: Option<String>,
    #[serde(rename = "type")]
    model_type: Option<i32>,
}
#[derive(Deserialize)]
struct FieldSpec {
    name: String,
}
#[derive(Deserialize)]
struct TemplateSpec {
    name: String,
    qfmt: String,
    afmt: String,
}

pub fn load(manifest: &Manifest, root: &Path) -> Result<Model> {
    let spec = read_spec(manifest, root)?;
    ensure!(
        spec.flds.len() == 51,
        "Template must use the anki-helper 51-field layout"
    );
    let fields = spec
        .flds
        .iter()
        .map(|field| Field::new(&field.name))
        .collect();
    let templates = spec
        .tmpls
        .iter()
        .map(|item| Template::new(&item.name).qfmt(&item.qfmt).afmt(&item.afmt))
        .collect();
    Ok(Model::new_with_options(
        spec.id,
        &spec.name,
        fields,
        templates,
        spec.css.as_deref(),
        None,
        None,
        Some(if spec.model_type == Some(1) { "1" } else { "0" }),
        None,
    ))
}

fn read_spec(manifest: &Manifest, root: &Path) -> Result<ModelSpec> {
    let text = match &manifest.template {
        Some(path) => fs::read_to_string(input_path(root, path)?)?,
        None => include_str!("../template/ankimodel.json").to_string(),
    };
    let spec: ModelSpec = serde_json::from_str(&text)?;
    Ok(spec)
}
