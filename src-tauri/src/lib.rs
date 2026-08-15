use std::{
    borrow::Cow,
    collections::{BTreeMap, HashSet},
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Cursor, Write},
    net::{Shutdown, TcpStream},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chrono::{Local, Utc};
use hmac::{Hmac, Mac};
use image::{
    codecs::{
        gif::{GifDecoder, GifEncoder, Repeat},
        jpeg::JpegEncoder,
        png::{CompressionType, FilterType as PngFilterType, PngEncoder},
    },
    imageops::FilterType,
    AnimationDecoder, DynamicImage, Frame, GenericImageView, ImageDecoder, ImageEncoder,
};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use reqwest::{blocking::Client, Method, StatusCode};
use serde::{Deserialize, Serialize};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use ssh2::{CheckResult, KnownHostFileKind, Session};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, State, Theme, WindowEvent,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use url::Url;
use webp::{AnimEncoder as AnimatedWebPEncoder, AnimFrame as AnimatedWebPFrame};
use webp::{Encoder as LossyWebPEncoder, WebPConfig};

const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp", "gif", "avif", "tif", "tiff"];

#[derive(Default)]
struct SelectedFolders {
    input: Option<PathBuf>,
    output: Option<PathBuf>,
    export: Option<PathBuf>,
}

struct DesktopState {
    watcher: Mutex<Option<RecommendedWatcher>>,
    watcher_settings: Mutex<Option<WatcherSettings>>,
    folders: Mutex<SelectedFolders>,
    source_files: Mutex<HashSet<PathBuf>>,
    pending_corner_drop: Mutex<Vec<String>>,
    processing: Arc<Mutex<HashSet<PathBuf>>>,
    quitting: AtomicBool,
    tray_available: AtomicBool,
    minimize_to_tray: AtomicBool,
    clipboard_monitor_enabled: AtomicBool,
    /// Timestamp until which clipboard content was written by PicLite itself.
    /// The monitor must record it but must not feed the result back through the
    /// compressor, otherwise a copied result would be compressed repeatedly.
    clipboard_ignore_until_ms: AtomicU64,
    shortcut_config_lock: Mutex<()>,
    /// The drop window is placed in its initial corner exactly once. Later
    /// show/resize calls preserve the position selected by dragging it.
    dropzone_positioned: AtomicBool,
}

