use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::Manager;

struct ServerProcesses(Mutex<Vec<Child>>);

/// Resolve the resources directory.
/// In a bundled .app: Contents/Resources/resources/
/// In dev: falls back to monorepo lookup via CAT_CAFE_ROOT.
fn find_resources_dir() -> Option<std::path::PathBuf> {
    // 1. Bundled .app: resources next to the binary's parent
    //    .app/Contents/MacOS/cat-cafe-desktop
    //    .app/Contents/Resources/resources/
    if let Ok(exe) = std::env::current_exe() {
        if let Some(macos_dir) = exe.parent() {
            let resources = macos_dir
                .parent() // Contents
                .map(|p| p.join("Resources").join("resources"));
            if let Some(ref r) = resources {
                if r.join("node").exists() && r.join("api").exists() {
                    return resources;
                }
            }
        }
    }

    // 2. Dev fallback: use staging directory relative to monorepo
    if let Ok(root) = std::env::var("CAT_CAFE_ROOT") {
        let staging =
            std::path::PathBuf::from(root).join("packages/desktop/staging");
        if staging.join("node").exists() {
            return Some(staging);
        }
    }

    // 3. Walk up from exe to find monorepo staging
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent().map(|p| p.to_path_buf());
        for _ in 0..10 {
            if let Some(ref d) = dir {
                let staging = d.join("packages/desktop/staging");
                if staging.join("node").exists() {
                    return Some(staging);
                }
                dir = d.parent().map(|p| p.to_path_buf());
            } else {
                break;
            }
        }
    }

    None
}

fn spawn_server(
    resources: &std::path::Path,
    script: &str,
    label: &str,
) -> Option<Child> {
    let launcher = resources.join(script);
    if !launcher.exists() {
        eprintln!("[desktop] {} not found: {}", label, launcher.display());
        return None;
    }

    // Ensure the launcher is executable
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&launcher) {
            let mut perms = meta.permissions();
            perms.set_mode(0o755);
            let _ = std::fs::set_permissions(&launcher, perms);
        }
    }

    // Also ensure node binary is executable
    let node_bin = resources.join("node/node");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&node_bin) {
            let mut perms = meta.permissions();
            perms.set_mode(0o755);
            let _ = std::fs::set_permissions(&node_bin, perms);
        }
    }

    match Command::new("/bin/bash")
        .arg(&launcher)
        .env("MEMORY_STORE", "1")
        .env("API_SERVER_PORT", "13004")
        .env("FRONTEND_PORT", "13003")
        .env("CAT_CAFE_DESKTOP", "1")
        .env("API_SERVER_HOST", "::")
        .env_remove("REDIS_URL")
        .spawn()
    {
        Ok(child) => {
            println!("[desktop] {} started (pid {})", label, child.id());
            Some(child)
        }
        Err(e) => {
            eprintln!("[desktop] Failed to start {}: {}", label, e);
            None
        }
    }
}

/// Wait for a TCP port to accept connections (Rust-side, no CORS issues).
fn wait_for_port(port: u16, max_secs: u64) -> bool {
    use std::net::TcpStream;
    use std::time::{Duration, Instant};
    let start = Instant::now();
    let timeout = Duration::from_secs(max_secs);
    while start.elapsed() < timeout {
        if TcpStream::connect(format!("127.0.0.1:{}", port)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    false
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            if let Some(resources) = find_resources_dir() {
                println!(
                    "[desktop] Resources: {}",
                    resources.display()
                );

                // First-run: install agent CLIs (background, non-blocking)
                let setup_script = resources.join("first-run-setup.sh");
                if setup_script.exists() {
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        if let Ok(meta) = std::fs::metadata(&setup_script) {
                            let mut perms = meta.permissions();
                            perms.set_mode(0o755);
                            let _ = std::fs::set_permissions(
                                &setup_script,
                                perms,
                            );
                        }
                    }
                    match Command::new("/bin/bash")
                        .arg(&setup_script)
                        .env(
                            "PATH",
                            format!(
                                "{}:/usr/local/bin:/usr/bin:/bin",
                                resources.join("node").display()
                            ),
                        )
                        .spawn()
                    {
                        Ok(_) => println!(
                            "[desktop] First-run setup started"
                        ),
                        Err(e) => eprintln!(
                            "[desktop] Setup failed to start: {}",
                            e
                        ),
                    }
                }

                // Ensure runtime directories exist
                let _ = std::fs::create_dir_all(resources.join("uploads"));
                let _ = std::fs::create_dir_all(
                    resources.join("data/connector-media"),
                );

                let mut children = Vec::new();

                // Start API server first
                if let Some(child) =
                    spawn_server(&resources, "launch-api.sh", "API")
                {
                    children.push(child);
                }

                // Start web server
                if let Some(child) =
                    spawn_server(&resources, "launch-web.sh", "Web")
                {
                    children.push(child);
                }

                app.manage(ServerProcesses(Mutex::new(children)));

                // Wait for servers and navigate WebView (in background thread
                // to avoid blocking the UI event loop)
                let window = app
                    .get_webview_window("main")
                    .expect("main window");
                std::thread::spawn(move || {
                    let web_ok = wait_for_port(13003, 30);
                    let api_ok = wait_for_port(13004, 30);
                    if web_ok && api_ok {
                        println!("[desktop] Both servers ready, navigating...");
                        let _ = window.navigate(
                            "http://localhost:13003"
                                .parse()
                                .unwrap(),
                        );
                    } else {
                        eprintln!(
                            "[desktop] Servers not ready: web={} api={}",
                            web_ok, api_ok
                        );
                    }
                });
            } else {
                eprintln!(
                    "[desktop] Resources not found. \
                     Set CAT_CAFE_ROOT or run the distributable build."
                );
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Cat Café Desktop")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<ServerProcesses>() {
                    let mut children = state.0.lock().unwrap();
                    for child in children.iter_mut() {
                        println!(
                            "[desktop] Stopping pid {}...",
                            child.id()
                        );
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                    children.clear();
                }
            }
        });
}
