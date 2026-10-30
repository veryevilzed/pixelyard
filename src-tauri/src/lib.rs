use tauri::ipc::{InvokeBody, Request, Response};
use std::sync::Mutex;
use tauri::menu::{Menu, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager};

/// Файлы, открытые через Finder (двойной клик по .pyard и т.п.) до того, как интерфейс готов.
#[derive(Default)]
struct OpenedFiles(Mutex<Vec<String>>);

/// Интерфейс забирает накопленные пути при старте; дальше приходят события "open-files".
#[tauri::command]
fn take_opened_files(state: tauri::State<OpenedFiles>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap())
}

/// Кодирует RGBA в WebP: WebKit не умеет canvas.toBlob("image/webp").
/// Пиксели приходят сырым телом запроса, параметры — в заголовках.
#[tauri::command]
fn encode_webp(request: Request) -> Result<Response, String> {
    let InvokeBody::Raw(data) = request.body() else {
        return Err("ожидались сырые RGBA-данные".into());
    };
    let header = |name: &str| -> Result<String, String> {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
            .ok_or_else(|| format!("нет заголовка {name}"))
    };
    let width: u32 = header("x-width")?.parse().map_err(|e| format!("x-width: {e}"))?;
    let height: u32 = header("x-height")?.parse().map_err(|e| format!("x-height: {e}"))?;
    let quality: f32 = header("x-quality")?.parse().map_err(|e| format!("x-quality: {e}"))?;
    if data.len() != (width as usize) * (height as usize) * 4 {
        return Err("размер данных не совпадает с width*height*4".into());
    }
    let encoder = webp::Encoder::from_rgba(data, width, height);
    let encoded = if quality >= 100.0 {
        encoder.encode_lossless()
    } else {
        encoder.encode(quality)
    };
    Ok(Response::new(encoded.to_vec()))
}

/// Нативное меню содержит только пункты приложения и окна: стандартное меню
/// «Правка» перехватывает Cmd+Z/C/V/A до WebView, а эти сочетания обрабатывает
/// сам редактор.
fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let app_menu = Submenu::with_items(
        app,
        "PixelYard",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let window_menu = Submenu::with_items(
        app,
        "Окно",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    Menu::with_items(app, &[&app_menu, &window_menu])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(OpenedFiles::default())
        .menu(build_menu)
        .invoke_handler(tauri::generate_handler![encode_webp, take_opened_files])
        .build(tauri::generate_context!())
        .expect("ошибка запуска PixelYard")
        .run(|app, event| {
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let tauri::RunEvent::Opened { urls } = event {
                let paths: Vec<String> = urls
                    .iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect();
                if paths.is_empty() {
                    return;
                }
                app.state::<OpenedFiles>().0.lock().unwrap().extend(paths.clone());
                let _ = app.emit("open-files", paths);
            }
            #[cfg(not(any(target_os = "macos", target_os = "ios")))]
            let _ = (app, event);
        });
}