impl Default for DesktopState {
    fn default() -> Self {
        Self {
            watcher: Mutex::new(None),
            watcher_settings: Mutex::new(None),
            folders: Mutex::new(SelectedFolders::default()),
            source_files: Mutex::new(HashSet::new()),
            pending_corner_drop: Mutex::new(Vec::new()),
            processing: Arc::new(Mutex::new(HashSet::new())),
            quitting: AtomicBool::new(false),
            tray_available: AtomicBool::new(false),
            minimize_to_tray: AtomicBool::new(true),
            clipboard_monitor_enabled: AtomicBool::new(false),
            clipboard_ignore_until_ms: AtomicU64::new(0),
            shortcut_config_lock: Mutex::new(()),
            dropzone_positioned: AtomicBool::new(false),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeDesktopPreferences {
    minimize_to_tray: bool,
    clipboard_watcher_enabled: bool,
}

/// UI preferences live in the native application config directory instead of
/// only in a webview's localStorage. The main window and the floating dock are
/// separate webviews, so this gives both of them one durable source of truth.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeAppProfile {
    settings: serde_json::Value,
    custom_presets: serde_json::Value,
    active_preset_id: String,
    local_fonts: Vec<String>,
    #[serde(default)]
    desktop_preferences: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportedFontPayload {
    family: String,
    data: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredImportedFont {
    family: String,
    file_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedFontData {
    family: String,
    data: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInfo {
    current_version: String,
    latest_version: String,
    available: bool,
    release_url: String,
    published_at: Option<String>,
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    html_url: String,
    published_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuickCompressSettings {
    #[serde(default = "default_manual_mode")]
    mode: String,
    quality: u8,
    scale: f64,
    format: String,
    strip_metadata: bool,
    prevent_larger: bool,
    export_mode: String,
    export_suffix: String,
    #[serde(default)]
    rename_template: String,
    fixed_folder: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShortcutBindings {
    enabled: bool,
    #[serde(default)]
    toggle_dropzone: String,
    #[serde(default)]
    optimise_clipboard: String,
    #[serde(default)]
    show_main: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CleanupRequest {
    folder: String,
    suffix: String,
    older_than_seconds: u64,
}

#[derive(Debug, Serialize)]
struct CleanupResult {
    deleted: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct QuickCompressResult {
    source: String,
    output: Option<String>,
    original_bytes: Option<u64>,
    output_bytes: Option<u64>,
    kept_original: bool,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CompressedAnimationData {
    data: String,
    mime_type: String,
    extension: String,
    width: u32,
    height: u32,
    kept_original: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WatcherSettings {
    input_folder: String,
    #[serde(default)]
    input_folders: Vec<String>,
    output_folder: String,
    #[serde(default)]
    output_suffix: String,
    #[serde(default)]
    rename_template: String,
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

fn default_manual_mode() -> String {
    "manual".to_string()
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

#[derive(Clone, Serialize)]
struct ClipboardImage {
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemFontInfo {
    family: String,
    path: String,
    face_index: u32,
}

#[derive(Serialize)]
struct SystemFontData {
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

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeUploadPayload {
    provider: String,
    endpoint: String,
    bucket: String,
    region: String,
    access_key: String,
    username: String,
    port: u16,
    remote_path: String,
    public_base_url: String,
    key_path: String,
    #[serde(default = "default_true")]
    path_style: bool,
    secret: String,
    file_name: String,
    mime_type: String,
    data: Vec<u8>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeUploadProfile {
    provider: String,
    endpoint: String,
    bucket: String,
    region: String,
    access_key: String,
    username: String,
    port: u16,
    remote_path: String,
    public_base_url: String,
    key_path: String,
    #[serde(default = "default_true")]
    path_style: bool,
    secret: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadResult {
    url: String,
    remote_path: String,
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

/// Builds output names without teaching the native compressor about UI state.
/// Templates intentionally stay small and filesystem-safe:
/// `{name}`, `{suffix}`, `{date}`, `{time}`, `{datetime}`, `{size}`, `{width}`,
/// `{height}` and `{ext}` are available. The extension is always added when a
/// template does not include `{ext}` so users cannot accidentally create a
/// result the OS no longer recognises as an image.
fn render_output_name(
    template: &str,
    base: &str,
    suffix: &str,
    extension: &str,
    bytes: usize,
    width: u32,
    height: u32,
) -> String {
    let now = Local::now();
    let template = if template.trim().is_empty() {
        "{name}{suffix}"
    } else {
        template.trim()
    };
    let mut value = template
        .replace("{name}", base)
        .replace("{suffix}", suffix)
        .replace("{date}", &now.format("%Y-%m-%d").to_string())
        .replace("{time}", &now.format("%H-%M-%S").to_string())
        .replace("{datetime}", &now.format("%Y-%m-%d_%H-%M-%S").to_string())
        .replace("{size}", &bytes.to_string())
        .replace("{width}", &width.to_string())
        .replace("{height}", &height.to_string())
        .replace("{ext}", extension);
    if !template.contains("{ext}") {
        value = format!("{value}.{extension}");
    }
    safe_file_name(&value)
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

fn has_meaningful_savings(original: usize, candidate: usize) -> bool {
    if candidate >= original {
        return false;
    }
    let saved = original - candidate;
    let minimum_bytes = if original < 32 * 1024 { 96 } else { 256 };
    saved >= minimum_bytes && candidate.saturating_mul(100) <= original.saturating_mul(98)
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

fn gif_delay_ms(delay: image::Delay) -> i32 {
    let (numerator, denominator) = delay.numer_denom_ms();
    let denominator = denominator.max(1) as u64;
    let rounded = (numerator as u64 + denominator / 2) / denominator;
    rounded.clamp(10, i32::MAX as u64) as i32
}

fn encode_animated_webp(
    original: &[u8],
    width: u32,
    height: u32,
    quality: u8,
) -> Result<Vec<u8>, String> {
    let decoder = GifDecoder::new(BufReader::new(Cursor::new(original)))
        .map_err(|error| error.to_string())?;
    let frames = decoder
        .into_frames()
        .collect_frames()
        .map_err(|error| error.to_string())?;
    if frames.is_empty() {
        return Err("GIF 不包含可编码的动画帧".to_string());
    }

    let mut timestamp = 0_i32;
    let mut encoded_frames = Vec::with_capacity(frames.len() + 1);
    for frame in frames {
        let delay = gif_delay_ms(frame.delay());
        let mut buffer = frame.into_buffer();
        if buffer.width() != width || buffer.height() != height {
            buffer = image::imageops::resize(&buffer, width, height, FilterType::Lanczos3);
        }
        encoded_frames.push((buffer.into_raw(), timestamp));
        timestamp = timestamp.saturating_add(delay);
    }
    // libwebp derives the final frame duration from the following timestamp.
    // Repeating the last pixels at the animation end preserves the GIF delay
    // without adding a visually distinct frame.
    if let Some((last, _)) = encoded_frames.last() {
        encoded_frames.push((last.clone(), timestamp.max(10)));
    }

    let mut config = WebPConfig::new().map_err(|_| "无法初始化动态 WebP 编码器".to_string())?;
    config.lossless = 0;
    config.quality = quality.clamp(1, 100) as f32;
    config.alpha_quality = quality.clamp(35, 100) as i32;
    config.method = 6;
    config.thread_level = 1;
    let mut encoder = AnimatedWebPEncoder::new(width, height, &config);
    encoder.set_bgcolor([0, 0, 0, 0]);
    encoder.set_loop_count(0);
    for (pixels, frame_timestamp) in &encoded_frames {
        encoder.add_frame(AnimatedWebPFrame::from_rgba(
            pixels,
            width,
            height,
            *frame_timestamp,
        ));
    }
    let encoded = encoder
        .try_encode()
        .map_err(|error| format!("动态 WebP 编码失败：{error:?}"))?;
    Ok(encoded.to_vec())
}

fn optimize_gif_animation(
    original: &[u8],
    settings: &WatcherSettings,
) -> Result<OptimizedImage, String> {
    let decoder = GifDecoder::new(BufReader::new(Cursor::new(original)))
        .map_err(|error| error.to_string())?;
    let (width, height) = decoder.dimensions();
    let (target_width, target_height) = target_dimensions(width, height, settings);

    if settings.format == "image/webp" {
        return Ok(OptimizedImage {
            bytes: encode_animated_webp(original, target_width, target_height, settings.quality)?,
            extension: "webp".to_string(),
        });
    }

    if settings.format == "keep" && matches!(settings.mode.as_str(), "balanced" | "small") {
        let quality = if settings.mode == "balanced" {
            settings.quality.clamp(78, 88)
        } else {
            settings.quality.min(58).max(1)
        };
        let gif = encode_gif(original, target_width, target_height, quality)?;
        let webp = encode_animated_webp(original, target_width, target_height, quality)?;
        let mut best = if webp.len() < gif.len() {
            OptimizedImage {
                bytes: webp,
                extension: "webp".to_string(),
            }
        } else {
            OptimizedImage {
                bytes: gif,
                extension: "gif".to_string(),
            }
        };
        if settings.prevent_larger && !has_meaningful_savings(original.len(), best.bytes.len()) {
            best = OptimizedImage {
                bytes: original.to_vec(),
                extension: "gif".to_string(),
            };
        }
        return Ok(best);
    }

    let candidate = encode_gif(original, target_width, target_height, settings.quality)?;
    let visual_transform = target_width != width || target_height != height;
    if settings.prevent_larger && candidate.len() >= original.len() {
        if visual_transform {
            for quality in guarded_quality_steps(settings.quality) {
                let guarded = encode_gif(original, target_width, target_height, quality)?;
                if guarded.len() < original.len() {
                    return Ok(OptimizedImage {
                        bytes: guarded,
                        extension: "gif".to_string(),
                    });
                }
            }
        }
        return Ok(OptimizedImage {
            bytes: original.to_vec(),
            extension: "gif".to_string(),
        });
    }
    Ok(OptimizedImage {
        bytes: candidate,
        extension: "gif".to_string(),
    })
}

fn encode_static(
    image: DynamicImage,
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
            // PNG conversion is lossless. Do not quantize RGBA based on the
            // generic quality slider: that previously caused WebP -> PNG
            // conversions to lose colour fidelity.
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
            // image-rs exposes a lossless-only WebP encoder. Using libwebp here is
            // deliberate: the WebP quality control must behave like the JPG slider.
            let webp = LossyWebPEncoder::from_rgba(rgba.as_raw(), rgba.width(), rgba.height())
                .encode(quality.clamp(1, 100) as f32);
            encoded.extend_from_slice(webp.as_ref());
        }
        _ => return Err(format!("自动监测暂不支持编码 .{output_extension}")),
    }
    Ok(encoded)
}

struct OptimizedImage {
    bytes: Vec<u8>,
    extension: String,
}

fn optimize_image(path: &Path, settings: &WatcherSettings) -> Result<OptimizedImage, String> {
    let original = fs::read(path).map_err(|error| error.to_string())?;
    let source_extension = extension_for(path, "keep");
    if source_extension == "gif" && matches!(settings.format.as_str(), "keep" | "image/webp") {
        return optimize_gif_animation(&original, settings);
    }

    let decoded = image::load_from_memory(&original).map_err(|error| error.to_string())?;
    let (width, height) = decoded.dimensions();
    if settings.format == "keep" && matches!(settings.mode.as_str(), "balanced" | "small") {
        // The desktop auto modes mirror the workbench: encode a short ladder
        // of format/quality/scale candidates and pick the smallest real file,
        // while retaining PNG/WebP alpha by never forcing JPEG conversion.
        let quality_stops: Vec<u8> = if settings.mode == "balanced" {
            vec![90, settings.quality.clamp(82, 88), 82]
        } else {
            vec![
                settings.quality.min(68),
                settings.quality.min(58),
                settings.quality.min(46),
            ]
        };
        let scale_stops: Vec<f64> = if settings.mode == "balanced" {
            // The first automatic pass must not silently reduce resolution.
            // Downscaling remains an explicit/repeatable action in the result card.
            vec![100.0]
        } else {
            vec![
                settings.scale.min(88.0),
                settings.scale.min(80.0),
                settings.scale.min(72.0),
            ]
        };
        let source_supported = matches!(source_extension.as_str(), "jpg" | "jpeg" | "png" | "webp");
        let mut formats = vec![if source_supported {
            source_extension.clone()
        } else {
            "webp".to_string()
        }];
        if !formats.iter().any(|format| format == "webp") {
            formats.push("webp".to_string());
        }
        let has_alpha = decoded
            .to_rgba8()
            .pixels()
            .any(|pixel| pixel.0[3] != u8::MAX);
        let fallback = if has_alpha { "png" } else { "jpg" };
        if !formats
            .iter()
            .any(|format| format == fallback || (fallback == "jpg" && format == "jpeg"))
        {
            formats.push(fallback.to_string());
        }
        let mut best: Option<OptimizedImage> = None;
        for output_extension in formats {
            for quality in &quality_stops {
                for scale in &scale_stops {
                    let mut candidate_settings = settings.clone();
                    candidate_settings.quality = (*quality).max(1);
                    candidate_settings.scale = scale.clamp(0.1, 100.0);
                    let (candidate_width, candidate_height) =
                        target_dimensions(width, height, &candidate_settings);
                    let resized = if candidate_width != width || candidate_height != height {
                        decoded.resize_exact(
                            candidate_width,
                            candidate_height,
                            FilterType::Lanczos3,
                        )
                    } else {
                        decoded.clone()
                    };
                    let bytes =
                        encode_static(resized, &output_extension, candidate_settings.quality)?;
                    if best
                        .as_ref()
                        .is_none_or(|current| bytes.len() < current.bytes.len())
                    {
                        best = Some(OptimizedImage {
                            bytes,
                            extension: output_extension.clone(),
                        });
                    }
                }
            }
        }
        let best = best.ok_or_else(|| "未生成可用的智能优化结果".to_string())?;
        if settings.prevent_larger && !has_meaningful_savings(original.len(), best.bytes.len()) {
            return Ok(OptimizedImage {
                bytes: original,
                extension: source_extension,
            });
        }
        return Ok(best);
    }

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
                    return Ok(OptimizedImage {
                        bytes: guarded,
                        extension: output_extension,
                    });
                }
            }
        }
        return Ok(OptimizedImage {
            bytes: original,
            extension: source_extension,
        });
    }
    Ok(OptimizedImage {
        bytes: candidate,
        extension: output_extension,
    })
}

#[cfg(test)]
fn optimize_bytes(path: &Path, settings: &WatcherSettings) -> Result<Vec<u8>, String> {
    optimize_image(path, settings).map(|optimized| optimized.bytes)
}

fn native_images_from_paths(
    paths: Vec<String>,
    state: &DesktopState,
) -> Result<Vec<NativeImage>, String> {
    let mut images = Vec::new();
    let mut authorized = state
        .source_files
        .lock()
        .map_err(|_| "文件授权状态不可用".to_string())?;
    for requested in paths {
        let path = PathBuf::from(requested);
        if !is_image(&path) || !path.is_file() {
            continue;
        }
        let canonical = fs::canonicalize(&path).unwrap_or(path);
        let data = fs::read(&canonical).map_err(|error| error.to_string())?;
        authorized.insert(canonical.clone());
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

fn show_window(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn position_dropzone(window: &tauri::WebviewWindow, logical_width: f64, logical_height: f64) {
    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };
    let scale = monitor.scale_factor();
    let margin = (18.0 * scale).round() as i32;
    let width = (logical_width * scale).round() as i32;
    let height = (logical_height * scale).round() as i32;
    let position = monitor.position();
    let size = monitor.size();
    let x = position.x + size.width as i32 - width - margin;
    let y = position.y + size.height as i32 - height - margin;
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

fn resize_and_position_dropzone(app: &AppHandle, width: f64, height: f64) {
    if let Some(window) = app.get_webview_window("dropzone") {
        let width = width.clamp(190.0, 520.0);
        let height = height.clamp(140.0, 420.0);
        let _ = window.set_size(LogicalSize::new(width, height));
        position_dropzone(&window, width, height);
    }
}

fn configure_dropzone_dimensions(app: &AppHandle, state: &DesktopState, width: f64, height: f64) {
    let width = width.clamp(190.0, 520.0);
    let height = height.clamp(140.0, 420.0);
    if !state.dropzone_positioned.swap(true, Ordering::Relaxed) {
        resize_and_position_dropzone(app, width, height);
    } else if let Some(window) = app.get_webview_window("dropzone") {
        // A user-selected position is durable for the current session. Resizing
        // the window must not snap it back to the lower-right corner.
        let _ = window.set_size(LogicalSize::new(width, height));
    }
}

fn ensure_dropzone_positioned(app: &AppHandle, state: &DesktopState) {
    if state.dropzone_positioned.swap(true, Ordering::Relaxed) {
        return;
    }
    if let Some(window) = app.get_webview_window("dropzone") {
        if let (Ok(size), Ok(Some(monitor))) = (window.outer_size(), window.current_monitor()) {
            let logical = size.to_logical::<f64>(monitor.scale_factor());
            position_dropzone(&window, logical.width, logical.height);
        }
    }
}

fn resize_dropzone_around_center(app: &AppHandle, width: f64, height: f64) {
    if let Some(window) = app.get_webview_window("dropzone") {
        let width = width.clamp(190.0, 520.0);
        let height = height.clamp(140.0, 420.0);
        let old_position = window.outer_position().ok();
        let old_size = window.outer_size().ok();
        let scale = window
            .current_monitor()
            .ok()
            .flatten()
            .map(|monitor| monitor.scale_factor())
            .unwrap_or(1.0);
        let _ = window.set_size(LogicalSize::new(width, height));
        if let (Some(position), Some(size)) = (old_position, old_size) {
            let new_width = (width * scale).round() as i32;
            let new_height = (height * scale).round() as i32;
            let x = position.x + (size.width as i32 - new_width) / 2;
            let y = position.y + (size.height as i32 - new_height) / 2;
            let _ = window.set_position(PhysicalPosition::new(x, y));
        }
    }
}

fn quick_settings(value: &QuickCompressSettings) -> WatcherSettings {
    let inferred_mode = if value.quality >= 96 {
        "lossless"
    } else if value.quality >= 65 {
        "balanced"
    } else {
        "small"
    };
    WatcherSettings {
        input_folder: String::new(),
        input_folders: Vec::new(),
        output_folder: String::new(),
        output_suffix: value.export_suffix.clone(),
        rename_template: value.rename_template.clone(),
        mode: match value.mode.as_str() {
            "auto" => "balanced".to_string(),
            "balanced" | "small" | "lossless" => value.mode.clone(),
            _ => inferred_mode.to_string(),
        },
        quality: value.quality.clamp(1, 100),
        scale: value.scale.clamp(0.1, 100.0),
        format: value.format.clone(),
        resize: false,
        max_width: u32::MAX,
        max_height: u32::MAX,
        strip_metadata: value.strip_metadata,
        prevent_larger: value.prevent_larger,
    }
}

#[tauri::command]
async fn read_images_from_paths(
    paths: Vec<String>,
    state: State<'_, DesktopState>,
) -> Result<Vec<NativeImage>, String> {
    native_images_from_paths(paths, &state)
}

#[tauri::command]
async fn quick_compress_paths(
    paths: Vec<String>,
    settings: QuickCompressSettings,
) -> Result<Vec<QuickCompressResult>, String> {
    let compression = quick_settings(&settings);
    let mut results = Vec::new();
    for requested in paths {
        let source = PathBuf::from(&requested);
        let result = (|| -> Result<(PathBuf, u64, u64, bool), String> {
            if !source.is_file() || !is_image(&source) {
                return Err("不是支持的图片文件".to_string());
            }
            let source = fs::canonicalize(&source).unwrap_or(source.clone());
            let original_bytes = fs::metadata(&source)
                .map_err(|error| error.to_string())?
                .len();
            let optimized = optimize_image(&source, &compression)?;
            let output_extension = optimized.extension;
            let base = source
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("image");
            let suffix = if settings.export_suffix.trim().is_empty() {
                "-piclite"
            } else {
                settings.export_suffix.trim()
            };
            let output_directory = if settings.export_mode == "fixed-folder" {
                settings
                    .fixed_folder
                    .as_deref()
                    .filter(|value| !value.is_empty())
                    .map(PathBuf::from)
                    .ok_or_else(|| "固定输出文件夹尚未设置".to_string())?
            } else {
                source
                    .parent()
                    .map(Path::to_path_buf)
                    .ok_or_else(|| "无法定位源文件夹".to_string())?
            };
            // 悬浮压缩坞始终生成新文件，避免一次拖放意外覆盖源图。
            let (width, height) = image::load_from_memory(&optimized.bytes)
                .map(|image| image.dimensions())
                .or_else(|_| image::image_dimensions(&source))
                .unwrap_or((0, 0));
            let output_name = render_output_name(
                &settings.rename_template,
                base,
                suffix,
                &output_extension,
                optimized.bytes.len(),
                width,
                height,
            );
            let output = available_path(&output_directory, &output_name)?;
            fs::write(&output, &optimized.bytes).map_err(|error| error.to_string())?;
            Ok((
                output,
                original_bytes,
                optimized.bytes.len() as u64,
                optimized.bytes.len() as u64 == original_bytes,
            ))
        })();
        match result {
            Ok((output, original_bytes, output_bytes, kept_original)) => {
                results.push(QuickCompressResult {
                    source: requested,
                    output: Some(output.to_string_lossy().to_string()),
                    original_bytes: Some(original_bytes),
                    output_bytes: Some(output_bytes),
                    kept_original,
                    error: None,
                });
            }
            Err(error) => results.push(QuickCompressResult {
                source: requested,
                output: None,
                original_bytes: None,
                output_bytes: None,
                kept_original: false,
                error: Some(error),
            }),
        }
    }
    Ok(results)
}

#[tauri::command]
async fn compress_animation_data(
    data: Vec<u8>,
    file_name: String,
    settings: QuickCompressSettings,
) -> Result<CompressedAnimationData, String> {
    if data.is_empty() || data.len() > 256 * 1024 * 1024 {
        return Err("动画图片为空或超过 256 MB".to_string());
    }
    let extension = Path::new(&file_name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if extension != "gif" {
        return Err("当前原生动画编码仅接受 GIF".to_string());
    }
    let compression = quick_settings(&settings);
    let decoder =
        GifDecoder::new(BufReader::new(Cursor::new(&data))).map_err(|error| error.to_string())?;
    let (source_width, source_height) = decoder.dimensions();
    let (width, height) = target_dimensions(source_width, source_height, &compression);
    let optimized = optimize_gif_animation(&data, &compression)?;
    let mime_type = if optimized.extension == "webp" {
        "image/webp"
    } else {
        "image/gif"
    };
    Ok(CompressedAnimationData {
        kept_original: optimized.extension == "gif" && optimized.bytes == data,
        data: BASE64.encode(optimized.bytes),
        mime_type: mime_type.to_string(),
        extension: optimized.extension,
        width,
        height,
    })
}

#[tauri::command]
async fn update_desktop_preferences(
    preferences: NativeDesktopPreferences,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    state
        .minimize_to_tray
        .store(preferences.minimize_to_tray, Ordering::Relaxed);
    state
        .clipboard_monitor_enabled
        .store(preferences.clipboard_watcher_enabled, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
async fn configure_global_shortcuts(
    app: AppHandle,
    state: State<'_, DesktopState>,
    bindings: ShortcutBindings,
) -> Result<(), String> {
    let _guard = state
        .shortcut_config_lock
        .lock()
        .map_err(|_| "快捷键配置状态不可用".to_string())?;
    let shortcuts = app.global_shortcut();
    shortcuts
        .unregister_all()
        .map_err(|error| error.to_string())?;
    if !bindings.enabled {
        return Ok(());
    }

    let mut configured = HashSet::new();
    let entries = [
        (
            bindings.toggle_dropzone.trim().to_string(),
            "toggle_dropzone",
        ),
        (
            bindings.optimise_clipboard.trim().to_string(),
            "optimise_clipboard",
        ),
        (bindings.show_main.trim().to_string(), "show_main"),
    ];
    for (shortcut, action) in entries {
        if shortcut.is_empty() || !configured.insert(shortcut.clone()) {
            continue;
        }
        shortcuts
            .on_shortcut(shortcut.as_str(), move |app, _, event| {
                if event.state != ShortcutState::Pressed {
                    return;
                }
                match action {
                    "toggle_dropzone" => {
                        if let Some(window) = app.get_webview_window("dropzone") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                let state = app.state::<DesktopState>();
                                ensure_dropzone_positioned(app, &state);
                                show_window(app, "dropzone");
                            }
                        }
                    }
                    "optimise_clipboard" => {
                        let state = app.state::<DesktopState>();
                        ensure_dropzone_positioned(app, &state);
                        show_window(app, "dropzone");
                        let _ = app.emit("tray:action", "optimise_clipboard");
                    }
                    "show_main" => show_window(app, "main"),
                    _ => {}
                }
            })
            .map_err(|error| format!("快捷键 {shortcut} 注册失败：{error}"))?;
    }
    Ok(())
}

fn cleanup_marked_files(
    directory: &Path,
    suffix: &str,
    cutoff: SystemTime,
    deleted: &mut u64,
) -> Result<(), String> {
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            cleanup_marked_files(&path, suffix, cutoff, deleted)?;
            continue;
        }
        let stem = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        if !is_image(&path) || !stem.contains(suffix) {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .unwrap_or(SystemTime::now());
        if modified <= cutoff && fs::remove_file(&path).is_ok() {
            *deleted += 1;
        }
    }
    Ok(())
}

#[tauri::command]
async fn cleanup_optimised_files(request: CleanupRequest) -> Result<CleanupResult, String> {
    let suffix = request.suffix.trim();
    if suffix.len() < 3 {
        return Err("为避免误删，定期清理要求文件名后缀至少包含 3 个字符".to_string());
    }
    let directory = fs::canonicalize(PathBuf::from(request.folder.trim()))
        .map_err(|_| "清理目录不存在或无法访问".to_string())?;
    if !directory.is_dir() {
        return Err("清理目标不是文件夹".to_string());
    }
    let cutoff = SystemTime::now()
        .checked_sub(Duration::from_secs(request.older_than_seconds.max(60)))
        .unwrap_or(UNIX_EPOCH);
    let mut deleted = 0;
    cleanup_marked_files(&directory, suffix, cutoff, &mut deleted)?;
    Ok(CleanupResult { deleted })
}

#[tauri::command]
async fn show_main_window(app: AppHandle) -> Result<(), String> {
    show_window(&app, "main");
    Ok(())
}

#[tauri::command]
async fn show_gallery_window(app: AppHandle) -> Result<(), String> {
    app.emit("tray:action", "gallery")
        .map_err(|error| error.to_string())?;
    show_window(&app, "main");
    Ok(())
}

#[tauri::command]
async fn submit_corner_drop(
    app: AppHandle,
    state: State<'_, DesktopState>,
    paths: Vec<String>,
) -> Result<(), String> {
    let valid = paths
        .into_iter()
        .filter(|path| {
            let path = Path::new(path);
            path.is_file() && is_image(path)
        })
        .collect::<Vec<_>>();
    if valid.is_empty() {
        return Err("拖放内容中没有支持的图片".to_string());
    }
    *state
        .pending_corner_drop
        .lock()
        .map_err(|_| "拖放队列不可用".to_string())? = valid;
    ensure_dropzone_positioned(&app, &state);
    show_window(&app, "dropzone");
    app.emit("corner:drop", ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn take_pending_corner_drop(state: State<'_, DesktopState>) -> Result<Vec<String>, String> {
    let mut pending = state
        .pending_corner_drop
        .lock()
        .map_err(|_| "拖放队列不可用".to_string())?;
    Ok(std::mem::take(&mut *pending))
}

#[tauri::command]
async fn show_preferences_window(app: AppHandle) -> Result<(), String> {
    show_window(&app, "preferences");
    Ok(())
}

#[tauri::command]
async fn show_dropzone_window(
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    ensure_dropzone_positioned(&app, &state);
    show_window(&app, "dropzone");
    Ok(())
}

#[tauri::command]
async fn configure_dropzone_window(
    app: AppHandle,
    state: State<'_, DesktopState>,
    width: f64,
    height: f64,
) -> Result<(), String> {
    configure_dropzone_dimensions(&app, &state, width, height);
    Ok(())
}

#[tauri::command]
async fn resize_dropzone_window(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    resize_dropzone_around_center(&app, width, height);
    Ok(())
}

#[tauri::command]
async fn hide_current_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
async fn quit_application(app: AppHandle, state: State<'_, DesktopState>) -> Result<(), String> {
    state.quitting.store(true, Ordering::Relaxed);
    app.exit(0);
    Ok(())
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
        let output_directory = if settings.output_folder == "@same-folder" {
            canonical
                .parent()
                .map(Path::to_path_buf)
                .ok_or_else(|| "无法定位源文件夹".to_string())?
        } else if settings.output_folder.is_empty() {
            PathBuf::from(&settings.input_folder).join("PicLite")
        } else {
            PathBuf::from(&settings.output_folder)
        };
        let optimized = optimize_image(&canonical, &settings)?;
        let extension = optimized.extension;
        let base = canonical
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("image");
        let suffix = if settings.output_suffix.trim().is_empty() {
            "-piclite"
        } else {
            settings.output_suffix.trim()
        };
        let (width, height) = image::load_from_memory(&optimized.bytes)
            .map(|image| image.dimensions())
            .or_else(|_| image::image_dimensions(&canonical))
            .unwrap_or((0, 0));
        let output_name = render_output_name(
            &settings.rename_template,
            base,
            suffix,
            &extension,
            optimized.bytes.len(),
            width,
            height,
        );
        let output_path = available_path(&output_directory, &output_name)?;
        fs::write(&output_path, &optimized.bytes).map_err(|error| error.to_string())?;
        Ok((output_path, original_bytes, optimized.bytes.len() as u64))
    })();

    match result {
        Ok((output_path, original_bytes, output_bytes)) => {
            let mut event = watcher_event("success", None);
            event.file = Some(canonical.to_string_lossy().to_string());
            event.output = Some(output_path.to_string_lossy().to_string());
            event.original_bytes = Some(original_bytes);
            event.output_bytes = Some(output_bytes);
            emit_event(&app, event);
            let state = app.state::<DesktopState>();
            configure_dropzone_dimensions(&app, &state, 420.0, 320.0);
            if let Some(window) = app.get_webview_window("dropzone") {
                let _ = window.show();
            }
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

/// Returns the OS convention for screenshots when it exists, so the folder
/// watcher can provide the same hands-off screenshot flow as Clop.
#[tauri::command]
fn suggest_screenshot_folder() -> Option<String> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)?;

    #[cfg(target_os = "windows")]
    let candidates = [
        home.join("Pictures").join("Screenshots"),
        home.join("OneDrive").join("Pictures").join("Screenshots"),
    ];
    #[cfg(target_os = "macos")]
    let candidates = [home.join("Desktop"), home.join("Pictures")];
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let candidates = [
        home.join("Pictures").join("Screenshots"),
        home.join("Pictures"),
    ];

    candidates
        .into_iter()
        .find(|path| path.is_dir())
        .map(|path| path.to_string_lossy().into_owned())
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

fn clipboard_image() -> Result<Option<ClipboardImage>, String> {
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

fn clipboard_image_paths() -> Result<Vec<String>, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|error| error.to_string())?;
    match clipboard.get().file_list() {
        Ok(paths) => Ok(paths
            .into_iter()
            .filter(|path| is_image(path))
            .map(|path| fs::canonicalize(&path).unwrap_or(path))
            .map(|path| path.to_string_lossy().into_owned())
            .collect()),
        Err(arboard::Error::ContentNotAvailable) => Ok(Vec::new()),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
async fn read_clipboard_image() -> Result<Option<ClipboardImage>, String> {
    tauri::async_runtime::spawn_blocking(clipboard_image)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn read_clipboard_paths() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(clipboard_image_paths)
        .await
        .map_err(|error| error.to_string())?
}

fn write_clipboard_image(data: &[u8]) -> Result<(), String> {
    let decoded =
        image::load_from_memory(data).map_err(|error| format!("无法读取结果图：{error}"))?;
    let rgba = decoded.to_rgba8();
    let (width, height) = rgba.dimensions();
    let mut clipboard = arboard::Clipboard::new().map_err(|error| error.to_string())?;
    clipboard
        .set_image(arboard::ImageData {
            width: width as usize,
            height: height as usize,
            bytes: Cow::Owned(rgba.into_raw()),
        })
        .map_err(|error| format!("无法写入系统剪贴板：{error}"))
}

#[cfg(target_os = "macos")]
fn copy_file_to_clipboard(path: &Path) -> Result<(), String> {
    let status = Command::new("osascript")
        .args([
            "-e",
            "on run argv",
            "-e",
            "set the clipboard to (POSIX file (item 1 of argv))",
            "-e",
            "end run",
        ])
        .arg(path)
        .status()
        .map_err(|error| format!("无法调用系统剪贴板：{error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("系统未能复制压缩文件".to_string())
    }
}

#[cfg(target_os = "windows")]
fn copy_file_to_clipboard(path: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut command = Command::new("powershell.exe");
    command
        .creation_flags(CREATE_NO_WINDOW)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-STA",
            "-Command",
            "Add-Type -AssemblyName System.Windows.Forms; $files = New-Object System.Collections.Specialized.StringCollection; [void]$files.Add($args[0]); [System.Windows.Forms.Clipboard]::SetFileDropList($files)",
        ])
        .arg(path);
    let status = command
        .status()
        .map_err(|error| format!("无法调用系统剪贴板：{error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("系统未能复制压缩文件".to_string())
    }
}

fn suppress_next_clipboard_observation(state: &DesktopState) {
    let until = now_ms().saturating_add(3_000).min(u64::MAX as u128) as u64;
    state
        .clipboard_ignore_until_ms
        .store(until, Ordering::Relaxed);
}

#[cfg(target_os = "linux")]
fn copy_file_to_clipboard(path: &Path) -> Result<(), String> {
    let uri = Url::from_file_path(path)
        .map_err(|_| "无法生成结果文件地址".to_string())?
        .to_string();
    for (program, arguments) in [
        ("wl-copy", vec!["--type", "text/uri-list"]),
        (
            "xclip",
            vec!["-selection", "clipboard", "-t", "text/uri-list", "-i"],
        ),
    ] {
        let Ok(mut child) = Command::new(program)
            .args(arguments)
            .stdin(std::process::Stdio::piped())
            .spawn()
        else {
            continue;
        };
        if let Some(stdin) = child.stdin.as_mut() {
            let _ = stdin.write_all(uri.as_bytes());
        }
        if child.wait().map(|status| status.success()).unwrap_or(false) {
            return Ok(());
        }
    }
    let data = fs::read(path).map_err(|error| error.to_string())?;
    write_clipboard_image(&data)
}

fn clipboard_cache_path(app: &AppHandle, file_name: &str) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("clipboard");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let safe = safe_file_name(file_name);
    let safe = if safe.trim().is_empty() {
        "piclite-result.png".to_string()
    } else {
        safe
    };
    Ok(directory.join(format!("{}-{safe}", now_ms())))
}

#[tauri::command]
async fn copy_image_data(data: Vec<u8>, state: State<'_, DesktopState>) -> Result<(), String> {
    let result = tauri::async_runtime::spawn_blocking(move || write_clipboard_image(&data))
        .await
        .map_err(|error| error.to_string())?;
    if result.is_ok() {
        suppress_next_clipboard_observation(&state);
    }
    result
}

#[tauri::command]
async fn copy_compressed_data(
    app: AppHandle,
    data: Vec<u8>,
    file_name: String,
    state: State<'_, DesktopState>,
) -> Result<String, String> {
    let result = tauri::async_runtime::spawn_blocking(move || {
        let path = clipboard_cache_path(&app, &file_name)?;
        fs::write(&path, &data).map_err(|error| format!("无法缓存压缩文件：{error}"))?;
        // A real file drop is ideal for clients that accept attachments. Some
        // Windows clipboard hosts reject CF_HDROP, so always fall back to an
        // actual bitmap instead of reporting a false copy failure.
        if copy_file_to_clipboard(&path).is_err() {
            write_clipboard_image(&data)?;
        }
        Ok(path.to_string_lossy().to_string())
    })
    .await
    .map_err(|error| error.to_string())?;
    if result.is_ok() {
        suppress_next_clipboard_observation(&state);
    }
    result
}

#[tauri::command]
async fn cache_image_data(
    app: AppHandle,
    data: Vec<u8>,
    file_name: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if data.is_empty() || data.len() > 128 * 1024 * 1024 {
            return Err("剪贴板图片无效或超过 128 MB".to_string());
        }
        image::load_from_memory(&data).map_err(|error| format!("无法读取剪贴板图片：{error}"))?;
        let path = clipboard_cache_path(&app, &file_name)?;
        fs::write(&path, &data).map_err(|error| format!("无法缓存剪贴板图片：{error}"))?;
        Ok(path.to_string_lossy().to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn copy_image_path(path: String, state: State<'_, DesktopState>) -> Result<(), String> {
    let result = tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(path);
        if !path.is_file() {
            return Err("结果文件已经不存在".to_string());
        }
        copy_file_to_clipboard(&path).or_else(|_| {
            let data = fs::read(&path).map_err(|error| error.to_string())?;
            write_clipboard_image(&data)
        })
    })
    .await
    .map_err(|error| error.to_string())?;
    if result.is_ok() {
        suppress_next_clipboard_observation(&state);
    }
    result
}

fn collect_font_files(directory: &Path, depth: usize, files: &mut Vec<PathBuf>) {
    if depth > 8 || files.len() >= 4_000 {
        return;
    }
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_font_files(&path, depth + 1, files);
            continue;
        }
        let supported = path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| {
                matches!(
                    value.to_ascii_lowercase().as_str(),
                    "ttf" | "otf" | "ttc" | "otc"
                )
            })
            .unwrap_or(false);
        if supported {
            files.push(path);
        }
    }
}

fn system_font_directories() -> Vec<PathBuf> {
    let mut directories = Vec::new();
    #[cfg(target_os = "macos")]
    {
        directories.extend([
            PathBuf::from("/System/Library/Fonts"),
            PathBuf::from("/Library/Fonts"),
        ]);
        if let Some(home) = std::env::var_os("HOME") {
            directories.push(PathBuf::from(home).join("Library/Fonts"));
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(windows) = std::env::var_os("WINDIR") {
            directories.push(PathBuf::from(windows).join("Fonts"));
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            directories.push(PathBuf::from(local).join("Microsoft/Windows/Fonts"));
        }
    }
    #[cfg(target_os = "linux")]
    {
        directories.extend([
            PathBuf::from("/usr/share/fonts"),
            PathBuf::from("/usr/local/share/fonts"),
        ]);
        if let Some(home) = std::env::var_os("HOME") {
            let home = PathBuf::from(home);
            directories.push(home.join(".fonts"));
            directories.push(home.join(".local/share/fonts"));
        }
    }
    directories
}

fn read_system_fonts() -> Vec<SystemFontInfo> {
    let mut files = Vec::new();
    for directory in system_font_directories() {
        collect_font_files(&directory, 0, &mut files);
    }
    files.sort();
    let mut families = BTreeMap::new();
    for path in files {
        let Ok(data) = fs::read(&path) else {
            continue;
        };
        let face_count = ttf_parser::fonts_in_collection(&data).unwrap_or(1);
        for index in 0..face_count {
            let Ok(face) = ttf_parser::Face::parse(&data, index) else {
                continue;
            };
            let family = face
                .names()
                .into_iter()
                .filter(|name| name.name_id == 16)
                .find_map(|name| name.to_string().filter(|value| !value.trim().is_empty()))
                .or_else(|| {
                    face.names()
                        .into_iter()
                        .filter(|name| name.name_id == 1)
                        .find_map(|name| name.to_string().filter(|value| !value.trim().is_empty()))
                });
            let Some(family) = family else { continue };
            families
                .entry(family.clone())
                .or_insert_with(|| SystemFontInfo {
                    family,
                    path: path.to_string_lossy().to_string(),
                    face_index: index,
                });
        }
    }
    families.into_values().take(2_000).collect()
}

#[tauri::command]
async fn list_system_fonts() -> Result<Vec<SystemFontInfo>, String> {
    tauri::async_runtime::spawn_blocking(read_system_fonts)
        .await
        .map_err(|error| error.to_string())
}

fn read_be_u16(data: &[u8], offset: usize) -> Result<u16, String> {
    let bytes = data
        .get(offset..offset + 2)
        .ok_or_else(|| "字体文件结构不完整".to_string())?;
    Ok(u16::from_be_bytes([bytes[0], bytes[1]]))
}

fn read_be_u32(data: &[u8], offset: usize) -> Result<u32, String> {
    let bytes = data
        .get(offset..offset + 4)
        .ok_or_else(|| "字体文件结构不完整".to_string())?;
    Ok(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

fn extract_font_face(data: &[u8], face_index: u32) -> Result<Vec<u8>, String> {
    if data.get(0..4) != Some(b"ttcf") {
        if face_index != 0 {
            return Err("字体字面索引无效".to_string());
        }
        return Ok(data.to_vec());
    }

    let face_count = read_be_u32(data, 8)?;
    if face_index >= face_count {
        return Err("字体字面索引无效".to_string());
    }
    let face_offset = read_be_u32(data, 12 + face_index as usize * 4)? as usize;
    let table_count = read_be_u16(data, face_offset + 4)? as usize;
    let directory_length = 12usize
        .checked_add(
            table_count
                .checked_mul(16)
                .ok_or_else(|| "字体表数量异常".to_string())?,
        )
        .ok_or_else(|| "字体目录过大".to_string())?;
    let directory_end = face_offset
        .checked_add(directory_length)
        .ok_or_else(|| "字体目录过大".to_string())?;
    let directory = data
        .get(face_offset..directory_end)
        .ok_or_else(|| "字体目录不完整".to_string())?;
    let mut output = directory.to_vec();
    let mut head_offset = None;

    for table_index in 0..table_count {
        let record = face_offset + 12 + table_index * 16;
        let tag = data
            .get(record..record + 4)
            .ok_or_else(|| "字体表记录不完整".to_string())?;
        let source_offset = read_be_u32(data, record + 8)? as usize;
        let length = read_be_u32(data, record + 12)? as usize;
        let source_end = source_offset
            .checked_add(length)
            .ok_or_else(|| "字体表过大".to_string())?;
        let table = data
            .get(source_offset..source_end)
            .ok_or_else(|| "字体表数据不完整".to_string())?;
        while output.len() % 4 != 0 {
            output.push(0);
        }
        let target_offset = output.len();
        let target_offset_u32 =
            u32::try_from(target_offset).map_err(|_| "字体文件过大".to_string())?;
        output[12 + table_index * 16 + 8..12 + table_index * 16 + 12]
            .copy_from_slice(&target_offset_u32.to_be_bytes());
        output.extend_from_slice(table);
        if tag == b"head" {
            head_offset = Some(target_offset);
        }
    }

    while output.len() % 4 != 0 {
        output.push(0);
    }
    if let Some(head) = head_offset.filter(|offset| offset + 12 <= output.len()) {
        output[head + 8..head + 12].fill(0);
        let checksum = output.chunks_exact(4).fold(0u32, |sum, chunk| {
            sum.wrapping_add(u32::from_be_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        });
        output[head + 8..head + 12]
            .copy_from_slice(&0xB1B0_AFBAu32.wrapping_sub(checksum).to_be_bytes());
    }
    Ok(output)
}

fn validated_system_font_path(value: &str) -> Result<PathBuf, String> {
    let path = fs::canonicalize(value).map_err(|error| format!("无法读取字体文件：{error}"))?;
    let allowed = system_font_directories()
        .into_iter()
        .filter_map(|directory| fs::canonicalize(directory).ok())
        .any(|directory| path.starts_with(directory));
    if !allowed || !path.is_file() {
        return Err("只能读取系统字体目录中的字体文件".to_string());
    }
    let supported = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "ttf" | "otf" | "ttc" | "otc"
            )
        })
        .unwrap_or(false);
    if !supported {
        return Err("不支持该字体文件格式".to_string());
    }
    Ok(path)
}

#[tauri::command]
async fn read_system_font(path: String, face_index: u32) -> Result<SystemFontData, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = validated_system_font_path(&path)?;
        let metadata = fs::metadata(&path).map_err(|error| format!("无法读取字体信息：{error}"))?;
        if metadata.len() > 64 * 1024 * 1024 {
            return Err("字体文件超过 64 MB，无法载入".to_string());
        }
        let data = fs::read(path).map_err(|error| format!("无法读取字体文件：{error}"))?;
        let face = extract_font_face(&data, face_index)?;
        Ok(SystemFontData {
            data: BASE64.encode(face),
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

fn upload_profile_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("upload-profile.json"))
}

fn app_profile_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("app-profile.json"))
}

#[tauri::command]
async fn load_app_profile(app: AppHandle) -> Result<Option<NativeAppProfile>, String> {
    let path = app_profile_path(&app)?;
    if !path.is_file() {
        return Ok(None);
    }
    let data = fs::read(&path).map_err(|error| format!("无法读取应用配置：{error}"))?;
    serde_json::from_slice(&data)
        .map(Some)
        .map_err(|error| format!("应用配置已损坏：{error}"))
}

#[tauri::command]
async fn save_app_profile(app: AppHandle, profile: NativeAppProfile) -> Result<(), String> {
    let path = app_profile_path(&app)?;
    let data = serde_json::to_vec_pretty(&profile).map_err(|error| error.to_string())?;
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|error| format!("无法保存应用配置：{error}"))?;
    file.write_all(&data)
        .map_err(|error| format!("无法保存应用配置：{error}"))?;
    file.flush().map_err(|error| error.to_string())
}

fn imported_fonts_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?
        .join("watermark-fonts");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory)
}

fn imported_fonts_manifest_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("watermark-fonts.json"))
}

fn read_imported_font_manifest(app: &AppHandle) -> Result<Vec<StoredImportedFont>, String> {
    let path = imported_fonts_manifest_path(app)?;
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let data = fs::read(path).map_err(|error| format!("无法读取已导入字体：{error}"))?;
    serde_json::from_slice(&data).map_err(|error| format!("已导入字体记录已损坏：{error}"))
}

#[tauri::command]
async fn load_imported_fonts(app: AppHandle) -> Result<Vec<ImportedFontData>, String> {
    let manifest = read_imported_font_manifest(&app)?;
    let directory = imported_fonts_directory(&app)?;
    let mut fonts = Vec::new();
    for font in manifest {
        let path = directory.join(&font.file_name);
        let Ok(data) = fs::read(path) else { continue };
        if data.len() <= 64 * 1024 * 1024 {
            fonts.push(ImportedFontData {
                family: font.family,
                data: BASE64.encode(data),
            });
        }
    }
    Ok(fonts)
}

#[tauri::command]
async fn save_imported_font(app: AppHandle, payload: ImportedFontPayload) -> Result<(), String> {
    if payload.family.trim().is_empty()
        || payload.data.is_empty()
        || payload.data.len() > 64 * 1024 * 1024
    {
        return Err("字体文件无效或超过 64 MB".to_string());
    }
    let file_name = format!("{:x}.font", Sha256::digest(&payload.data));
    let directory = imported_fonts_directory(&app)?;
    let path = directory.join(&file_name);
    if !path.exists() {
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(path)
            .map_err(|error| format!("无法缓存字体文件：{error}"))?;
        file.write_all(&payload.data)
            .map_err(|error| format!("无法保存字体文件：{error}"))?;
        file.flush().map_err(|error| error.to_string())?;
    }
    let mut manifest = read_imported_font_manifest(&app)?;
    manifest.retain(|font| font.family != payload.family);
    manifest.push(StoredImportedFont {
        family: payload.family,
        file_name,
    });
    let data = serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?;
    fs::write(imported_fonts_manifest_path(&app)?, data)
        .map_err(|error| format!("无法保存字体记录：{error}"))
}

#[tauri::command]
async fn load_upload_profile(app: AppHandle) -> Result<Option<NativeUploadProfile>, String> {
    let path = upload_profile_path(&app)?;
    if !path.is_file() {
        return Ok(None);
    }
    let data = fs::read(&path).map_err(|error| format!("无法读取上传配置：{error}"))?;
    serde_json::from_slice(&data)
        .map(Some)
        .map_err(|error| format!("上传配置已损坏：{error}"))
}

#[tauri::command]
async fn save_upload_profile(app: AppHandle, profile: NativeUploadProfile) -> Result<(), String> {
    let path = upload_profile_path(&app)?;
    let data = serde_json::to_vec_pretty(&profile).map_err(|error| error.to_string())?;
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|error| format!("无法保存上传配置：{error}"))?;
    file.write_all(&data)
        .map_err(|error| format!("无法保存上传配置：{error}"))?;
    file.flush().map_err(|error| error.to_string())
}

#[tauri::command]
async fn reveal_path(path: String) -> Result<(), String> {
    let target = PathBuf::from(path);
    if !target.exists() {
        return Err("文件已经不存在".to_string());
    }
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg("-R").arg(&target);
        command
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("explorer.exe");
        command.arg(format!("/select,{}", target.to_string_lossy()));
        command
    };
    #[cfg(target_os = "linux")]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(if target.is_dir() {
            target.as_path()
        } else {
            target.parent().unwrap_or_else(|| Path::new("."))
        });
        command
    };
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法打开文件位置：{error}"))
}

const URL_PATH_ENCODE_SET: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

fn encoded_object_key(value: &str) -> String {
    value
        .split('/')
        .filter(|part| !part.is_empty())
        .map(|part| utf8_percent_encode(part, URL_PATH_ENCODE_SET).to_string())
        .collect::<Vec<_>>()
        .join("/")
}

fn remote_object_key(payload: &NativeUploadPayload) -> Result<String, String> {
    let file_name = safe_file_name(&payload.file_name);
    if file_name.trim().is_empty() {
        return Err("图片文件名为空".to_string());
    }
    let directory = payload
        .remote_path
        .split('/')
        .map(str::trim)
        .filter(|part| !part.is_empty() && *part != "." && *part != "..")
        .map(safe_file_name)
        .collect::<Vec<_>>()
        .join("/");
    Ok(if directory.is_empty() {
        file_name
    } else {
        format!("{directory}/{file_name}")
    })
}

fn endpoint_url(value: &str, scheme: &str) -> Result<Url, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("请填写服务地址".to_string());
    }
    let normalized = if value.contains("://") {
        value.to_string()
    } else {
        format!("{scheme}://{value}")
    };
    Url::parse(&normalized).map_err(|error| format!("服务地址无效：{error}"))
}

fn joined_public_url(base: &str, key: &str, fallback: &str) -> String {
    if base.trim().is_empty() {
        fallback.to_string()
    } else {
        format!(
            "{}/{}",
            base.trim().trim_end_matches('/'),
            encoded_object_key(key)
        )
    }
}

fn sha256_hex(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Result<Vec<u8>, String> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).map_err(|error| error.to_string())?;
    mac.update(data);
    Ok(mac.finalize().into_bytes().to_vec())
}

fn upload_webdav(payload: &NativeUploadPayload, key: &str) -> Result<String, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|error| error.to_string())?;
    let endpoint = payload.endpoint.trim().trim_end_matches('/');
    let directories = key.split('/').collect::<Vec<_>>();
    let mut current = endpoint.to_string();
    for directory in directories.iter().take(directories.len().saturating_sub(1)) {
        current.push('/');
        current.push_str(&utf8_percent_encode(directory, URL_PATH_ENCODE_SET).to_string());
        let mut request = client.request(
            Method::from_bytes(b"MKCOL").map_err(|error| error.to_string())?,
            &current,
        );
        if !payload.username.is_empty() {
            request = request.basic_auth(&payload.username, Some(&payload.secret));
        }
        let response = request
            .send()
            .map_err(|error| format!("WebDAV 建目录失败：{error}"))?;
        if !(response.status().is_success()
            || response.status() == StatusCode::METHOD_NOT_ALLOWED
            || response.status() == StatusCode::CONFLICT)
        {
            return Err(format!("WebDAV 建目录失败：HTTP {}", response.status()));
        }
    }
    let upload_url = format!("{endpoint}/{}", encoded_object_key(key));
    let mut request = client
        .put(&upload_url)
        .header("Content-Type", &payload.mime_type)
        .body(payload.data.clone());
    if !payload.username.is_empty() {
        request = request.basic_auth(&payload.username, Some(&payload.secret));
    }
    let response = request
        .send()
        .map_err(|error| format!("WebDAV 上传失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("WebDAV 上传失败：HTTP {}", response.status()));
    }
    Ok(joined_public_url(
        &payload.public_base_url,
        key,
        &upload_url,
    ))
}

fn upload_s3_compatible(
    payload: &NativeUploadPayload,
    key: &str,
    service_name: &str,
    force_path_style: bool,
) -> Result<String, String> {
    if payload.bucket.trim().is_empty()
        || payload.access_key.trim().is_empty()
        || payload.secret.is_empty()
    {
        return Err(format!(
            "{service_name} 需要 Bucket、Access Key ID 和 Secret Access Key"
        ));
    }
    let endpoint = endpoint_url(&payload.endpoint, "https")?;
    let scheme = endpoint.scheme();
    let host = endpoint
        .host_str()
        .ok_or_else(|| format!("{service_name} 服务地址缺少主机名"))?;
    let path_style = force_path_style || payload.path_style;
    let request_host = if path_style {
        host.to_string()
    } else {
        format!("{}.{}", payload.bucket.trim_matches('/'), host)
    };
    let host_header = match endpoint.port() {
        Some(port) => format!("{request_host}:{port}"),
        None => request_host.clone(),
    };
    let base_path = endpoint.path().trim_matches('/');
    let object_path = if path_style && base_path.is_empty() {
        format!(
            "{}/{}",
            payload.bucket.trim_matches('/'),
            encoded_object_key(key)
        )
    } else if path_style {
        format!(
            "{base_path}/{}/{}",
            payload.bucket.trim_matches('/'),
            encoded_object_key(key)
        )
    } else if base_path.is_empty() {
        encoded_object_key(key)
    } else {
        format!("{base_path}/{}", encoded_object_key(key))
    };
    let canonical_uri = format!("/{object_path}");
    let upload_url = match endpoint.port() {
        Some(port) => format!("{scheme}://{request_host}:{port}{canonical_uri}"),
        None => format!("{scheme}://{request_host}{canonical_uri}"),
    };
    let region = if payload.region.trim().is_empty() {
        if service_name == "R2" {
            "auto"
        } else {
            "us-east-1"
        }
    } else {
        payload.region.trim()
    };
    let now = Utc::now();
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let date = now.format("%Y%m%d").to_string();
    let payload_hash = sha256_hex(&payload.data);
    let signed_headers = "content-type;host;x-amz-content-sha256;x-amz-date";
    let canonical_headers = format!(
        "content-type:{}\nhost:{}\nx-amz-content-sha256:{}\nx-amz-date:{}\n",
        payload.mime_type, host_header, payload_hash, amz_date
    );
    let canonical_request =
        format!("PUT\n{canonical_uri}\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}");
    let scope = format!("{date}/{region}/s3/aws4_request");
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    );
    let date_key = hmac_sha256(
        format!("AWS4{}", payload.secret).as_bytes(),
        date.as_bytes(),
    )?;
    let region_key = hmac_sha256(&date_key, region.as_bytes())?;
    let service_key = hmac_sha256(&region_key, b"s3")?;
    let signing_key = hmac_sha256(&service_key, b"aws4_request")?;
    let signature = hmac_sha256(&signing_key, string_to_sign.as_bytes())?
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
        payload.access_key, scope, signed_headers, signature
    );
    let response = Client::builder()
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|error| error.to_string())?
        .put(&upload_url)
        .header("Content-Type", &payload.mime_type)
        .header("Host", host_header)
        .header("x-amz-content-sha256", payload_hash)
        .header("x-amz-date", amz_date)
        .header("Authorization", authorization)
        .body(payload.data.clone())
        .send()
        .map_err(|error| format!("{service_name} 上传失败：{error}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().unwrap_or_default();
        return Err(format!(
            "{service_name} 上传失败：HTTP {status} {}",
            detail.chars().take(180).collect::<String>()
        ));
    }
    Ok(joined_public_url(
        &payload.public_base_url,
        key,
        &upload_url,
    ))
}

