mod commands;
mod device_unlock;
mod migration;
mod otp;
mod sync;
mod vault;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    commands::run();
}
