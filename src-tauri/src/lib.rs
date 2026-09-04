use tauri::{Manager, PhysicalPosition};

// Where we want the cursor to land relative to the new window's
// top-left, in LOGICAL (CSS) pixels. Picked to put the cursor near the
// center of the first (torn-off) tab:
//   X ≈ half of min-tab-width (120px).
//   Y ≈ OS title bar (~32px) + markon #bar toolbar (~40px) + half of
//       tab-bar height (~17px) ≈ 85px.
// We convert to physical via scale_factor so the landing spot is
// correct across DPI settings.
const GRAB_OFFSET_X: f64 = 60.0;
const GRAB_OFFSET_Y: f64 = 85.0;

// Atomic "snap window under cursor + start native drag" for Chrome-style
// tear-off. Cursor position is queried directly from the OS inside this
// command — NOT passed in from JS — so there's no ferry-through-IPC
// drift. The gap between reading the cursor and calling start_dragging
// is a handful of microseconds, which is the tightest we can get
// without reimplementing the drag loop ourselves.
#[tauri::command]
async fn snap_and_drag(window: tauri::Window) -> Result<(), String> {
  let cursor = window.cursor_position().map_err(|e| e.to_string())?;
  let scale = window.scale_factor().map_err(|e| e.to_string())?;
  let off_x = GRAB_OFFSET_X * scale;
  let off_y = GRAB_OFFSET_Y * scale;
  window
    .set_position(PhysicalPosition::new(
      (cursor.x - off_x) as i32,
      (cursor.y - off_y) as i32,
    ))
    .map_err(|e| e.to_string())?;
  window.start_dragging().map_err(|e| e.to_string())?;
  Ok(())
}

// Grant the asset protocol access only to an image requested by the preview.
#[tauri::command]
fn allow_preview_asset(window: tauri::Window, path: String) -> Result<(), String> {
  window
    .state::<tauri::scope::Scopes>()
    .allow_file(path)
    .map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_cli::init())
    .plugin(tauri_plugin_opener::init())
    .invoke_handler(tauri::generate_handler![snap_and_drag, allow_preview_asset])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