fn upload_oss(payload: &NativeUploadPayload, key: &str) -> Result<String, String> {
    if payload.bucket.trim().is_empty()
        || payload.access_key.trim().is_empty()
        || payload.secret.is_empty()
    {
        return Err("OSS 需要 Bucket、Access Key ID 和 Access Key Secret".to_string());
    }
    let endpoint = endpoint_url(&payload.endpoint, "https")?;
    let host = endpoint
        .host_str()
        .ok_or_else(|| "OSS 服务地址缺少主机名".to_string())?;
    let bucket = payload.bucket.trim();
    let upload_host = if host.starts_with(&format!("{bucket}.")) {
        host.to_string()
    } else {
        format!("{bucket}.{host}")
    };
    let port = endpoint
        .port()
        .map(|value| format!(":{value}"))
        .unwrap_or_default();
    let object_path = encoded_object_key(key);
    let upload_url = format!(
        "{}://{}{}/{}",
        endpoint.scheme(),
        upload_host,
        port,
        object_path
    );
    let date = Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string();
    let canonical_resource = format!("/{bucket}/{key}");
    let string_to_sign = format!(
        "PUT\n\n{}\n{}\n{}",
        payload.mime_type, date, canonical_resource
    );
    let mut mac = Hmac::<Sha1>::new_from_slice(payload.secret.as_bytes())
        .map_err(|error| error.to_string())?;
    mac.update(string_to_sign.as_bytes());
    let signature = BASE64.encode(mac.finalize().into_bytes());
    let response = Client::builder()
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|error| error.to_string())?
        .put(&upload_url)
        .header("Content-Type", &payload.mime_type)
        .header("Date", date)
        .header(
            "Authorization",
            format!("OSS {}:{signature}", payload.access_key),
        )
        .body(payload.data.clone())
        .send()
        .map_err(|error| format!("OSS 上传失败：{error}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().unwrap_or_default();
        return Err(format!(
            "OSS 上传失败：HTTP {status} {}",
            detail.chars().take(180).collect::<String>()
        ));
    }
    Ok(joined_public_url(
        &payload.public_base_url,
        key,
        &upload_url,
    ))
}

