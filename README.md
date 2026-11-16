# Trade Journal

A private trading journal for logging small XAUUSD trades from an iPhone. It is a static site: there is no account and no server. Trades and chart photos stay on the phone.

Live URL, once GitHub Pages is enabled:

https://iraholcomb11-netizen.github.io/trade-journal/

## Enable GitHub Pages

1. Open this repository on GitHub.
2. Go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
4. Set **Branch** to **main** and the folder to **/ (root)**.
5. Save. When the deploy finishes, the journal is at the URL above.

Pages serves the files as they are. There is no build step.

## Add to the iPhone home screen

1. Open the URL in **Safari**. On iPhone, Add to Home Screen is not available from Chrome.
2. Tap the **Share** button.
3. Tap **Add to Home Screen**, then **Add**.
4. Open **Trade Journal** from the home screen. It launches full screen, without Safari’s toolbar. After the first visit it also opens offline.

## Backups

Everything is stored in this phone’s browser storage (IndexedDB). iOS can wipe website data when storage is low, and nothing is copied to another device on its own. Use **Export** to save a JSON file that includes chart photos, and **Import** on the new phone to restore it. Import replaces the journal on that device.

Two sample gold trades are added only the first time the journal is empty. Deleting them does not bring them back.
