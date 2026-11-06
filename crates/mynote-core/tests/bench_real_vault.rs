//! Timings against a real workspace (read-only): `MYNOTE_BENCH=~/Documents/mynote cargo test -p mynote-core --release --test bench_real_vault -- --ignored --nocapture`
use mynote_core::vault;
use std::path::PathBuf;
use std::time::Instant;

#[test]
#[ignore]
fn timings() {
    // Legacy name (before the rename to MyNote): BETELGEUSE_BENCH.
    let Ok(dir) = std::env::var("MYNOTE_BENCH").or_else(|_| std::env::var("BETELGEUSE_BENCH")) else { return };
    let ws = PathBuf::from(dir);
    let t = Instant::now();
    let notes = vault::list_notes(&ws);
    println!("list_notes: {} pages in {:?}", notes.len(), t.elapsed());
    let t = Instant::now();
    let n = vault::list_notes(&ws).len();
    println!("list_notes (warm): {n} in {:?}", t.elapsed());
    let t = Instant::now();
    let hits = vault::search(&ws, "content");
    println!("search: {} hits in {:?}", hits.len(), t.elapsed());
    let t = Instant::now();
    let b = vault::backlinks(&ws, "Areas/Content Studio.md");
    println!("backlinks: {} in {:?}", b.len(), t.elapsed());
    let t = Instant::now();
    let rows = vault::database_rows(&ws, "Areas/Content Studio/StudioDB.md").unwrap();
    println!("database_rows: {} in {:?}", rows.len(), t.elapsed());
}