fn ftp_read_response(reader: &mut BufReader<TcpStream>) -> Result<(u16, String), String> {
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .map_err(|error| error.to_string())?;
    if line.len() < 3 {
        return Err("FTP 返回了无效响应".to_string());
    }
    let code = line[..3]
        .parse::<u16>()
        .map_err(|_| format!("FTP 响应无效：{line}"))?;
    let multiline = line.as_bytes().get(3) == Some(&b'-');
    let mut response = line;
    if multiline {
        loop {
            let mut next = String::new();
            reader
                .read_line(&mut next)
                .map_err(|error| error.to_string())?;
            let finished = next.starts_with(&format!("{code} "));
            response.push_str(&next);
            if finished {
                break;
            }
        }
    }
    Ok((code, response.trim().to_string()))
}

fn ftp_command(
    reader: &mut BufReader<TcpStream>,
    writer: &mut TcpStream,
    command: &str,
) -> Result<(u16, String), String> {
    writer
        .write_all(command.as_bytes())
        .map_err(|error| error.to_string())?;
    writer
        .write_all(b"\r\n")
        .map_err(|error| error.to_string())?;
    writer.flush().map_err(|error| error.to_string())?;
    ftp_read_response(reader)
}

fn upload_ftp(payload: &NativeUploadPayload, key: &str) -> Result<String, String> {
    let endpoint = endpoint_url(&payload.endpoint, "ftp")?;
    let host = endpoint
        .host_str()
        .ok_or_else(|| "FTP 地址缺少主机名".to_string())?;
    let port = if payload.port == 0 {
        endpoint.port().unwrap_or(21)
    } else {
        payload.port
    };
    let control =
        TcpStream::connect((host, port)).map_err(|error| format!("FTP 连接失败：{error}"))?;
    control
        .set_read_timeout(Some(Duration::from_secs(45)))
        .map_err(|error| error.to_string())?;
    control
        .set_write_timeout(Some(Duration::from_secs(45)))
        .map_err(|error| error.to_string())?;
    let peer_ip = control.peer_addr().map_err(|error| error.to_string())?.ip();
    let mut writer = control.try_clone().map_err(|error| error.to_string())?;
    let mut reader = BufReader::new(control);
    let (code, message) = ftp_read_response(&mut reader)?;
    if code != 220 {
        return Err(format!("FTP 拒绝连接：{message}"));
    }
    let username = if payload.username.is_empty() {
        "anonymous"
    } else {
        &payload.username
    };
    let (code, message) = ftp_command(&mut reader, &mut writer, &format!("USER {username}"))?;
    if code == 331 {
        let (code, message) = ftp_command(
            &mut reader,
            &mut writer,
            &format!("PASS {}", payload.secret),
        )?;
        if code != 230 {
            return Err(format!("FTP 登录失败：{message}"));
        }
    } else if code != 230 {
        return Err(format!("FTP 登录失败：{message}"));
    }
    let (code, message) = ftp_command(&mut reader, &mut writer, "TYPE I")?;
    if code != 200 {
        return Err(format!("FTP 无法切换二进制模式：{message}"));
    }
    let mut components = endpoint
        .path()
        .split('/')
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    components.extend(
        key.split('/')
            .filter(|part| !part.is_empty())
            .map(str::to_string),
    );
    let file_name = components
        .pop()
        .ok_or_else(|| "FTP 远端文件名为空".to_string())?;
    for directory in &components {
        let (code, _) = ftp_command(&mut reader, &mut writer, &format!("CWD {directory}"))?;
        if code != 250 {
            let (code, message) =
                ftp_command(&mut reader, &mut writer, &format!("MKD {directory}"))?;
            if code != 257 {
                return Err(format!("FTP 建目录失败：{message}"));
            }
            let (code, message) =
                ftp_command(&mut reader, &mut writer, &format!("CWD {directory}"))?;
            if code != 250 {
                return Err(format!("FTP 进入目录失败：{message}"));
            }
        }
    }
    let (code, message) = ftp_command(&mut reader, &mut writer, "PASV")?;
    if code != 227 {
        return Err(format!("FTP 无法进入被动模式：{message}"));
    }
    let numbers = message
        .split(['(', ')'])
        .nth(1)
        .ok_or_else(|| format!("FTP 被动模式响应无效：{message}"))?
        .split(',')
        .filter_map(|value| value.trim().parse::<u16>().ok())
        .collect::<Vec<_>>();
    if numbers.len() != 6 {
        return Err(format!("FTP 被动模式响应无效：{message}"));
    }
    let data_port = numbers[4] * 256 + numbers[5];
    let mut data_stream = TcpStream::connect((peer_ip, data_port))
        .map_err(|error| format!("FTP 数据连接失败：{error}"))?;
    let (code, message) = ftp_command(&mut reader, &mut writer, &format!("STOR {file_name}"))?;
    if code != 125 && code != 150 {
        return Err(format!("FTP 无法写入文件：{message}"));
    }
    data_stream
        .write_all(&payload.data)
        .map_err(|error| format!("FTP 上传中断：{error}"))?;
    let _ = data_stream.shutdown(Shutdown::Write);
    drop(data_stream);
    let (code, message) = ftp_read_response(&mut reader)?;
    if code != 226 && code != 250 {
        return Err(format!("FTP 上传未完成：{message}"));
    }
    let _ = ftp_command(&mut reader, &mut writer, "QUIT");
    let remote_path = format!("/{}/{}", components.join("/"), file_name).replace("//", "/");
    let fallback = format!("ftp://{host}:{port}/{}", encoded_object_key(&remote_path));
    Ok(joined_public_url(&payload.public_base_url, key, &fallback))
}

