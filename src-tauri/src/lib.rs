use std::{
    collections::HashSet,
    fs,
    io::{BufReader, Cursor},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use image::{
    codecs::{
        gif::{GifDecoder, GifEncoder, Repeat},
        jpeg::JpegEncoder,
        png::{CompressionType, FilterType as PngFilterType, PngEncoder},
        webp::WebPEncoder,
    },
    imageops::FilterType,
    AnimationDecoder, DynamicImage, Frame, GenericImageView, ImageDecoder, ImageEncoder,
};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;

const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp", "gif", "avif", "tif", "tiff"];

#[derive(Default)]
struct SelectedFolders {
    input: Option<PathBuf>,
    output: Option<PathBuf>,
    export: Option<PathBuf>,
}

#[derive(Default)]
struct DesktopState {
    watcher: Mutex<Option<RecommendedWatcher>>,
    watcher_settings: Mutex<Option<WatcherSettings>>,
    folders: Mutex<SelectedFolders>,
    source_files: Mutex<HashSet<PathBuf>>,
    processing: Arc<Mutex<HashSet<PathBuf>>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WatcherSettings {
    input_folder: String,
    output_folder: String,
    mode: String,
    quality: u8,
    scale: f64,
    format: String,
    resize: bool,
    max_width: u32,
    max_height: u32,
    strip_metadata: bool,
    #[serde(default = "default_true")]
    prevent_larger: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeImage {
    name: String,
    #[serde(rename = "type")]
    mime_type: String,
    path: String,
    data: String,
}

#[derive(Serialize)]
struct ClipboardImage {
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WatcherEvent {
    id: String,
    #[serde(rename = "type")]
    event_type: String,
    file: Option<String>,
    output: Option<String>,
    original_bytes: Option<u64>,
    output_bytes: Option<u64>,
    message: Option<String>,
    time: u128,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WatcherState {
    active: bool,
    settings: Option<WatcherSettings>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeExportItem {
    source_path: Option<String>,
    output_name: String,
    data: Vec<u8>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportPayload {
    mode: String,
    #[allow(dead_code)]
    suffix: String,
    fixed_folder: Option<String>,
    items: Vec<NativeExportItem>,
}

#[derive(Serialize)]
struct CommandResult {
    ok: bool,
    paths: Option<Vec<String>>,
    error: Option<String>,
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn watcher_event(event_type: &str, message: Option<String>) -> WatcherEvent {
    let time = now_ms();
    WatcherEvent {
        id: format!("{time:x}-{:x}", std::process::id()),
        event_type: event_type.to_string(),
        file: None,
        output: None,
        original_bytes: None,
        output_bytes: None,
        message,
        time,
    }
}

fn emit_event(app: &AppHandle, event: WatcherEvent) {
    let _ = app.emit("watcher:event", event);
}

fn is_image(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| IMAGE_EXTENSIONS.contains(&value.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "avif" => "image/avif",
        "tif" | "tiff" => "image/tiff",
        _ => "application/octet-stream",
    }
}

fn extension_for(path: &Path, format: &str) -> String {
    match format {
        "image/jpeg" => "jpg".to_string(),
        "image/png" => "png".to_string(),
        "image/webp" => "webp".to_string(),
        _ => path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("png")
            .to_ascii_lowercase(),
    }
}

fn safe_file_name(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if "<>:\"/\\|?*\0".contains(character) || character.is_control() {
                '-'
            } else {
                character
            }
        })
        .collect::<String>()
}

fn available_path(directory: &Path, requested_name: &str) -> Result<PathBuf, String> {
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let safe = safe_file_name(requested_name);
    let requested = Path::new(&safe);
    let extension = requested
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let base = requested
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("piclite");
    for index in 1..10_000 {
        let name = if index == 1 || extension.is_empty() {
            if index == 1 {
                safe.clone()
            } else {
                format!("{base}-{index}")
            }
        } else {
            format!("{base}-{index}.{extension}")
        };
        let candidate = directory.join(name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("无法生成不冲突的文件名".to_string())
}

fn target_dimensions(width: u32, height: u32, settings: &WatcherSettings) -> (u32, u32) {
    let mut ratio = (settings.scale / 100.0).clamp(0.001, 1.0);
    if settings.resize {
        ratio = ratio
            .min(settings.max_width.max(1) as f64 / width.max(1) as f64)
            .min(settings.max_height.max(1) as f64 / height.max(1) as f64);
    }
    (
        ((width as f64 * ratio).round() as u32).max(1),
        ((height as f64 * ratio).round() as u32).max(1),
    )
}

fn quantize_rgba(image: &mut image::RgbaImage, quality: u8) {
    if quality >= 100 {
        return;
    }
    let normalized = (quality.max(1) as f32 - 1.0) / 99.0;
    let levels = (2.0 + 254.0 * normalized.powf(1.7))
        .round()
        .clamp(2.0, 256.0);
    let step = 255.0 / (levels - 1.0);
    for pixel in image.pixels_mut() {
        for channel in &mut pixel.0[..3] {
            *channel = ((*channel as f32 / step).round() * step).clamp(0.0, 255.0) as u8;
        }
    }
}

fn guarded_quality_steps(quality: u8) -> Vec<u8> {
    let mut steps = Vec::new();
    for offset in [4_u8, 8, 14, 22, 32, 44, 58, 72, 99] {
        let candidate = quality.saturating_sub(offset).max(1);
        if candidate < quality && !steps.contains(&candidate) {
            steps.push(candidate);
        }
    }
    steps
}

fn encode_gif(original: &[u8], width: u32, height: u32, quality: u8) -> Result<Vec<u8>, String> {
    let decoder = GifDecoder::new(BufReader::new(Cursor::new(original)))
        .map_err(|error| error.to_string())?;
    let frames = decoder
        .into_frames()
        .collect_frames()
        .map_err(|error| error.to_string())?;
    let mut encoded = Vec::new();
    {
        let speed = (31_u8.saturating_sub((quality as u16 * 30 / 100) as u8)).clamp(1, 30) as i32;
        let mut encoder = GifEncoder::new_with_speed(&mut encoded, speed);
        encoder
            .set_repeat(Repeat::Infinite)
            .map_err(|error| error.to_string())?;
        for frame in frames {
            let delay = frame.delay();
            let mut buffer = frame.into_buffer();
            if buffer.width() != width || buffer.height() != height {
                buffer = image::imageops::resize(&buffer, width, height, FilterType::Lanczos3);
            }
            quantize_rgba(&mut buffer, quality);
            encoder
                .encode_frame(Frame::from_parts(buffer, 0, 0, delay))
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(encoded)
}

fn encode_static(
    mut image: DynamicImage,
    output_extension: &str,
    quality: u8,
) -> Result<Vec<u8>, String> {
    let mut encoded = Vec::new();
    match output_extension {
        "jpg" | "jpeg" => {
            let rgb = image.to_rgb8();
            JpegEncoder::new_with_quality(&mut encoded, quality.max(1))
                .encode(
                    &rgb,
                    rgb.width(),
                    rgb.height(),
                    image::ExtendedColorType::Rgb8,
                )
                .map_err(|error| error.to_string())?;
        }
        "png" => {
            if quality < 100 {
                let mut rgba = image.to_rgba8();
                quantize_rgba(&mut rgba, quality);
                image = DynamicImage::ImageRgba8(rgba);
            }
            let rgba = image.to_rgba8();
            PngEncoder::new_with_quality(
                &mut encoded,
                CompressionType::Best,
                PngFilterType::Adaptive,
            )
            .write_image(
                &rgba,
                rgba.width(),
                rgba.height(),
                image::ExtendedColorType::Rgba8,
            )
            .map_err(|error| error.to_string())?;
        }
        "webp" => {
            let rgba = image.to_rgba8();
            WebPEncoder::new_lossless(&mut encoded)
                .write_image(
                    &rgba,
                    rgba.width(),
                    rgba.height(),
                    image::ExtendedColorType::Rgba8,
                )
                .map_err(|error| error.to_string())?;
        }
        _ => return Err(format!("自动监测暂不支持编码 .{output_extension}")),
    }
    Ok(encoded)
}

fn optimize_bytes(path: &Path, settings: &WatcherSettings) -> Result<Vec<u8>, String> {
    let original = fs::read(path).map_err(|error| error.to_string())?;
    let source_extension = extension_for(path, "keep");
    if source_extension == "gif" && settings.format == "keep" {
        let decoder = GifDecoder::new(BufReader::new(Cursor::new(&original)))
            .map_err(|error| error.to_string())?;
        let (width, height) = decoder.dimensions();
        let (target_width, target_height) = target_dimensions(width, height, settings);
        let candidate = encode_gif(&original, target_width, target_height, settings.quality)?;
        let visual_transform = target_width != width || target_height != height;
        if settings.prevent_larger && candidate.len() >= original.len() {
            if visual_transform {
                for quality in guarded_quality_steps(settings.quality) {
                    let guarded = encode_gif(&original, target_width, target_height, quality)?;
                    if guarded.len() < original.len() {
                        return Ok(guarded);
                    }
                }
            }
            return Ok(original);
        }
        return Ok(candidate);
    }

    let decoded = image::load_from_memory(&original).map_err(|error| error.to_string())?;
    let (width, height) = decoded.dimensions();
    let (target_width, target_height) = target_dimensions(width, height, settings);
    let resized = if target_width != width || target_height != height {
        decoded.resize_exact(target_width, target_height, FilterType::Lanczos3)
    } else {
        decoded
    };
    let output_extension = extension_for(path, &settings.format);
    let candidate = encode_static(resized.clone(), &output_extension, settings.quality)?;
    let visual_transform =
        target_width != width || target_height != height || settings.format != "keep";
    if settings.prevent_larger && candidate.len() >= original.len() {
        if visual_transform {
            for quality in guarded_quality_steps(settings.quality) {
                let guarded = encode_static(resized.clone(), &output_extension, quality)?;
                if guarded.len() < original.len() {
                    return Ok(guarded);
                }
            }
        }
        return Ok(original);
    }
    Ok(candidate)
}

fn process_watched_file(
    app: AppHandle,
    path: PathBuf,
    settings: WatcherSettings,
    processing: Arc<Mutex<HashSet<PathBuf>>>,
) {
    let canonical = fs::canonicalize(&path).unwrap_or(path.clone());
    {
        let mut active = processing
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !active.insert(canonical.clone()) {
            return;
        }
    }
    thread::sleep(Duration::from_millis(750));
    let result = (|| -> Result<(PathBuf, u64, u64), String> {
        let metadata = fs::metadata(&canonical).map_err(|error| error.to_string())?;
        let original_bytes = metadata.len();
        let output_directory = if settings.output_folder.is_empty() {
            PathBuf::from(&settings.input_folder).join("PicLite")
        } else {
            PathBuf::from(&settings.output_folder)
        };
        let extension = extension_for(&canonical, &settings.format);
        let base = canonical
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("image");
        let output_path =
            available_path(&output_directory, &format!("{base}-piclite.{extension}"))?;
        let bytes = optimize_bytes(&canonical, &settings)?;
        fs::write(&output_path, &bytes).map_err(|error| error.to_string())?;
        Ok((output_path, original_bytes, bytes.len() as u64))
    })();

    match result {
        Ok((output_path, original_bytes, output_bytes)) => {
            let mut event = watcher_event("success", None);
            event.file = canonical
                .file_name()
                .and_then(|value| value.to_str())
                .map(str::to_string);
            event.output = Some(output_path.to_string_lossy().to_string());
            event.original_bytes = Some(original_bytes);
            event.output_bytes = Some(output_bytes);
            emit_event(&app, event);
        }
        Err(error) => {
            let mut event = watcher_event("error", Some(error));
            event.file = canonical
                .file_name()
                .and_then(|value| value.to_str())
                .map(str::to_string);
            emit_event(&app, event);
        }
    }
    processing
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&canonical);
}

#[tauri::command]
async fn select_folder(
    app: AppHandle,
    state: State<'_, DesktopState>,
    kind: String,
) -> Result<Option<String>, String> {
    let Some(selected) = app
        .dialog()
        .file()
        .set_can_create_directories(true)
        .blocking_pick_folder()
    else {
        return Ok(None);
    };
    let path = selected.into_path().map_err(|error| error.to_string())?;
    let path = fs::canonicalize(&path).unwrap_or(path);
    let mut folders = state
        .folders
        .lock()
        .map_err(|_| "文件夹状态不可用".to_string())?;
    match kind.as_str() {
        "input" => folders.input = Some(path.clone()),
        "output" => folders.output = Some(path.clone()),
        "export" => folders.export = Some(path.clone()),
        _ => return Err("不支持的文件夹类型".to_string()),
    }
    Ok(Some(path.to_string_lossy().to_string()))
}

#[tauri::command]
async fn select_images(
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<Vec<NativeImage>, String> {
    let Some(files) = app
        .dialog()
        .file()
        .add_filter("图片", IMAGE_EXTENSIONS)
        .blocking_pick_files()
    else {
        return Ok(Vec::new());
    };
    let mut images = Vec::new();
    for selected in files {
        let path = selected.into_path().map_err(|error| error.to_string())?;
        if !is_image(&path) {
            continue;
        }
        let canonical = fs::canonicalize(&path).unwrap_or(path);
        let data = fs::read(&canonical).map_err(|error| error.to_string())?;
        state
            .source_files
            .lock()
            .map_err(|_| "文件授权状态不可用".to_string())?
            .insert(canonical.clone());
        images.push(NativeImage {
            name: canonical
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("image")
                .to_string(),
            mime_type: mime_for(&canonical).to_string(),
            path: canonical.to_string_lossy().to_string(),
            data: BASE64.encode(data),
        });
    }
    Ok(images)
}

#[tauri::command]
async fn read_clipboard_image() -> Result<Option<ClipboardImage>, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|error| error.to_string())?;
    let image = match clipboard.get_image() {
        Ok(image) => image,
        Err(arboard::Error::ContentNotAvailable) => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let mut png = Vec::new();
    PngEncoder::new_with_quality(&mut png, CompressionType::Best, PngFilterType::Adaptive)
        .write_image(
            &image.bytes,
            image.width as u32,
            image.height as u32,
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|error| error.to_string())?;
    Ok(Some(ClipboardImage {
        data: BASE64.encode(png),
    }))
}

#[tauri::command]
async fn export_images(
    payload: ExportPayload,
    state: State<'_, DesktopState>,
) -> Result<CommandResult, String> {
    let result = (|| -> Result<Vec<String>, String> {
        if payload.items.is_empty() {
            return Err("没有可导出的图片".to_string());
        }
        if !matches!(
            payload.mode.as_str(),
            "overwrite" | "same-folder" | "fixed-folder"
        ) {
            return Err("不支持的导出方式".to_string());
        }
        let fixed_folder = if payload.mode == "fixed-folder" {
            payload
                .fixed_folder
                .as_deref()
                .map(PathBuf::from)
                .or_else(|| state.folders.lock().ok()?.export.clone())
                .ok_or_else(|| "请先选择固定输出文件夹".to_string())?
        } else {
            PathBuf::new()
        };
        let authorized = state
            .source_files
            .lock()
            .map_err(|_| "文件授权状态不可用".to_string())?;
        let mut paths = Vec::new();
        for item in payload.items {
            let source = item.source_path.as_deref().map(PathBuf::from);
            if matches!(payload.mode.as_str(), "overwrite" | "same-folder") {
                let Some(path) = source.as_ref() else {
                    return Err("这张图片没有源文件路径".to_string());
                };
                let canonical = fs::canonicalize(path).unwrap_or_else(|_| path.clone());
                if !authorized.contains(&canonical) {
                    return Err("源文件没有经过文件选择器授权".to_string());
                }
            }
            let target = match payload.mode.as_str() {
                "overwrite" => source.ok_or_else(|| "缺少源文件路径".to_string())?,
                "same-folder" => {
                    let source = source.ok_or_else(|| "缺少源文件路径".to_string())?;
                    available_path(
                        source
                            .parent()
                            .ok_or_else(|| "无法定位源文件夹".to_string())?,
                        &item.output_name,
                    )?
                }
                _ => available_path(&fixed_folder, &item.output_name)?,
            };
            if payload.mode == "overwrite" {
                fs::write(&target, item.data).map_err(|error| error.to_string())?;
            } else {
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                }
                fs::write(&target, item.data).map_err(|error| error.to_string())?;
            }
            paths.push(target.to_string_lossy().to_string());
        }
        Ok(paths)
    })();
    Ok(match result {
        Ok(paths) => CommandResult {
            ok: true,
            paths: Some(paths),
            error: None,
        },
        Err(error) => CommandResult {
            ok: false,
            paths: None,
            error: Some(error),
        },
    })
}

#[tauri::command]
async fn start_watcher(
    app: AppHandle,
    settings: WatcherSettings,
    state: State<'_, DesktopState>,
) -> Result<CommandResult, String> {
    let result = (|| -> Result<(), String> {
        if settings.input_folder.is_empty() {
            return Err("请选择来源文件夹".to_string());
        }
        let input =
            fs::canonicalize(&settings.input_folder).map_err(|_| "来源文件夹不存在".to_string())?;
        let folders = state
            .folders
            .lock()
            .map_err(|_| "文件夹状态不可用".to_string())?;
        if folders.input.as_ref() != Some(&input) {
            return Err("请通过文件夹选择器确认来源位置".to_string());
        }
        let output = if settings.output_folder.is_empty() {
            input.join("PicLite")
        } else {
            PathBuf::from(&settings.output_folder)
        };
        drop(folders);

        if let Some(mut previous) = state
            .watcher
            .lock()
            .map_err(|_| "监测状态不可用".to_string())?
            .take()
        {
            let _ = previous.unwatch(&input);
        }
        let app_handle = app.clone();
        let watcher_settings = settings.clone();
        let processing = state.processing.clone();
        let input_for_callback = input.clone();
        let output_for_callback = output.clone();
        let mut watcher = notify::recommended_watcher(
            move |result: notify::Result<notify::Event>| match result {
                Ok(event) if matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) => {
                    for path in event.paths {
                        if !is_image(&path)
                            || path.starts_with(&output_for_callback)
                            || !path.starts_with(&input_for_callback)
                        {
                            continue;
                        }
                        let app = app_handle.clone();
                        let settings = watcher_settings.clone();
                        let processing = processing.clone();
                        thread::spawn(move || {
                            process_watched_file(app, path, settings, processing)
                        });
                    }
                }
                Err(error) => {
                    emit_event(&app_handle, watcher_event("error", Some(error.to_string())))
                }
                _ => {}
            },
        )
        .map_err(|error| error.to_string())?;
        watcher
            .watch(&input, RecursiveMode::Recursive)
            .map_err(|error| error.to_string())?;
        *state
            .watcher
            .lock()
            .map_err(|_| "监测状态不可用".to_string())? = Some(watcher);
        *state
            .watcher_settings
            .lock()
            .map_err(|_| "监测设置不可用".to_string())? = Some(settings.clone());
        emit_event(
            &app,
            watcher_event(
                "started",
                Some(format!("正在监测 {}", input.to_string_lossy())),
            ),
        );
        Ok(())
    })();
    Ok(match result {
        Ok(()) => CommandResult {
            ok: true,
            paths: None,
            error: None,
        },
        Err(error) => CommandResult {
            ok: false,
            paths: None,
            error: Some(error),
        },
    })
}

#[tauri::command]
async fn stop_watcher(
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<CommandResult, String> {
    state
        .watcher
        .lock()
        .map_err(|_| "监测状态不可用".to_string())?
        .take();
    state
        .watcher_settings
        .lock()
        .map_err(|_| "监测设置不可用".to_string())?
        .take();
    emit_event(
        &app,
        watcher_event("stopped", Some("文件夹监测已停止".to_string())),
    );
    Ok(CommandResult {
        ok: true,
        paths: None,
        error: None,
    })
}

#[tauri::command]
async fn get_watcher_state(state: State<'_, DesktopState>) -> Result<WatcherState, String> {
    let active = state
        .watcher
        .lock()
        .map_err(|_| "监测状态不可用".to_string())?
        .is_some();
    let settings = state
        .watcher_settings
        .lock()
        .map_err(|_| "监测设置不可用".to_string())?
        .clone();
    Ok(WatcherState { active, settings })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(DesktopState::default())
        .invoke_handler(tauri::generate_handler![
            select_folder,
            select_images,
            read_clipboard_image,
            export_images,
            start_watcher,
            stop_watcher,
            get_watcher_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running PicLite");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resizing_a_precompressed_jpeg_never_increases_file_size() {
        let mut pixels = image::RgbImage::new(640, 360);
        for (x, y, pixel) in pixels.enumerate_pixels_mut() {
            *pixel = image::Rgb([
                ((x * 3 + y) % 256) as u8,
                ((x + y * 2) % 256) as u8,
                ((x / 3 + y / 2) % 256) as u8,
            ]);
        }
        let original =
            encode_static(DynamicImage::ImageRgb8(pixels), "jpg", 18).expect("encode source jpeg");
        let path = std::env::temp_dir().join(format!(
            "piclite-size-guard-{}-{}.jpg",
            std::process::id(),
            now_ms()
        ));
        fs::write(&path, &original).expect("write source jpeg");
        let settings = WatcherSettings {
            input_folder: String::new(),
            output_folder: String::new(),
            mode: "lossless".to_string(),
            quality: 100,
            scale: 75.0,
            format: "keep".to_string(),
            resize: false,
            max_width: 2560,
            max_height: 2560,
            strip_metadata: true,
            prevent_larger: true,
        };

        let optimized = optimize_bytes(&path, &settings).expect("optimize jpeg");
        let dimensions = image::load_from_memory(&optimized)
            .expect("decode optimized jpeg")
            .dimensions();
        let _ = fs::remove_file(&path);

        assert_eq!(dimensions, (480, 270));
        assert!(
            optimized.len() < original.len(),
            "{} should be smaller than {}",
            optimized.len(),
            original.len()
        );
    }

    #[test]
    fn guarded_quality_steps_are_unique_and_descending() {
        let steps = guarded_quality_steps(100);
        assert!(steps.windows(2).all(|pair| pair[0] > pair[1]));
        assert_eq!(steps.last(), Some(&1));
    }
}
