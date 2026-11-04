use anki_cli::{archive, legacy, manifest, markdown, plan};
use anyhow::Result;
use clap::{Parser, Subcommand};
use serde_json::{json, Value};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

#[derive(Parser)]
#[command(version, about)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    Pack {
        source: PathBuf,
    },
    Validate {
        manifest: PathBuf,
    },
    Manifest {
        #[arg(long, default_value = "-")]
        input: String,
        #[arg(long)]
        output: PathBuf,
    },
    Migrate {
        project: PathBuf,
        #[arg(long)]
        output: Option<PathBuf>,
    },
    Init {
        project: PathBuf,
        #[arg(long)]
        input: Option<PathBuf>,
    },
    Merge {
        project: PathBuf,
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        replace: bool,
    },
    Md {
        source: PathBuf,
        #[arg(short, long)]
        output: PathBuf,
    },
    Pkg2md {
        source: PathBuf,
        #[arg(short, long)]
        output: PathBuf,
    },
    Plan,
    Prepare,
}
fn main() {
    match execute(Cli::parse().command) {
        Ok(value) => println!("{}", value),
        Err(error) => {
            eprintln!("{}", json!({"error":format!("{error:#}")}));
            std::process::exit(1);
        }
    }
}
fn stdin() -> Result<String> {
    let mut value = String::new();
    std::io::stdin().read_to_string(&mut value)?;
    Ok(value)
}
fn load(source: &Path) -> Result<(manifest::Manifest, PathBuf)> {
    if source.is_dir() {
        return Ok((legacy::project(source)?, source.canonicalize()?));
    }
    Ok((
        manifest::read(source)?,
        source.canonicalize()?.parent().unwrap().to_owned(),
    ))
}
fn execute(command: Command) -> Result<Value> {
    match command {
        Command::Pack { source } => pack(&source),
        Command::Validate { manifest: path } => validate(&path),
        Command::Manifest { input, output } => write_manifest(&input, &output),
        Command::Migrate { project, output } => migrate(&project, output),
        Command::Init { project, input } => init(&project, input),
        Command::Merge {
            project,
            input,
            replace,
        } => legacy::merge_project(&project, &fs::read_to_string(input)?, replace),
        Command::Md { source, output } => markdown(&source, &output),
        Command::Pkg2md { source, output } => markdown::unpack(&source, &output),
        other => model_tool(other),
    }
}
fn pack(source: &Path) -> Result<Value> {
    let (value, root) = load(source)?;
    let result = archive::pack(&value, &root)?;
    if source.is_dir() && !root.join(".anki-deck-id").exists() {
        manifest::atomic_write(
            &root.join(".anki-deck-id"),
            value.deck.id.to_string().as_bytes(),
        )?;
    }
    Ok(result)
}
fn validate(path: &Path) -> Result<Value> {
    let value = manifest::read(path)?;
    Ok(json!({"valid":true,"cards":value.cards.len()}))
}
fn write_manifest(input: &str, output: &Path) -> Result<Value> {
    let text = if input == "-" {
        stdin()?
    } else {
        fs::read_to_string(input)?
    };
    let value: manifest::Manifest = serde_json::from_str(&text)?;
    manifest::write(output, &value)?;
    Ok(json!({"output":output}))
}
fn migrate(project: &Path, output: Option<PathBuf>) -> Result<Value> {
    let value = legacy::project(project)?;
    let output = output.unwrap_or_else(|| project.join("anki.manifest.yaml"));
    anyhow::ensure!(
        output.parent().unwrap_or(Path::new(".")).canonicalize()? == project.canonicalize()?,
        "Migration manifest must stay in the project directory"
    );
    manifest::write(&output, &value)?;
    Ok(json!({"output":output,"cards":value.cards.len()}))
}
fn init(project: &Path, input: Option<PathBuf>) -> Result<Value> {
    let input = input.unwrap_or_else(|| project.join("index.json"));
    legacy::init(project, &fs::read_to_string(input)?)
}
fn markdown(source: &Path, output: &Path) -> Result<Value> {
    let (value, _) = load(source)?;
    manifest::atomic_write(output, markdown::render(&value).as_bytes())?;
    Ok(json!({"output":output}))
}
fn model_tool(command: Command) -> Result<Value> {
    let value: Value = serde_json::from_str(&stdin()?)?;
    match command {
        Command::Plan => plan::build(serde_json::from_value(value)?),
        Command::Prepare => plan::prepare(
            value["source"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("Word source is required"))?,
        ),
        _ => anyhow::bail!("Unexpected model tool command"),
    }
}