fn upload_sftp(payload: &NativeUploadPayload, key: &str) -> Result<String, String> {
    let endpoint = endpoint_url(&payload.endpoint, "sftp")?;
    let host = endpoint
        .host_str()
        .ok_or_else(|| "SFTP 地址缺少主机名".to_string())?;
    let port = if payload.port == 0 {
        endpoint.port().unwrap_or(22)
    } else {
        payload.port
    };
    let tcp =
        TcpStream::connect((host, port)).map_err(|error| format!("SFTP 连接失败：{error}"))?;
    tcp.set_read_timeout(Some(Duration::from_secs(60)))
        .map_err(|error| error.to_string())?;
    tcp.set_write_timeout(Some(Duration::from_secs(60)))
        .map_err(|error| error.to_string())?;
    let mut session = Session::new().map_err(|error| error.to_string())?;
    session.set_tcp_stream(tcp);
    session
        .handshake()
        .map_err(|error| format!("SSH 握手失败：{error}"))?;

    let (host_key, _) = session
        .host_key()
        .ok_or_else(|| "服务器没有提供 SSH Host Key".to_string())?;
    let known_hosts_path = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .map(|path| path.join(".ssh").join("known_hosts"))
        .ok_or_else(|| "无法定位 SSH known_hosts；请先用 ssh 命令连接一次服务器".to_string())?;
    if !known_hosts_path.exists() {
        return Err("未找到 SSH known_hosts；请先用 ssh 命令连接一次服务器并确认指纹".to_string());
    }
    let mut known_hosts = session.known_hosts().map_err(|error| error.to_string())?;
    known_hosts
        .read_file(&known_hosts_path, KnownHostFileKind::OpenSSH)
        .map_err(|error| format!("无法读取 known_hosts：{error}"))?;
    match known_hosts.check_port(host, port, host_key) {
        CheckResult::Match => {}
        CheckResult::Mismatch => {
            return Err("SSH Host Key 与 known_hosts 不一致，已拒绝连接".to_string())
        }
        CheckResult::NotFound => {
            return Err(
                "SSH Host Key 不在 known_hosts 中；请先用 ssh 命令连接一次服务器".to_string(),
            )
        }
        CheckResult::Failure => return Err("无法校验 SSH Host Key".to_string()),
    }

    let username = if payload.username.trim().is_empty() {
        endpoint.username()
    } else {
        payload.username.trim()
    };
    if username.is_empty() {
        return Err("请填写 SFTP 用户名".to_string());
    }
    if payload.key_path.trim().is_empty() {
        session
            .userauth_password(username, &payload.secret)
            .map_err(|error| format!("SFTP 登录失败：{error}"))?;
    } else {
        session
            .userauth_pubkey_file(
                username,
                None,
                Path::new(payload.key_path.trim()),
                if payload.secret.is_empty() {
                    None
                } else {
                    Some(payload.secret.as_str())
                },
            )
            .map_err(|error| format!("SFTP 私钥登录失败：{error}"))?;
    }
    if !session.authenticated() {
        return Err("SFTP 身份验证失败".to_string());
    }
    let sftp = session.sftp().map_err(|error| error.to_string())?;
    let endpoint_path = endpoint.path();
    let mut components = endpoint_path
        .split('/')
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    components.extend(
        key.split('/')
            .filter(|part| !part.is_empty())
            .map(str::to_string),
    );
    let file_name = components
        .pop()
        .ok_or_else(|| "SFTP 远端文件名为空".to_string())?;
    let mut directory = if endpoint_path.trim_matches('/').is_empty() {
        PathBuf::new()
    } else {
        PathBuf::from("/")
    };
    for component in &components {
        directory.push(component);
        if sftp.stat(&directory).is_err() {
            sftp.mkdir(&directory, 0o755)
                .map_err(|error| format!("SFTP 建目录失败 {}：{error}", directory.display()))?;
        }
    }
    let target = directory.join(&file_name);
    let mut remote = sftp
        .create(&target)
        .map_err(|error| format!("SFTP 创建文件失败：{error}"))?;
    remote
        .write_all(&payload.data)
        .map_err(|error| format!("SFTP 上传中断：{error}"))?;
    remote.flush().map_err(|error| error.to_string())?;
    let fallback = format!(
        "sftp://{host}:{port}/{}",
        encoded_object_key(&target.to_string_lossy())
    );
    Ok(joined_public_url(&payload.public_base_url, key, &fallback))
}

