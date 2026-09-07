fn main() {
    // Generates the permission schemas that `capabilities/*.json` is validated
    // against, and on macOS/Windows the bundle metadata. Nothing to configure:
    // everything this reads is in tauri.conf.json.
    tauri_build::build()
}
