use rts_core::maps::MapDefinition;
use std::process::ExitCode;

fn main() -> ExitCode {
    let paths: Vec<_> = std::env::args().skip(1).collect();
    if paths.is_empty() {
        eprintln!("Usage: validate_map <map.json> [map.json ...]");
        return ExitCode::FAILURE;
    }
    let mut failed = false;
    for path in paths {
        let result = std::fs::read_to_string(&path)
            .map_err(|error| error.to_string())
            .and_then(|source| MapDefinition::parse(&source));
        match result {
            Ok(map) => println!(
                "{}: {} v{}, {} starts, {} deposits, {} obstacles; static routes valid",
                path,
                map.id,
                map.version,
                map.starts.len(),
                map.deposits.len(),
                map.terrain.len()
            ),
            Err(error) => {
                eprintln!("{}: {}", path, error);
                failed = true;
            }
        }
    }
    if failed {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}