fn upload_image_sync(payload: NativeUploadPayload) -> Result<UploadResult, String> {
    if payload.data.is_empty() {
        return Err("图片内容为空".to_string());
    }
    if payload.data.len() > 512 * 1024 * 1024 {
        return Err("单张图片不能超过 512 MB".to_string());
    }
    let key = remote_object_key(&payload)?;
    let url = match payload.provider.as_str() {
        "webdav" => upload_webdav(&payload, &key)?,
        "s3" => upload_s3_compatible(&payload, &key, "S3", false)?,
        "r2" => upload_s3_compatible(&payload, &key, "R2", true)?,
        "oss" => upload_oss(&payload, &key)?,
        "ftp" => upload_ftp(&payload, &key)?,
        "sftp" => upload_sftp(&payload, &key)?,
        _ => return Err("不支持的上传服务".to_string()),
    };
    Ok(UploadResult {
        url,
        remote_path: key,
    })
}

#[tauri::command]
async fn upload_image(payload: NativeUploadPayload) -> Result<UploadResult, String> {
    tauri::async_runtime::spawn_blocking(move || upload_image_sync(payload))
        .await
        .map_err(|error| error.to_string())?
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
        let requested_inputs = if settings.input_folders.is_empty() {
            (!settings.input_folder.is_empty())
                .then(|| vec![settings.input_folder.clone()])
                .unwrap_or_default()
        } else {
            settings.input_folders.clone()
        };
        if requested_inputs.is_empty() {
            return Err("请选择来源文件夹".to_string());
        }
        let inputs = requested_inputs
            .iter()
            .map(|input| fs::canonicalize(input).map_err(|_| format!("监测文件夹不存在：{input}")))
            .collect::<Result<Vec<_>, _>>()?;
        let fixed_output = (!settings.output_folder.is_empty()
            && settings.output_folder != "@same-folder")
            .then(|| PathBuf::from(&settings.output_folder));

        if let Some(previous) = state
            .watcher
            .lock()
            .map_err(|_| "监测状态不可用".to_string())?
            .take()
        {
            drop(previous);
        }
        let app_handle = app.clone();
        let watcher_settings = settings.clone();
        let processing = state.processing.clone();
        let inputs_for_callback = inputs.clone();
        let output_for_callback = fixed_output.clone();
        let mut watcher = notify::recommended_watcher(
            move |result: notify::Result<notify::Event>| match result {
                Ok(event) if matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) => {
                    for path in event.paths {
                        let source_root = inputs_for_callback
                            .iter()
                            .filter(|input| path.starts_with(input))
                            .max_by_key(|input| input.components().count())
                            .cloned();
                        let Some(source_root) = source_root else {
                            continue;
                        };
                        let default_output = source_root.join("PicLite");
                        let already_optimised = path
                            .file_stem()
                            .and_then(|value| value.to_str())
                            .is_some_and(|value| value.contains("-piclite"));
                        if !is_image(&path)
                            || already_optimised
                            || path.starts_with(
                                output_for_callback.as_ref().unwrap_or(&default_output),
                            )
                        {
                            continue;
                        }
                        let app = app_handle.clone();
                        let mut settings = watcher_settings.clone();
                        settings.input_folder = source_root.to_string_lossy().to_string();
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
        for input in &inputs {
            watcher
                .watch(input, RecursiveMode::Recursive)
                .map_err(|error| format!("无法监测 {}：{error}", input.display()))?;
        }
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
                Some(format!("正在监测 {} 个文件夹", inputs.len())),
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

fn create_tray(app: &tauri::App) -> tauri::Result<()> {
    let preferences = MenuItem::with_id(app, "preferences", "设置…", true, None::<&str>)?;
    let batch = MenuItem::with_id(app, "show", "完整工作台", true, None::<&str>)?;
    let launch = MenuItem::with_id(app, "launch_at_login", "登录时启动", true, None::<&str>)?;

    let optimise = MenuItem::with_id(app, "optimise_clipboard", "优化", true, None::<&str>)?;
    let aggressive = MenuItem::with_id(
        app,
        "optimise_clipboard_aggressive",
        "激进优化",
        true,
        None::<&str>,
    )?;
    let downscale = MenuItem::with_id(app, "downscale_clipboard", "缩小尺寸", true, None::<&str>)?;
    let quicklook = MenuItem::with_id(app, "quicklook_clipboard", "快速预览", true, None::<&str>)?;
    let clipboard = Submenu::with_items(
        app,
        "剪贴板操作",
        true,
        &[&optimise, &aggressive, &downscale, &quicklook],
    )?;

    let open_workdir = MenuItem::with_id(app, "open_workdir", "打开工作目录", true, None::<&str>)?;
    let bring_back = MenuItem::with_id(
        app,
        "bring_back_result",
        "恢复上一个结果",
        true,
        None::<&str>,
    )?;
    let backups = Submenu::with_items(app, "备份", true, &[&open_workdir, &bring_back])?;

    let pause = MenuItem::with_id(app, "pause_automatic", "暂停自动优化", true, None::<&str>)?;
    let check_updates = MenuItem::with_id(app, "check_updates", "检查更新", true, None::<&str>)?;
    let about = MenuItem::with_id(app, "about", "关于 PicLite", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "完全退出 PicLite", true, None::<&str>)?;
    let separator_one = PredefinedMenuItem::separator(app)?;
    let separator_two = PredefinedMenuItem::separator(app)?;
    let separator_three = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[
            &preferences,
            &batch,
            &launch,
            &separator_one,
            &clipboard,
            &backups,
            &separator_two,
            &pause,
            &about,
            &check_updates,
            &separator_three,
            &quit,
        ],
    )?;

    TrayIconBuilder::with_id("piclite-tray")
        .tooltip("PicLite · Drop to optimise")
        .icon(app.default_window_icon().expect("missing app icon").clone())
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_window(app, "main"),
            "preferences" => show_window(app, "preferences"),
            "quit" => {
                app.state::<DesktopState>()
                    .quitting
                    .store(true, Ordering::Relaxed);
                app.exit(0);
            }
            action => {
                if matches!(
                    action,
                    "optimise_clipboard" | "optimise_clipboard_aggressive" | "downscale_clipboard"
                ) {
                    show_window(app, "dropzone");
                }
                let _ = app.emit("tray:action", action.to_string());
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_window(tray.app_handle(), "main");
            }
        })
        .build(app)?;
    Ok(())
}

fn apply_tray_icon_theme(_app: &AppHandle, _dark: bool) {
    // PicLite 使用统一的原始应用图标，不随主题切换替换托盘图标。
}

#[tauri::command]
async fn set_tray_theme(app: AppHandle, theme: String) -> Result<(), String> {
    let dark = if theme == "dark" {
        true
    } else if theme == "light" {
        false
    } else {
        app.get_webview_window("main")
            .and_then(|window| window.theme().ok())
            .map(|theme| theme == Theme::Dark)
            .unwrap_or(false)
    };
    apply_tray_icon_theme(&app, dark);
    Ok(())
}

fn version_parts(version: &str) -> Vec<u64> {
    version
        .trim()
        .trim_start_matches(['v', 'V'])
        .split('.')
        .map(|part| {
            part.chars()
                .take_while(|character| character.is_ascii_digit())
                .collect::<String>()
                .parse::<u64>()
                .unwrap_or(0)
        })
        .collect()
}

fn version_is_newer(latest: &str, current: &str) -> bool {
    let latest = version_parts(latest);
    let current = version_parts(current);
    let count = latest.len().max(current.len());
    (0..count)
        .map(|index| {
            (
                *latest.get(index).unwrap_or(&0),
                *current.get(index).unwrap_or(&0),
            )
        })
        .find(|(left, right)| left != right)
        .is_some_and(|(left, right)| left > right)
}

#[tauri::command]
async fn check_for_updates() -> Result<UpdateInfo, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let current_version = env!("CARGO_PKG_VERSION").to_string();
        let release = Client::builder()
            .timeout(Duration::from_secs(10))
            .user_agent(format!("PicLite/{current_version}"))
            .build()
            .map_err(|error| format!("无法创建更新检查请求：{error}"))?
            .get("https://api.github.com/repos/amiaoapp/PicLite/releases/latest")
            .send()
            .and_then(|response| response.error_for_status())
            .map_err(|error| format!("连接 GitHub 检查更新失败：{error}"))?
            .text()
            .map_err(|error| format!("读取 GitHub 版本信息失败：{error}"))?;
        let release = serde_json::from_str::<GithubRelease>(&release)
            .map_err(|error| format!("解析 GitHub 版本信息失败：{error}"))?;
        let latest_version = release.tag_name.trim_start_matches(['v', 'V']).to_string();
        Ok(UpdateInfo {
            available: version_is_newer(&latest_version, &current_version),
            current_version,
            latest_version,
            release_url: release.html_url,
            published_at: release.published_at,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

fn open_url(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let status = Command::new("open").arg(url).status();

    #[cfg(target_os = "windows")]
    let status = {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        Command::new("rundll32.exe")
            .args(["url.dll,FileProtocolHandler", url])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
    };

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let status = Command::new("xdg-open").arg(url).status();

    status
        .map_err(|error| format!("无法打开浏览器：{error}"))?
        .success()
        .then_some(())
        .ok_or_else(|| "系统没有成功打开浏览器".to_string())
}

#[tauri::command]
async fn open_external_url(url: String) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|_| "链接格式无效".to_string())?;
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("github.com")
        || !parsed.path().starts_with("/amiaoapp/PicLite")
    {
        return Err("只允许打开 PicLite 的 GitHub 页面".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || open_url(&url))
        .await
        .map_err(|error| error.to_string())?
}

fn start_clipboard_monitor(app: AppHandle) {
    thread::spawn(move || {
        let mut was_enabled = false;
        let mut last_fingerprint: Option<String> = None;
        loop {
            let (enabled, quitting, ignore_until_ms) = {
                let state = app.state::<DesktopState>();
                (
                    state.clipboard_monitor_enabled.load(Ordering::Relaxed),
                    state.quitting.load(Ordering::Relaxed),
                    state.clipboard_ignore_until_ms.load(Ordering::Relaxed),
                )
            };
            if quitting {
                return;
            }
            if !enabled {
                was_enabled = false;
                last_fingerprint = None;
                thread::sleep(Duration::from_millis(800));
                continue;
            }

            match clipboard_image() {
                Ok(Some(image)) => {
                    let fingerprint = format!("{:x}", Sha256::digest(image.data.as_bytes()));
                    let ignored = ignore_until_ms > now_ms().min(u64::MAX as u128) as u64;
                    if !was_enabled {
                        last_fingerprint = Some(fingerprint);
                        was_enabled = true;
                    } else if last_fingerprint.as_deref() != Some(fingerprint.as_str()) {
                        last_fingerprint = Some(fingerprint);
                        if !ignored {
                            let _ = app.emit("clipboard:image", image);
                        }
                    }
                }
                Ok(None) => match clipboard_image_paths() {
                    Ok(paths) if !paths.is_empty() => {
                        let fingerprint = format!("paths:{}", paths.join("\u{1f}"));
                        let ignored = ignore_until_ms > now_ms().min(u64::MAX as u128) as u64;
                        if !was_enabled {
                            last_fingerprint = Some(fingerprint);
                            was_enabled = true;
                        } else if last_fingerprint.as_deref() != Some(fingerprint.as_str()) {
                            last_fingerprint = Some(fingerprint);
                            if !ignored {
                                let _ = app.emit("clipboard:paths", paths);
                            }
                        }
                    }
                    Ok(_) => {
                        was_enabled = true;
                        last_fingerprint = None;
                    }
                    Err(_) => {}
                },
                Err(_) => {}
            }
            thread::sleep(Duration::from_millis(800));
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(DesktopState::default())
        .setup(|app| {
            match create_tray(app) {
                Ok(()) => app
                    .state::<DesktopState>()
                    .tray_available
                    .store(true, Ordering::Relaxed),
                Err(error) => eprintln!("PicLite system tray unavailable: {error}"),
            }
            #[cfg(target_os = "macos")]
            app.handle()
                .set_activation_policy(tauri::ActivationPolicy::Accessory)?;

            start_clipboard_monitor(app.handle().clone());
            if std::env::args().any(|argument| argument == "--minimized") {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            let state = window.state::<DesktopState>();
            match event {
                WindowEvent::CloseRequested { api, .. }
                    if state.tray_available.load(Ordering::Relaxed)
                        && !state.quitting.load(Ordering::Relaxed) =>
                {
                    api.prevent_close();
                    let _ = window.hide();
                }
                WindowEvent::Resized(_)
                    if state.tray_available.load(Ordering::Relaxed)
                        && state.minimize_to_tray.load(Ordering::Relaxed) =>
                {
                    if window.is_minimized().unwrap_or(false) {
                        let _ = window.hide();
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            select_folder,
            suggest_screenshot_folder,
            select_images,
            read_images_from_paths,
            read_clipboard_image,
            read_clipboard_paths,
            copy_image_data,
            copy_compressed_data,
            cache_image_data,
            copy_image_path,
            list_system_fonts,
            read_system_font,
            load_app_profile,
            save_app_profile,
            load_imported_fonts,
            save_imported_font,
            reveal_path,
            upload_image,
            load_upload_profile,
            save_upload_profile,
            export_images,
            quick_compress_paths,
            compress_animation_data,
            configure_global_shortcuts,
            cleanup_optimised_files,
            update_desktop_preferences,
            set_tray_theme,
            check_for_updates,
            open_external_url,
            show_main_window,
            show_gallery_window,
            submit_corner_drop,
            take_pending_corner_drop,
            show_preferences_window,
            show_dropzone_window,
            configure_dropzone_window,
            resize_dropzone_window,
            hide_current_window,
            quit_application,
            start_watcher,
            stop_watcher,
            get_watcher_state,
        ])
        .build(tauri::generate_context!())
        .expect("error while building PicLite");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            let state = app_handle.state::<DesktopState>();
            if state.tray_available.load(Ordering::Relaxed)
                && !state.quitting.load(Ordering::Relaxed)
            {
                api.prevent_exit();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rename_template_expands_size_dimensions_and_extension() {
        let name = render_output_name(
            "{name}_{width}x{height}_{size}{suffix}.{ext}",
            "photo",
            "-piclite",
            "webp",
            12_345,
            1920,
            1080,
        );
        assert_eq!(name, "photo_1920x1080_12345-piclite.webp");
    }

    #[test]
    fn automatic_first_pass_keeps_dimensions_and_selects_a_smaller_format() {
        let mut pixels = image::RgbImage::new(640, 360);
        for (x, y, pixel) in pixels.enumerate_pixels_mut() {
            let noise = ((x * 17 + y * 31 + (x * y) % 251) % 256) as u8;
            *pixel = image::Rgb([
                noise,
                noise.wrapping_add((x % 93) as u8),
                noise.wrapping_add((y % 71) as u8),
            ]);
        }
        let original =
            encode_static(DynamicImage::ImageRgb8(pixels), "png", 100).expect("encode source png");
        let path = std::env::temp_dir().join(format!(
            "piclite-auto-first-pass-{}-{}.png",
            std::process::id(),
            now_ms()
        ));
        fs::write(&path, &original).expect("write source png");
        let settings = WatcherSettings {
            input_folder: String::new(),
            input_folders: Vec::new(),
            output_folder: String::new(),
            output_suffix: String::new(),
            rename_template: String::new(),
            mode: "balanced".to_string(),
            quality: 86,
            scale: 100.0,
            format: "keep".to_string(),
            resize: false,
            max_width: u32::MAX,
            max_height: u32::MAX,
            strip_metadata: true,
            prevent_larger: true,
        };

        let optimized = optimize_image(&path, &settings).expect("automatic optimisation");
        let dimensions = image::load_from_memory(&optimized.bytes)
            .expect("decode automatic result")
            .dimensions();
        let _ = fs::remove_file(&path);

        assert_eq!(dimensions, (640, 360));
        assert!(optimized.bytes.len() < original.len());
        assert!(matches!(
            optimized.extension.as_str(),
            "jpg" | "webp" | "png"
        ));
    }

    #[test]
    fn automatic_first_pass_rejects_cosmetic_savings() {
        assert!(!has_meaningful_savings(10_000, 9_950));
        assert!(!has_meaningful_savings(100_000, 98_100));
        assert!(has_meaningful_savings(100_000, 97_900));
    }

    #[test]
    fn webp_quality_controls_lossy_output_size() {
        let mut pixels = image::RgbaImage::new(320, 180);
        for (x, y, pixel) in pixels.enumerate_pixels_mut() {
            let noise = ((x * 17 + y * 31 + (x * y) % 251) % 256) as u8;
            *pixel = image::Rgba([
                noise,
                noise.wrapping_add((x % 93) as u8),
                noise.wrapping_add((y % 71) as u8),
                255,
            ]);
        }
        let image = DynamicImage::ImageRgba8(pixels);
        let small = encode_static(image.clone(), "webp", 35).expect("encode small webp");
        let detailed = encode_static(image, "webp", 88).expect("encode detailed webp");

        assert_eq!(&small[8..12], b"WEBP");
        assert_eq!(&detailed[8..12], b"WEBP");
        assert!(
            small.len() < detailed.len(),
            "low quality WebP should be smaller: {} vs {}",
            small.len(),
            detailed.len()
        );
    }

    #[test]
    fn animated_gif_converts_to_animated_webp_with_timing() {
        let width = 48;
        let height = 32;
        let mut gif = Vec::new();
        {
            let mut encoder = GifEncoder::new(&mut gif);
            encoder.set_repeat(Repeat::Infinite).expect("set GIF loop");
            for (index, color) in [[255, 32, 32, 255], [32, 255, 32, 180], [32, 32, 255, 255]]
                .into_iter()
                .enumerate()
            {
                let buffer = image::RgbaImage::from_pixel(width, height, image::Rgba(color));
                encoder
                    .encode_frame(Frame::from_parts(
                        buffer,
                        0,
                        0,
                        image::Delay::from_numer_denom_ms(80 + index as u32 * 40, 1),
                    ))
                    .expect("encode GIF frame");
            }
        }

        let webp = encode_animated_webp(&gif, width, height, 72).expect("encode animated WebP");
        let decoded = webp::AnimDecoder::new(&webp)
            .decode()
            .expect("decode animated WebP");

        assert_eq!(&webp[8..12], b"WEBP");
        assert!(decoded.has_animation());
        assert!(decoded.len() >= 3);
        let timestamps = decoded
            .into_iter()
            .map(|frame| frame.get_time_ms())
            .collect::<Vec<_>>();
        assert!(timestamps.windows(2).all(|pair| pair[0] < pair[1]));
    }

    #[test]
    fn png_conversion_preserves_decoded_pixels_at_every_quality() {
        let mut pixels = image::RgbaImage::new(48, 32);
        for (x, y, pixel) in pixels.enumerate_pixels_mut() {
            *pixel = image::Rgba([
                ((x * 11 + y * 3) % 256) as u8,
                ((x * 5 + y * 17) % 256) as u8,
                ((x * 19 + y * 7) % 256) as u8,
                if (x + y) % 5 == 0 { 128 } else { 255 },
            ]);
        }

        let webp = encode_static(DynamicImage::ImageRgba8(pixels), "webp", 92)
            .expect("encode webp source");
        let decoded_webp = image::load_from_memory(&webp).expect("decode webp source");
        let expected = decoded_webp.to_rgba8();

        for quality in [1, 25, 80, 100] {
            let png =
                encode_static(decoded_webp.clone(), "png", quality).expect("encode png result");
            let actual = image::load_from_memory(&png)
                .expect("decode png result")
                .to_rgba8();
            assert_eq!(
                actual.as_raw(),
                expected.as_raw(),
                "PNG quality {quality} must not quantize or recolor pixels"
            );
        }
    }

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
            input_folders: Vec::new(),
            output_folder: String::new(),
            output_suffix: String::new(),
            rename_template: String::new(),
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

    #[test]
    fn selected_collection_font_face_stays_parseable() {
        let mut files = Vec::new();
        for directory in system_font_directories() {
            collect_font_files(&directory, 0, &mut files);
        }
        for path in files {
            let Ok(data) = fs::read(path) else { continue };
            let Some(face_count) = ttf_parser::fonts_in_collection(&data) else {
                continue;
            };
            if face_count < 2 {
                continue;
            }
            let selected = face_count - 1;
            let extracted = extract_font_face(&data, selected).expect("extract collection face");
            ttf_parser::Face::parse(&extracted, 0).expect("parse extracted collection face");
            return;
        }
    }

    #[test]
    fn upload_key_removes_parent_segments_and_unsafe_file_characters() {
        let payload = NativeUploadPayload {
            provider: "webdav".to_string(),
            endpoint: "https://dav.example.com".to_string(),
            bucket: String::new(),
            region: "auto".to_string(),
            access_key: String::new(),
            username: String::new(),
            port: 0,
            remote_path: "../piclite/./2026".to_string(),
            public_base_url: String::new(),
            key_path: String::new(),
            path_style: true,
            secret: String::new(),
            file_name: "hello:world.png".to_string(),
            mime_type: "image/png".to_string(),
            data: vec![1],
        };
        assert_eq!(
            remote_object_key(&payload).expect("upload key"),
            "piclite/2026/hello-world.png"
        );
    }

    #[test]
    fn public_url_encodes_unicode_without_losing_path_segments() {
        assert_eq!(
            joined_public_url("https://img.example.com/", "piclite/图 轻.png", "unused"),
            "https://img.example.com/piclite/%E5%9B%BE%20%E8%BD%BB.png"
        );
    }

    #[test]
    fn update_versions_compare_numerically() {
        assert!(version_is_newer("v0.11.0", "0.10.9"));
        assert!(version_is_newer("1.0.0", "0.99.99"));
        assert!(!version_is_newer("v0.10.0", "0.10.0"));
        assert!(!version_is_newer("0.9.9", "0.10.0"));
    }
}
