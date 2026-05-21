// Prevents an additional console window from popping up on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    zvec_studio_desktop_lib::run()
}
