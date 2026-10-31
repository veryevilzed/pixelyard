//! Сканеры и МФУ через ImageCaptureCore (тот же фреймворк, что у «Захвата изображений»).
//!
//! Все вызовы ImageCaptureCore — в главном потоке (там же приходят обратные вызовы делегата).
//! Интерфейс опрашивает состояние командой `scanner_status`; готовые файлы сканов забирает оттуда же.
//! Сканируется всё стекло в выбранном DPI — нужную область вырезает интерфейс (так рамка
//! гарантированно совпадает с превью при любой системе координат драйвера).

use std::cell::RefCell;
use std::path::PathBuf;
use std::sync::{mpsc, Mutex};

use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{define_class, msg_send, AllocAnyThread};
use objc2_foundation::{NSError, NSObject, NSObjectProtocol, NSString, NSURL};
use objc2_image_capture_core::{
    ICDevice, ICDeviceBrowser, ICDeviceDelegate, ICDeviceLocationTypeMask, ICDeviceTypeMask, ICScannerBitDepth, ICScannerDevice,
    ICScannerDeviceDelegate, ICScannerFunctionalUnit, ICScannerFunctionalUnitType, ICScannerMeasurementUnit, ICScannerPixelDataType,
    ICScannerTransferMode,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

#[derive(Serialize, Clone, Default)]
pub struct DeviceInfo {
    id: String,
    name: String,
    remote: bool,
}

#[derive(Serialize, Clone, Default)]
pub struct ScanStatus {
    devices: Vec<DeviceInfo>,
    /// Открытый сканер.
    selected: Option<String>,
    session: bool,
    /// Доступные блоки: 0 — планшет, 1/2 — слайды/негативы, 3 — автоподатчик.
    units: Vec<usize>,
    unit: Option<usize>,
    resolutions: Vec<usize>,
    /// Размер стекла (области сканирования) в дюймах.
    width: f64,
    height: f64,
    /// Что происходит: opening / selecting / scanning / null.
    busy: Option<String>,
    progress: f64,
    error: Option<String>,
    /// Готовые файлы (забираются один раз) и флаг «это превью».
    files: Vec<String>,
    preview: bool,
}

#[derive(Deserialize, Clone)]
pub struct ScanRequest {
    unit: usize,
    dpi: usize,
    /// color / gray / bw
    mode: String,
    preview: bool,
}

/// Общее состояние (читается из любого потока).
static STATE: Mutex<Option<ScanStatus>> = Mutex::new(None);

fn with_state<R>(f: impl FnOnce(&mut ScanStatus) -> R) -> R {
    let mut g = STATE.lock().unwrap();
    f(g.get_or_insert_with(ScanStatus::default))
}

/// Объекты ImageCaptureCore — только в главном потоке.
struct Objs {
    browser: Retained<ICDeviceBrowser>,
    delegate: Retained<ScanDelegate>,
    scanner: Option<Retained<ICScannerDevice>>,
    /// Скан, ожидающий выбора блока (планшет / податчик).
    pending: Option<ScanRequest>,
}

thread_local! {
    static OBJS: RefCell<Option<Objs>> = const { RefCell::new(None) };
}

fn err_text(e: &NSError) -> String {
    e.localizedDescription().to_string()
}

define_class!(
    // SAFETY: NSObject без требований к подклассам, Drop не реализован.
    #[unsafe(super = NSObject)]
    #[name = "PixelYardScanDelegate"]
    struct ScanDelegate;

    unsafe impl NSObjectProtocol for ScanDelegate {}

    unsafe impl ICDeviceDelegate for ScanDelegate {
        #[unsafe(method(device:didCloseSessionWithError:))]
        fn did_close(&self, _device: &ICDevice, _error: Option<&NSError>) {
            with_state(|s| {
                s.session = false;
                s.busy = None;
            });
        }

        #[unsafe(method(didRemoveDevice:))]
        fn did_remove(&self, _device: &ICDevice) {
            with_state(|s| {
                s.session = false;
                s.busy = None;
                s.error = Some("Сканер отключился".into());
            });
        }

        #[unsafe(method(device:didOpenSessionWithError:))]
        fn did_open(&self, _device: &ICDevice, error: Option<&NSError>) {
            with_state(|s| {
                s.busy = None;
                match error {
                    Some(e) => s.error = Some(format!("Не удалось подключиться к сканеру: {}", err_text(e))),
                    None => s.session = true,
                }
            });
        }
    }

    unsafe impl ICScannerDeviceDelegate for ScanDelegate {
        #[unsafe(method(scannerDevice:didSelectFunctionalUnit:error:))]
        fn did_select(&self, scanner: &ICScannerDevice, _unit: &ICScannerFunctionalUnit, error: Option<&NSError>) {
            if let Some(e) = error {
                with_state(|s| {
                    s.busy = None;
                    s.error = Some(format!("Сканер не переключился на нужный блок: {}", err_text(e)));
                });
                OBJS.with(|o| o.borrow_mut().as_mut().map(|o| o.pending = None));
                return;
            }
            // блок выбран — запускаем отложенный скан
            let pending = OBJS.with(|o| o.borrow_mut().as_mut().and_then(|o| o.pending.take()));
            if let Some(req) = pending {
                start_scan(scanner, &req);
            }
        }

        #[unsafe(method(scannerDevice:didScanToURL:))]
        fn did_scan(&self, _scanner: &ICScannerDevice, url: &NSURL) {
            if let Some(path) = url.path() {
                with_state(|s| s.files.push(path.to_string()));
            }
        }

        #[unsafe(method(scannerDevice:didCompleteScanWithError:))]
        fn did_complete(&self, _scanner: &ICScannerDevice, error: Option<&NSError>) {
            with_state(|s| {
                s.busy = None;
                s.progress = 0.0;
                if let Some(e) = error {
                    s.error = Some(format!("Сканирование не удалось: {}", err_text(e)));
                }
            });
        }
    }
);

impl ScanDelegate {
    fn new() -> Retained<Self> {
        let this = Self::alloc().set_ivars(());
        unsafe { msg_send![super(this), init] }
    }
}

fn scan_dir() -> PathBuf {
    let d = std::env::temp_dir().join("pixelyard-scan");
    let _ = std::fs::create_dir_all(&d);
    d
}

/// Ближайшее поддерживаемое разрешение.
fn nearest_dpi(unit: &ICScannerFunctionalUnit, want: usize) -> usize {
    let list = resolutions(unit);
    list.iter().copied().min_by_key(|r| (*r as i64 - want as i64).abs()).unwrap_or(want)
}

fn resolutions(unit: &ICScannerFunctionalUnit) -> Vec<usize> {
    let set = unsafe { unit.supportedResolutions() };
    let mut out = Vec::new();
    let mut i = set.firstIndex();
    // NSNotFound = NSIntegerMax
    while i != usize::MAX >> 1 && out.len() < 4096 {
        out.push(i);
        i = set.indexGreaterThanIndex(i);
    }
    out
}

/// Настроить выбранный блок и запустить сканирование (всё стекло, в файл PNG/TIFF).
fn start_scan(scanner: &ICScannerDevice, req: &ScanRequest) {
    unsafe {
        let unit = scanner.selectedFunctionalUnit();
        unit.setMeasurementUnit(ICScannerMeasurementUnit::Inches);
        unit.setResolution(nearest_dpi(&unit, req.dpi));
        let (pix, depth) = match req.mode.as_str() {
            "gray" => (ICScannerPixelDataType::Gray, ICScannerBitDepth::Depth8Bits),
            "bw" => (ICScannerPixelDataType::BW, ICScannerBitDepth::Depth1Bit),
            _ => (ICScannerPixelDataType::RGB, ICScannerBitDepth::Depth8Bits),
        };
        unit.setPixelDataType(pix);
        unit.setBitDepth(depth);
        let size = unit.physicalSize();
        unit.setScanArea(objc2_foundation::NSRect::new(objc2_foundation::NSPoint::new(0.0, 0.0), size));
        scanner.setTransferMode(ICScannerTransferMode::FileBased);
        let dir = NSURL::fileURLWithPath(&NSString::from_str(&scan_dir().to_string_lossy()));
        scanner.setDownloadsDirectory(&dir);
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
        scanner.setDocumentName(&NSString::from_str(&format!("scan-{stamp}")));
        scanner.setDocumentUTI(&NSString::from_str("public.png"));
        with_state(|s| {
            s.busy = Some("scanning".into());
            s.preview = req.preview;
            s.progress = 0.0;
            s.error = None;
        });
        scanner.requestScan();
    }
}

/// Обновить снимок состояния из объектов (главный поток).
fn refresh(o: &Objs) {
    let devices: Vec<DeviceInfo> = unsafe { o.browser.devices() }
        .map(|list| {
            list.iter()
                .filter(|d| unsafe { d.r#type() }.0 & ICDeviceTypeMask::Scanner.0 != 0)
                .map(|d| unsafe {
                    DeviceInfo {
                        id: d.persistentIDString().map(|s| s.to_string()).or_else(|| d.UUIDString().map(|s| s.to_string())).unwrap_or_default(),
                        name: d.name().map(|s| s.to_string()).unwrap_or_else(|| "Сканер".into()),
                        remote: d.isRemote(),
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    let mut caps = None;
    if let Some(sc) = &o.scanner {
        unsafe {
            if sc.hasOpenSession() {
                let unit = sc.selectedFunctionalUnit();
                unit.setMeasurementUnit(ICScannerMeasurementUnit::Inches);
                let types: Vec<usize> = sc.availableFunctionalUnitTypes().iter().map(|n| n.unsignedIntegerValue()).collect();
                let size = unit.physicalSize();
                caps = Some((types, unit.r#type().0, resolutions(&unit), size.width, size.height, unit.scanInProgress(), unit.scanProgressPercentDone()));
            }
        }
    }
    with_state(|s| {
        s.devices = devices;
        if let Some((types, cur, res, w, h, scanning, pct)) = caps {
            s.session = true;
            s.units = types;
            s.unit = Some(cur);
            s.resolutions = res;
            s.width = w;
            s.height = h;
            if scanning {
                s.progress = pct;
            }
        }
    });
}

/// Выполнить на главном потоке и дождаться результата.
fn on_main<R: Send + 'static, T: Runtime>(app: &AppHandle<T>, f: impl FnOnce() -> R + Send + 'static) -> Result<R, String> {
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn scanner_start<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    on_main(&app, || {
        OBJS.with(|cell| {
            let mut slot = cell.borrow_mut();
            if slot.is_some() {
                return;
            }
            unsafe {
                let browser = ICDeviceBrowser::new();
                browser.setBrowsedDeviceTypeMask(ICDeviceTypeMask(ICDeviceTypeMask::Scanner.0 | ICDeviceLocationTypeMask::Local.0 | ICDeviceLocationTypeMask::Remote.0));
                browser.start();
                *slot = Some(Objs { browser, delegate: ScanDelegate::new(), scanner: None, pending: None });
            }
        });
        with_state(|s| s.error = None);
    })
}

#[tauri::command]
pub async fn scanner_status<R: Runtime>(app: AppHandle<R>) -> Result<ScanStatus, String> {
    on_main(&app, || {
        OBJS.with(|cell| {
            if let Some(o) = cell.borrow().as_ref() {
                refresh(o);
            }
        });
        // файлы отдаются один раз
        with_state(|s| {
            let out = s.clone();
            s.files.clear();
            s.error = None;
            out
        })
    })
}

#[tauri::command]
pub async fn scanner_open<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    on_main(&app, move || {
        OBJS.with(|cell| {
            let mut slot = cell.borrow_mut();
            let Some(o) = slot.as_mut() else { return Err("Поиск сканеров не запущен".to_string()) };
            unsafe {
                if let Some(old) = o.scanner.take() {
                    if old.hasOpenSession() {
                        old.requestCloseSession();
                    }
                }
                let found = o.browser.devices().and_then(|list| {
                    list.iter().find(|d| {
                        d.persistentIDString().map(|s| s.to_string()).or_else(|| d.UUIDString().map(|s| s.to_string())).as_deref() == Some(id.as_str())
                    })
                });
                let Some(dev) = found else { return Err("Сканер не найден — возможно, он выключен".to_string()) };
                let Ok(scanner) = dev.downcast::<ICScannerDevice>() else { return Err("Это устройство не сканер".to_string()) };
                scanner.setDelegate(Some(ProtocolObject::from_ref(&*o.delegate)));
                with_state(|s| {
                    s.selected = Some(id.clone());
                    s.session = false;
                    s.busy = Some("opening".into());
                    s.error = None;
                });
                scanner.requestOpenSession();
                o.scanner = Some(scanner);
            }
            Ok(())
        })
    })?
}

#[tauri::command]
pub async fn scanner_scan<R: Runtime>(app: AppHandle<R>, req: ScanRequest) -> Result<(), String> {
    on_main(&app, move || {
        OBJS.with(|cell| {
            let mut slot = cell.borrow_mut();
            let Some(o) = slot.as_mut() else { return Err("Поиск сканеров не запущен".to_string()) };
            let Some(sc) = o.scanner.clone() else { return Err("Выберите сканер".to_string()) };
            unsafe {
                if !sc.hasOpenSession() {
                    return Err("Сканер ещё не подключён".to_string());
                }
                let cur = sc.selectedFunctionalUnit().r#type().0;
                if cur != req.unit {
                    // сначала переключить блок, скан — после подтверждения (did_select)
                    o.pending = Some(req.clone());
                    with_state(|s| s.busy = Some("selecting".into()));
                    sc.requestSelectFunctionalUnit(ICScannerFunctionalUnitType(req.unit));
                } else {
                    start_scan(&sc, &req);
                }
            }
            Ok(())
        })
    })?
}

#[tauri::command]
pub async fn scanner_cancel<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    on_main(&app, || {
        OBJS.with(|cell| {
            if let Some(sc) = cell.borrow().as_ref().and_then(|o| o.scanner.clone()) {
                unsafe { sc.cancelScan() };
            }
        });
        with_state(|s| s.busy = None);
    })
}

/// Закрыть сессию и остановить поиск (диалог закрыт).
#[tauri::command]
pub async fn scanner_close<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    on_main(&app, || {
        OBJS.with(|cell| {
            if let Some(o) = cell.borrow_mut().take() {
                unsafe {
                    if let Some(sc) = &o.scanner {
                        if sc.hasOpenSession() {
                            sc.requestCloseSession();
                        }
                    }
                    o.browser.stop();
                }
            }
        });
        *STATE.lock().unwrap() = None;
    })
}
