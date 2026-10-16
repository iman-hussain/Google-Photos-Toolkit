/// <reference types="chrome" />
// Runs in the extension's isolated world. The toolkit itself has to run in
// the page's main world to read WIZ_global_data, so relay toolbar clicks.

chrome.runtime.onMessage.addListener((message: unknown) => {
  if ((message as { gptkSwipe?: string } | null)?.gptkSwipe === 'open') {
    window.postMessage({ gptkSwipe: 'open' }, window.location.origin);
  }
});
