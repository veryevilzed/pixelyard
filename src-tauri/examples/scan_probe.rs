//! Проверка: поиск сканеров (делегат) и открытие сессии с чтением возможностей — без сканирования.
#[cfg(target_os = "macos")]
fn main() {
    use std::cell::RefCell;
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2::{define_class, msg_send, AllocAnyThread, Message};
    use objc2_foundation::{NSDate, NSError, NSObject, NSObjectProtocol, NSRunLoop};
    use objc2_image_capture_core::*;

    thread_local! { static DEV: RefCell<Option<Retained<ICDevice>>> = const { RefCell::new(None) }; }
    define_class!(
        #[unsafe(super = NSObject)]
        #[name = "ProbeDelegate"]
        struct Probe;
        unsafe impl NSObjectProtocol for Probe {}
        unsafe impl ICDeviceBrowserDelegate for Probe {
            #[unsafe(method(deviceBrowser:didAddDevice:moreComing:))]
            fn add(&self, _b: &ICDeviceBrowser, d: &ICDevice, _m: bool) {
                if unsafe { d.r#type() }.0 & ICDeviceTypeMask::Scanner.0 != 0 {
                    println!("найден сканер: {}", unsafe { d.name() }.map(|s| s.to_string()).unwrap_or_default());
                    DEV.with(|x| *x.borrow_mut() = Some(d.retain()));
                }
            }
            #[unsafe(method(deviceBrowser:didRemoveDevice:moreGoing:))]
            fn remove(&self, _b: &ICDeviceBrowser, _d: &ICDevice, _m: bool) {}
        }
        unsafe impl ICDeviceDelegate for Probe {
            #[unsafe(method(device:didCloseSessionWithError:))]
            fn closed(&self, _d: &ICDevice, _e: Option<&NSError>) { println!("сессия закрыта"); }
            #[unsafe(method(didRemoveDevice:))]
            fn removed(&self, _d: &ICDevice) {}
            #[unsafe(method(device:didOpenSessionWithError:))]
            fn opened(&self, _d: &ICDevice, e: Option<&NSError>) {
                println!("сессия открыта: {}", e.map(|e| e.localizedDescription().to_string()).unwrap_or_else(|| "ок".into()));
            }
        }
        unsafe impl ICScannerDeviceDelegate for Probe {}
    );
    let probe: Retained<Probe> = unsafe { msg_send![super(Probe::alloc().set_ivars(())), init] };
    let run = |s: f64| unsafe { NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(s)) };
    unsafe {
        let b = ICDeviceBrowser::new();
        b.setDelegate(Some(ProtocolObject::from_ref(&*probe)));
        b.setBrowsedDeviceTypeMask(ICDeviceTypeMask(ICDeviceTypeMask::Scanner.0 | ICDeviceLocationTypeMask::Local.0 | ICDeviceLocationTypeMask::Remote.0));
        b.start();
        run(5.0);
        let Some(dev) = DEV.with(|x| x.borrow().clone()) else { return println!("сканер не найден") };
        let sc = dev.downcast::<ICScannerDevice>().expect("не сканер");
        sc.setDelegate(Some(ProtocolObject::from_ref(&*probe)));
        sc.requestOpenSession();
        for _ in 0..30 {
            run(0.5);
            if sc.hasOpenSession() { break; }
        }
        if !sc.hasOpenSession() { return println!("сессия не открылась за 15 с"); }
        run(2.0);
        let types: Vec<usize> = sc.availableFunctionalUnitTypes().iter().map(|n| n.unsignedIntegerValue()).collect();
        let u = sc.selectedFunctionalUnit();
        u.setMeasurementUnit(ICScannerMeasurementUnit::Inches);
        let set = u.supportedResolutions();
        let mut res = vec![];
        let mut i = set.firstIndex();
        while i != usize::MAX >> 1 && res.len() < 50 { res.push(i); i = set.indexGreaterThanIndex(i); }
        let sz = u.physicalSize();
        println!("блоки: {types:?}, текущий: {}, DPI: {res:?}, стекло: {:.2} × {:.2} дюйма", u.r#type().0, sz.width, sz.height);
        sc.requestCloseSession();
        run(1.5);
    }
}
#[cfg(not(target_os = "macos"))]
fn main() {}
