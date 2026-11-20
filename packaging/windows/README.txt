WhatsOps {{VERSION}} for Windows
================================

Install: double-click WhatsOps.vbs.
  - WhatsOps is installed for your user in %LOCALAPPDATA%\mcp-mrg-whatsops
  - it runs in the background and starts again at every Windows sign-in
  - it appears in the Start menu as "WhatsOps"
  - your browser opens http://127.0.0.1:8810 already signed in

The first time, Windows may warn that the file comes from the internet:
choose "Open" / "Run". The files are not signed with a paid certificate.

Updates install by themselves (Settings -> Updates in WhatsOps).

Uninstall:
  1. create an empty file named "stop" in %LOCALAPPDATA%\mcp-mrg-whatsops\runtime
     and end "node.exe" (WhatsOps) in Task Manager
  2. delete the "WhatsOps" value in HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run
     and the WhatsOps entry in the Start menu
  3. delete %LOCALAPPDATA%\mcp-mrg-whatsops (this also deletes your WhatsApp sessions and messages)

https://github.com/emrgim/WhatsOps
