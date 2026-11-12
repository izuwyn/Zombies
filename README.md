# K7: Lockdown: releases

Downloads for **K7: Lockdown** (called "Zombies concept" up to v0.24), a round-based, first-person zombie
survival game with online co-op. Game source lives in a separate repository.

## Download
Get the **launcher** for your system from [`releases/`](releases/), unzip it and run it. Its big
**DOWNLOAD** button installs the game next to it. After that the same button says **UPDATE** when there's a
new version, and **PLAY** otherwise.

- **Linux:** `K7Launcher_linux.zip`, then run `./K7Launcher.x86_64`
  (if your unzip tool drops the executable bit: `chmod +x K7Launcher.x86_64`).
- **Windows:** `K7Launcher_windows.zip`, then run `K7Launcher.exe`.

Already have an older version? Its **Check for Updates** button installs the launcher for you.

The game itself is in `releases/v<version>/` in parts under 100 MB (GitHub's file size limit). The launcher
downloads and joins them, using [`latest.json`](latest.json). Older versions (up to v0.24) are single zips in `releases/`.

Windows may warn that the app is unrecognised (it isn't code-signed): choose **More info > Run anyway**.
