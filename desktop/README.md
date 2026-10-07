# OCGW desktop

Windows wrapper for your Open Connector deployment. The website and scheduled flows
continue to run on the server. Internet access is required.

## Run and package

Use Node 24 or newer from the repository root:

```powershell
cd desktop
npm ci
$env:OCGW_GATEWAY_URL = "https://connector.example.com/"
npm start
npm test
npm run build
```

Replace the example URL with your deployment's HTTPS URL. The installed app also
reads `OCGW_GATEWAY_URL`; set it as a Windows user environment variable before
launching from a shortcut. Without it, the app uses the example domain. The build
does not embed this environment variable or your login session.

The installer is `desktop/dist/OCGW-Setup-0.1.0-x64.exe`. It installs per user,
offers a destination folder, and creates Start menu and desktop shortcuts.
The package is independent of the server's npm workspace and Docker build.

## Behaviour

- Sign in once using the website's existing login. The app keeps its own persistent
  browser session under `%APPDATA%/OCGW`, separate from your normal browser.
- Closing or minimizing hides the window to the tray. Double-click the tray icon
  to reopen it. Choose **Quit OCGW** to exit completely.
- Window size, position, and maximization are restored. If a monitor is disconnected,
  the app falls back to its default position.
- External web and email links open using your default browser/mail application.
  Provider sign-in pages open in the browser; return to OCGW after connecting.
- Voice input asks before enabling the microphone. Other device permissions are denied.
- Website updates appear on reload. Desktop runtime updates require a new installer.

Remote content runs sandboxed with Node integration disabled and no preload bridge.
Only the exact OCGW HTTPS origin may navigate within the app. Certificates retain
normal validation. No API keys or login credentials are bundled.

The locally built installer is unsigned. Windows may display a publisher/SmartScreen
prompt until release signing is configured.

`npm run smoke --prefix desktop` opens the live login page in a hidden window,
uses an isolated temporary profile, checks renderer isolation and close-to-tray,
and saves a screenshot to the OS temporary directory. It does not sign in.
